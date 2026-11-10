import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { SerializedHttpRequest, SerializedHttpResponseChunk } from '@antseed/node';
import {
  WORKER_ASSIGN_PATH,
  WORKER_UNAVAILABLE_STATUS as WORKER_UNAVAILABLE,
  deviceAttestationChallenge,
  generateWorkerEncryptionKey,
  sealRequest,
  verifyWorkerAttestation,
  verifyWorkerKeyCertificate,
  workerAttestationMessage,
  workerKeyCertificateMessage,
  workerKeyHex,
  type AttestedModel,
  type WorkerKeyCertificate,
} from '@antseed/node/worker-e2e';
import { createTestAppleCa } from '@antseed/node/worker-e2e/testing';
import type { DeviceAttestor } from './mdm.js';
import { WorkerLedger } from './ledger.js';
import { ColonyPool } from './pool.js';
import { parsePoolFrame, workerAuthMessage } from './protocol.js';
import { ColonyPoolProvider } from './provider.js';
import { PoolWorker, queryWorkerStats, type ChannelVerifier, type WorkerAttester } from './worker.js';

/** A software stand-in for the Mac app's Secure Enclave attester. */
const appleCa = createTestAppleCa();

/** The operator's MDM, answering with test-CA attestations of whichever Mac is asked for. */
function fakeMdm(report: { sip?: boolean; serialNumber?: string } = {}): DeviceAttestor & { asked: string[] } {
  return {
    asked: [],
    async attest(udid, nonce) {
      this.asked.push(udid);
      return appleCa.issue({ serialNumber: report.serialNumber ?? 'C02TEST0MD6T', udid, nonce, sip: report.sip ?? true });
    },
  };
}

/** An MDM whose answers the test releases one by one, in any order. */
function deferredMdm(): DeviceAttestor & { lookups: Array<{ udid: string; nonce: string; resolve: (serial: string) => void; reject: (err: Error) => void }> } {
  const lookups: Array<{ udid: string; nonce: string; resolve: (serial: string) => void; reject: (err: Error) => void }> = [];
  return {
    lookups,
    attest(udid, nonce) {
      return new Promise<string[]>((resolve, reject) => {
        lookups.push({ udid, nonce, resolve: (serial) => resolve(appleCa.issue({ serialNumber: serial, udid, nonce })), reject });
      });
    },
  };
}

const DAY_MS = 24 * 3600_000;
const TEST_UDID = '00000000-0000-1000-8000-0123456789AB';

/**
 * Apple's behaviour behind the operator's MDM: a new attestation of a device
 * at most every 7 days, and until then the cached one, whatever nonce is sent.
 * The first one was issued `issuedAgoMs` ago; `reissue: false` never issues another.
 */
function cachingMdm(issuedAgoMs: number, opts: { reissue?: boolean } = {}): DeviceAttestor & { asked: number; issued: number } {
  const cache = new Map<string, { chain: string[]; at: number }>();
  return {
    asked: 0,
    issued: 0,
    async attest(udid, nonce) {
      this.asked++;
      const hit = cache.get(udid);
      if (hit && (opts.reissue === false || Date.now() - hit.at < 7 * DAY_MS)) return hit.chain;
      const at = hit ? Date.now() : Date.now() - issuedAgoMs;
      const chain = appleCa.issue({ serialNumber: 'C02TEST0MD6T', udid, nonce, notBefore: new Date(at) });
      cache.set(udid, { chain, at });
      this.issued++;
      return chain;
    },
  };
}

function fakeAttester(report: { sip?: boolean; teamId?: string | null; device?: { serial: string; udid: string }; staleAfter?: number; models?: () => Record<string, AttestedModel> } = {}): WorkerAttester & { calls: number } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    calls: 0,
    publicKey: `04${Buffer.from(jwk.x!, 'base64url').toString('hex')}${Buffer.from(jwk.y!, 'base64url').toString('hex')}`,
    async attest(nonce, worker, key) {
      this.calls++;
      const statement = {
        v: 1 as const, teamId: report.teamId === undefined ? 'H3M5BXXQR2' : report.teamId, signingId: 'com.antseed.macworker',
        cdhash: 'ab'.repeat(20), sip: report.sip ?? true, hardenedRuntime: true, debuggerDenied: true, keyAppBound: true,
        os: 'macOS 26.2', serial: report.device?.serial ?? 'C02TEST0MD6T', udid: report.device?.udid ?? '00000000-0000-1000-8000-0123456789AB',
        ...(report.models ? { models: report.models() } : {}),
        // From call `staleAfter` on, an hour old: as from a Mac whose clock is off.
        issued: Math.floor(Date.now() / 1000) - (report.staleAfter !== undefined && this.calls > report.staleAfter ? 3600 : 0), nonce,
      };
      const signature = sign('sha256', Buffer.from(workerAttestationMessage(worker, key, statement)), { key: privateKey, dsaEncoding: 'der' });
      return { ...statement, signature: signature.toString('base64') };
    },
  };
}

const SERVICE = 'qwen3-30b-a3b';
const LOCAL_MODEL = 'mlx-community/Qwen3-30B-A3B-4bit';
const SELLER = '0x00000000000000000000000000000000000000aa';
const CHANNEL = `0x${'cd'.repeat(32)}`;
const PROMPT = 'my private prompt';
const ANSWER = 'my private answer';
/** What the fake upstream answers a non-streamed request with; a test may make it large. */
let jsonAnswer = ANSWER;
/** What it answers the pool's join check with. */
let checkAnswer = 'Ready.';
/** Stream a tool call instead of text. */
let toolDelta = false;
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface FakeUpstream {
  url: string;
  server: Server;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
}

/** A stand-in for mlx_lm.server: JSON completions, or SSE when stream=true. */
async function startUpstream(): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push({ path: req.url ?? '', body });
      const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
      if (body['stream'] === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (toolDelta) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lyon"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER.slice(0, 5) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER.slice(5) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      const check = JSON.stringify(body['messages']).includes('Reply with the single word: ready');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: check ? checkAnswer : jsonAnswer } }], usage }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, server, requests };
}

function plainRequest(requestId: string, stream: boolean, model = SERVICE): SerializedHttpRequest {
  return {
    requestId,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: enc({ model, stream, messages: [{ role: 'user', content: PROMPT }] }),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('colony pool', () => {
  let dir: string;
  let ledger: WorkerLedger;
  let pool: ColonyPool;
  let provider: ColonyPoolProvider;
  let upstream: FakeUpstream;
  let poolUrl: string;
  const workers: PoolWorker[] = [];
  const buyer = Wallet.createRandom();

  const logs: string[] = [];

  async function setup(opts: { verifyOnJoin?: boolean; allowedWorkers?: Set<string>; attestedTeams?: Set<string>; attestationIntervalMs?: number; deviceAttestor?: DeviceAttestor; requireDeviceAttestation?: boolean; deviceAttestationIntervalMs?: number; models?: Map<string, string> } = {}): Promise<void> {
    pool = new ColonyPool({
      poolId: 'test-pool',
      seller: SELLER,
      catalog: [SERVICE, 'other-model'],
      prices: { [SERVICE]: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 }, 'other-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 4 } },
      workerShareBps: 9000,
      ledger,
      port: 0,
      host: '127.0.0.1',
      verifyOnJoin: opts.verifyOnJoin ?? true,
      ...(opts.allowedWorkers ? { allowedWorkers: opts.allowedWorkers } : {}),
      ...(opts.attestedTeams ? { attestedTeams: opts.attestedTeams } : {}),
      ...(opts.models ? { models: opts.models } : {}),
      log: (line) => logs.push(line),
      ...(opts.attestationIntervalMs ? { attestationIntervalMs: opts.attestationIntervalMs } : {}),
      ...(opts.deviceAttestor ? { deviceAttestor: opts.deviceAttestor, deviceAttestationRoots: [appleCa.rootPem] } : {}),
      ...(opts.requireDeviceAttestation ? { requireDeviceAttestation: true } : {}),
      ...(opts.deviceAttestationIntervalMs ? { deviceAttestationIntervalMs: opts.deviceAttestationIntervalMs } : {}),
    });
    provider = new ColonyPoolProvider({
      pool,
      ledger,
      pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 } },
      workerShareBps: 9000,
      maxConcurrency: 64,
    });
    const port = await pool.start();
    poolUrl = `ws://127.0.0.1:${port}`;
  }

  function startWorker(opts: { key?: string; channelVerifier?: ChannelVerifier; channelWaitMs?: number; attester?: WorkerAttester; models?: Record<string, string> } = {}): PoolWorker {
    const worker = new PoolWorker({
      poolUrl,
      baseUrl: upstream.url,
      services: { [SERVICE]: LOCAL_MODEL },
      privateKey: opts.key ?? Wallet.createRandom().privateKey,
      encryptionKey: generateWorkerEncryptionKey(),
      maxConcurrency: 2,
      // Workers refuse buyer requests they can't verify; these tests don't run a chain.
      channelVerifier: opts.channelVerifier ?? (async () => true),
      ...(opts.channelWaitMs !== undefined ? { channelWaitMs: opts.channelWaitMs } : {}),
      ...(opts.attester ? { attester: opts.attester } : {}),
      ...(opts.models ? { models: opts.models } : {}),
    });
    workers.push(worker);
    worker.start();
    return worker;
  }

  async function assign(): Promise<WorkerKeyCertificate> {
    const response = await provider.handleControlRequest({
      requestId: 'assign', method: 'POST', path: WORKER_ASSIGN_PATH, headers: {}, body: enc({ model: SERVICE }),
    });
    expect(response.statusCode).toBe(200);
    return (JSON.parse(dec(response.body)) as { workers: WorkerKeyCertificate[] }).workers[0]!;
  }

  /** What the buyer's node does: assign, check the certificate, seal with a channel binding. */
  async function buyerSeal(requestId: string, stream: boolean, signer = buyer) {
    const certificate = await assign();
    expect(verifyWorkerKeyCertificate(certificate, SELLER)).toBe(true);
    const sealed = await sealRequest({
      body: plainRequest(requestId, stream).body,
      worker: certificate.worker,
      workerKey: certificate.key,
      buyer: { address: signer.address, channel: CHANNEL, signMessage: (m) => signer.signMessage(m) },
    });
    return { certificate, sealed, request: { ...plainRequest(requestId, stream), body: sealed.body } };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'colony-pool-'));
    ledger = new WorkerLedger(join(dir, 'ledger.db'));
    upstream = await startUpstream();
  });

  afterEach(async () => {
    vi.useRealTimers();
    logs.length = 0;
    jsonAnswer = ANSWER;
    checkAnswer = 'Ready.';
    toolDelta = false;
    for (const worker of workers.splice(0)) worker.stop();
    await pool.stop();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertises end-to-end encryption and announces a service only after the sealed join check', async () => {
    await setup();
    expect(provider.peerCapabilities).toContain('colony-pool-e2e.v2');
    let changes = 0;
    provider.setServicesChangedListener(() => { changes++; });
    expect(provider.services).toEqual([]);

    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    expect(changes).toBe(1);
    // The check reached the worker's local model, capped as a check.
    expect(upstream.requests[0]).toMatchObject({ path: '/v1/chat/completions', body: { model: LOCAL_MODEL, max_tokens: 16 } });
  });

  it('does not route a service whose join check answers something other than "ready"', async () => {
    await setup();
    checkAnswer = 'I am a different model and say hello';
    startWorker();
    await waitFor(() => logs.some((line) => line.includes(`failed the check for ${SERVICE}`)));
    expect(provider.services).toEqual([]);
  });

  it('routes a pinned service only from workers reporting its model', async () => {
    const pinned = 'mlx-community/Qwen3-30B-A3B-4bit@0123456789abcdef';
    await setup({ verifyOnJoin: false, models: new Map([[SERVICE, pinned]]) });
    const unpinned = startWorker();
    const wrong = startWorker({ models: { [SERVICE]: 'mlx-community/Qwen3-30B-A3B-4bit@fedcba9876543210' } });
    await waitFor(() => pool.workerSummaries().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.services).toEqual([]);
    expect(logs.some((line) => line.includes(unpinned.address.toLowerCase()) && line.includes('an unnamed model'))).toBe(true);
    expect(logs.some((line) => line.includes(wrong.address.toLowerCase()) && line.includes(`not ${pinned}`))).toBe(true);
    const right = startWorker({ models: { [SERVICE]: pinned } });
    await waitFor(() => provider.services.includes(SERVICE));
    expect((await assign()).worker).toBe(right.address.toLowerCase());
  });

  it('routes a service pinned with a files digest only from workers attesting that checkpoint, and stops when one no longer does', async () => {
    const model = 'mlx-community/Qwen3-30B-A3B-4bit@0123456789abcdef';
    const digest = 'ab'.repeat(32);
    await setup({ verifyOnJoin: false, attestationIntervalMs: 50, models: new Map([[SERVICE, `${model}#${digest}`]]) });
    // Reports the model but attests nothing, then other files: neither is routed.
    startWorker({ models: { [SERVICE]: model } });
    startWorker({ models: { [SERVICE]: model }, attester: fakeAttester({ models: () => ({ [SERVICE]: { model, sha256: 'cd'.repeat(32) } }) }) });
    await waitFor(() => pool.workerSummaries().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.services).toEqual([]);
    expect(logs.some((line) => line.includes(`files sha256 ${'cd'.repeat(32)}`))).toBe(true);
    let files = digest;
    const right = startWorker({ models: { [SERVICE]: model }, attester: fakeAttester({ models: () => ({ [SERVICE]: { model, sha256: files } }) }) });
    await waitFor(() => provider.services.includes(SERVICE));
    expect((await assign()).worker).toBe(right.address.toLowerCase());
    // Its next attestation names other files: the pool stops routing the service to it.
    files = 'ef'.repeat(32);
    await waitFor(() => provider.services.length === 0);
  });

  it('passes tool calls through unchanged: tools, tool messages and streamed tool-call deltas', async () => {
    await setup();
    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
    const messages = [
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":21}' },
    ];
    const certificate = await assign();
    const body = enc({ model: SERVICE, stream: true, messages, tools, tool_choice: 'auto' });
    const sealed = await sealRequest({
      body, worker: certificate.worker, workerKey: certificate.key,
      buyer: { address: buyer.address, channel: CHANNEL, signMessage: (m) => buyer.signMessage(m) },
    });
    toolDelta = true;
    const response = await provider.handleRequest({ ...plainRequest('tools', true), body: sealed.body });
    expect(response.statusCode).toBe(200);
    expect(upstream.requests.at(-1)!.body).toMatchObject({ messages, tools, tool_choice: 'auto' });
    const plain = dec(sealed.opener.pushStream(response.body));
    expect(plain).toContain('"tool_calls":[{"index":0,"id":"call_2"');
    expect(sealed.opener.verified).toBe(true);
  });

  it('streams an encrypted request end to end; the pool never sees the prompt or the answer', async () => {
    await setup();
    const key = Wallet.createRandom().privateKey;
    const worker = startWorker({ key });
    await waitFor(() => provider.services.includes(SERVICE));
    const { certificate, sealed, request } = await buyerSeal('req-1', true);
    expect(certificate.worker.toLowerCase()).toBe(worker.address.toLowerCase());
    expect(dec(request.body)).not.toContain(PROMPT);

    const wire: SerializedHttpResponseChunk[] = [];
    let startHeaders: Record<string, string> = {};
    const streaming = provider.handleRequestStream(request, {
      onResponseStart: (start) => { startHeaders = start.headers; },
      onResponseChunk: (chunk) => { wire.push(chunk); },
    });
    // A stats query under the serving worker's own key leaves its connection, and the request on it, alone.
    await expect(queryWorkerStats(poolUrl, key)).resolves.toMatchObject({ requestsTotal: 0 });
    const response = await streaming;

    expect(response.statusCode).toBe(200);
    expect(startHeaders['x-antseed-streaming']).toBe('1');
    const seenByPool = dec(response.body);
    expect(seenByPool).not.toContain(ANSWER.slice(0, 5));
    // The seller can still meter from the clear usage line.
    expect(seenByPool).toContain('"usage":{"prompt_tokens":1000');
    // The worker's model got the decrypted prompt, with usage forced on.
    expect(JSON.stringify(upstream.requests.at(-1)!.body)).toContain(PROMPT);
    expect(upstream.requests.at(-1)!.body).toMatchObject({ model: LOCAL_MODEL, stream_options: { include_usage: true } });

    const plain = dec(sealed.opener.pushStream(response.body));
    expect(plain).toContain(ANSWER.slice(0, 5));
    expect(plain).toContain('[DONE]');
    expect(sealed.opener.verified).toBe(true);

    provider.onRequestCharged({
      requestId: 'req-1', request, service: SERVICE, costUsdc: 3000n,
      inputTokens: 1000, outputTokens: 500, freshInputTokens: 1000, cachedInputTokens: 0,
    });
    // 3000 − 2% protocol fee = 2940, then the worker's 90% = 2646.
    expect(ledger.stats(worker.address).earnedTotal).toBe('2646');
    await expect(queryWorkerStats(poolUrl, key)).resolves.toMatchObject({ earnedTotal: '2646', requestsTotal: 1 });
    const next = await buyerSeal('req-2', false);
    expect((await provider.handleRequest(next.request)).statusCode).toBe(200);
  });

  it('credits workers the share the pool contract pays now, once it changes', async () => {
    await setup();
    const worker = startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    provider.setWorkerShareBps(7500); // a 25% operator fee read from the contract
    const { request } = await buyerSeal('req-share', false);
    await provider.handleRequest(request);
    provider.onRequestCharged({
      requestId: 'req-share', request, service: SERVICE, costUsdc: 3000n,
      inputTokens: 1000, outputTokens: 500, freshInputTokens: 1000, cachedInputTokens: 0,
    });
    // 3000 − 2% protocol fee = 2940, then the worker's 75% = 2205.
    expect(ledger.stats(worker.address).earnedTotal).toBe('2205');
  });

  it('serves a non-streamed encrypted request', async () => {
    await setup();
    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    const { sealed, request } = await buyerSeal('req-2', false);
    const response = await provider.handleRequest(request);
    expect(response.statusCode).toBe(200);
    expect(dec(response.body)).not.toContain(ANSWER);
    expect(JSON.parse(dec(sealed.opener.openBody(response.body))).choices[0].message.content).toBe(ANSWER);
  });

  it('splits a large non-streamed answer across frames instead of dropping the worker', async () => {
    await setup();
    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    jsonAnswer = 'x'.repeat(10 * 1024 * 1024); // sealed and base64-encoded, past one 16 MiB frame
    try {
      const { sealed, request } = await buyerSeal('req-large', false);
      const response = await provider.handleRequest(request);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(dec(sealed.opener.openBody(response.body))).choices[0].message.content).toBe(jsonAnswer);
    } finally {
      jsonAnswer = ANSWER;
    }
    const { sealed, request } = await buyerSeal('req-after', false);
    const after = await provider.handleRequest(request);
    expect(JSON.parse(dec(sealed.opener.openBody(after.body))).choices[0].message.content).toBe(ANSWER);
  });

  it('refuses plaintext buyer requests', async () => {
    await setup();
    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    const response = await provider.handleRequest(plainRequest('plain-1', false));
    expect(response.statusCode).toBe(428);
    expect(JSON.parse(dec(response.body)).error.code).toBe('e2e_required');
  });

  it('seals the seller health probe itself and returns the plaintext result', async () => {
    await setup();
    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    const response = await provider.handleRequest({ ...plainRequest('health-abc', false), body: enc({ model: SERVICE, max_tokens: 1, messages: [] }) });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(dec(response.body)).choices[0].message.content).toBe(ANSWER);
  });

  it('answers 421 worker_unavailable when the assigned worker has left, and 503 when none can be assigned', async () => {
    await setup();
    const worker = startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    const { request } = await buyerSeal('req-3', false);
    worker.stop();
    await waitFor(() => provider.services.length === 0);
    const response = await provider.handleRequest(request);
    expect(response.statusCode).toBe(421);
    expect(JSON.parse(dec(response.body)).error.code).toBe('worker_unavailable');
    const assignResponse = await provider.handleControlRequest({
      requestId: 'a', method: 'POST', path: WORKER_ASSIGN_PATH, headers: {}, body: enc({ model: SERVICE }),
    });
    expect(assignResponse.statusCode).toBe(503);
  });

  it('caps unbound requests as checks', async () => {
    await setup({ verifyOnJoin: false });
    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    const certificate = await assign();
    const sealed = await sealRequest({
      body: enc({ model: SERVICE, max_tokens: 4000, messages: [{ role: 'user', content: 'write a novel' }] }),
      worker: certificate.worker,
      workerKey: certificate.key,
    });
    await provider.handleRequest({ ...plainRequest('unbound', false), body: sealed.body });
    expect(upstream.requests.at(-1)!.body['max_tokens']).toBe(16);
  });

  it('refuses a channel the chain shows belongs to someone else, from the first request on', async () => {
    await setup({ verifyOnJoin: false });
    let lookups = 0;
    startWorker({ channelVerifier: async () => { lookups++; return false; } });
    await waitFor(() => provider.services.includes(SERVICE));
    for (const id of ['c1', 'c2']) {
      const refused = await provider.handleRequest((await buyerSeal(id, false)).request);
      expect(refused.statusCode).toBe(WORKER_UNAVAILABLE);
      expect(dec(refused.body)).toContain('does not belong');
    }
    expect(lookups).toBe(1);
    expect(upstream.requests.filter((r) => r.body['max_tokens'] !== 16)).toHaveLength(0);
  });

  it('serves a verified channel only to its buyer, reading it for each of its requests', async () => {
    await setup({ verifyOnJoin: false });
    const lookups: string[] = [];
    startWorker({ channelVerifier: async (_channel, from) => { lookups.push(from); return from === buyer.address.toLowerCase(); } });
    await waitFor(() => provider.services.includes(SERVICE));
    expect((await provider.handleRequest((await buyerSeal('v1', false)).request)).statusCode).toBe(200);
    expect((await provider.handleRequest((await buyerSeal('v2', false)).request)).statusCode).toBe(200);
    // Another signer naming the same channel (the pool itself, say) is refused without a read.
    const refused = await provider.handleRequest((await buyerSeal('v3', false, Wallet.createRandom())).request);
    expect(refused.statusCode).toBe(WORKER_UNAVAILABLE);
    expect(dec(refused.body)).toContain('does not belong');
    expect(lookups).toEqual([buyer.address.toLowerCase(), buyer.address.toLowerCase()]);
  });

  it('does not let another signer\'s refused check refuse the channel\'s buyer', async () => {
    await setup({ verifyOnJoin: false });
    const lookups: string[] = [];
    startWorker({ channelVerifier: async (_channel, from) => { lookups.push(from); return from === buyer.address.toLowerCase(); } });
    await waitFor(() => provider.services.includes(SERVICE));
    const intruder = Wallet.createRandom();
    expect((await provider.handleRequest((await buyerSeal('i1', false, intruder)).request)).statusCode).toBe(WORKER_UNAVAILABLE);
    expect((await provider.handleRequest((await buyerSeal('i2', false, intruder)).request)).statusCode).toBe(WORKER_UNAVAILABLE);
    expect((await provider.handleRequest((await buyerSeal('i3', false)).request)).statusCode).toBe(200);
    expect(lookups).toEqual([intruder.address.toLowerCase(), buyer.address.toLowerCase()]);
  });

  it('never serves full requests on a channel that is not on-chain', async () => {
    await setup({ verifyOnJoin: false });
    let lookups = 0;
    startWorker({ channelVerifier: async () => { lookups++; return null; }, channelWaitMs: 50 });
    await waitFor(() => provider.services.includes(SERVICE));
    const before = upstream.requests.length;
    for (const id of ['p1', 'p2', 'p3']) {
      const refused = await provider.handleRequest((await buyerSeal(id, false)).request);
      expect(refused.statusCode).toBe(WORKER_UNAVAILABLE);
      expect(dec(refused.body)).toContain('not on-chain');
    }
    // Each request looked again (it may have appeared since), and none reached the model.
    expect(lookups).toBe(3);
    expect(upstream.requests.length).toBe(before);
  });

  it('waits for a fresh reserve to show on-chain, sharing one lookup between requests', async () => {
    await setup({ verifyOnJoin: false });
    let lookups = 0;
    startWorker({ channelVerifier: async () => (++lookups < 2 ? null : true), channelWaitMs: 3_000 });
    await waitFor(() => provider.services.includes(SERVICE));
    const [a, b] = await Promise.all([buyerSeal('f1', false), buyerSeal('f2', false)]);
    const responses = await Promise.all([provider.handleRequest(a.request), provider.handleRequest(b.request)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(lookups).toBe(2);
  });

  it('gives up on a lookup that hangs', async () => {
    await setup({ verifyOnJoin: false });
    startWorker({ channelVerifier: () => new Promise(() => {}), channelWaitMs: 100 });
    await waitFor(() => provider.services.includes(SERVICE));
    const refused = await provider.handleRequest((await buyerSeal('h1', false)).request);
    expect(dec(refused.body)).toContain('not on-chain');
  });

  it('does not reconnect once stopped during the reconnect backoff', async () => {
    await setup();
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    let connections = 0;
    server.on('connection', (socket) => { connections++; socket.terminate(); });
    const worker = new PoolWorker({
      poolUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
      baseUrl: 'http://127.0.0.1:1',
      services: { [SERVICE]: LOCAL_MODEL },
      privateKey: Wallet.createRandom().privateKey,
      encryptionKey: generateWorkerEncryptionKey(),
      log: () => {},
    });
    worker.start();
    await waitFor(() => connections === 1);
    // The pool dropped it; it is now waiting 1 s to reconnect.
    await new Promise((resolve) => setTimeout(resolve, 100));
    worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(connections).toBe(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('withdraws services while the owner pauses the worker', async () => {
    await setup();
    const worker = startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    worker.setPaused(true);
    await waitFor(() => provider.services.length === 0);
    worker.setPaused(false);
    await waitFor(() => provider.services.includes(SERVICE));
  });

  it('keeps a worker out of rotation when it fails the join check', async () => {
    await setup();
    upstream.server.removeAllListeners('request');
    upstream.server.on('request', (_req, res) => { res.writeHead(500).end('broken'); });
    startWorker();
    await waitFor(() => pool.workerSummaries().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(provider.services).toEqual([]);
  });

  it('rejects a hello whose signature does not match, or whose key is certified for another seller', async () => {
    await setup();
    const attempt = async (signer: Wallet, claimed: string, certSeller: string): Promise<number> => {
      const ws = new WebSocket(poolUrl);
      const key = workerKeyHex(generateWorkerEncryptionKey().publicKey);
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
      ws.on('message', async (data) => {
        const frame = parsePoolFrame(data.toString());
        if (frame?.t !== 'challenge') return;
        ws.send(JSON.stringify({
          t: 'hello',
          address: claimed,
          signature: await signer.signMessage(workerAuthMessage(frame.pool, frame.nonce)),
          services: [SERVICE],
          maxConcurrency: 1,
          encryption: { key, expires, certificate: await signer.signMessage(workerKeyCertificateMessage(certSeller, key, expires)) },
        }));
      });
      return closed;
    };
    const impostor = Wallet.createRandom();
    expect(await attempt(impostor, Wallet.createRandom().address, SELLER)).toBe(4003);
    expect(await attempt(impostor, impostor.address, Wallet.createRandom().address)).toBe(4003);
    expect(pool.workerSummaries()).toEqual([]);
  });

  it('only lets allow-listed workers join', async () => {
    const allowed = Wallet.createRandom();
    await setup({ verifyOnJoin: false, allowedWorkers: new Set([allowed.address.toLowerCase()]) });
    startWorker();
    startWorker({ key: allowed.privateKey });
    await waitFor(() => provider.services.includes(SERVICE));
    expect(pool.workerSummaries().map((w) => w.address)).toEqual([allowed.address.toLowerCase()]);
  });

  it('spreads assignments across workers', async () => {
    await setup({ verifyOnJoin: false });
    startWorker();
    startWorker();
    await waitFor(() => pool.workerSummaries().length === 2);
    const requests = await Promise.all([1, 2, 3, 4].map((n) => buyerSeal(`s${n}`, false)));
    const responses = await Promise.all(requests.map((r) => provider.handleRequest(r.request)));
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(pool.capacity()).toEqual({ current: 0, max: 4 });
  });

  it('labels a worker reporting a hardened Mac without gating on it, and hands buyers the attestation', async () => {
    // A software key can sign any report, an allowed team included: the label is shown, never enforced.
    await setup({ verifyOnJoin: false, attestedTeams: new Set(['H3M5BXXQR2']) });
    const plain = startWorker();
    const sipOff = startWorker({ attester: fakeAttester({ sip: false }) });
    const forged = startWorker({ attester: fakeAttester() });
    const otherTeam = startWorker({ attester: fakeAttester({ teamId: 'OTHERTEAM1' }) });
    await waitFor(() => pool.workerSummaries().length === 4);
    const attested = new Map(pool.workerSummaries().map((w) => [w.address, w.attested]));
    expect(attested).toEqual(new Map([
      [plain.address.toLowerCase(), false],
      [sipOff.address.toLowerCase(), false],
      [forged.address.toLowerCase(), true],
      [otherTeam.address.toLowerCase(), false],
    ]));
    // All four are routed: the label doesn't decide who gets buyers.
    expect(pool.workerSummaries().every((w) => w.services.includes(SERVICE))).toBe(true);
    for (const worker of [plain, sipOff, otherTeam]) worker.stop();
    await waitFor(() => pool.workerSummaries().length === 1);
    const assignment = await assign() as WorkerKeyCertificate & { attestation?: Parameters<typeof verifyWorkerAttestation>[0] };
    expect(verifyWorkerAttestation(assignment.attestation!, assignment, { maxAgeS: 60 })).toEqual({ valid: true, hardened: true });
  });

  it('keeps serving a worker whose re-attestation fails, without its label, and warns when half the attested workers drop at once', async () => {
    await setup({ verifyOnJoin: false, attestationIntervalMs: 50 });
    const a = fakeAttester({ staleAfter: 1 });
    const b = fakeAttester({ staleAfter: 1 });
    startWorker({ attester: a });
    startWorker({ attester: b });
    await waitFor(() => pool.workerSummaries().filter((w) => w.attested).length === 2);
    await waitFor(() => a.calls >= 2 && b.calls >= 2);
    await waitFor(() => pool.workerSummaries().every((w) => !w.attested));
    // Still connected and routed.
    expect(pool.workerSummaries()).toHaveLength(2);
    expect(provider.services).toContain(SERVICE);
    expect(logs.some((line) => /attested workers fell from 2 to (0|1)/.test(line))).toBe(true);
    expect(logs.filter((line) => line.includes('keeps serving without its attestation label')).length).toBeGreaterThanOrEqual(2);
  });

  it('disconnects a worker whose re-attestation fails when Apple\'s attestation is required', async () => {
    const mdm = cachingMdm(DAY_MS);
    await setup({ verifyOnJoin: false, attestationIntervalMs: 50, deviceAttestor: mdm, requireDeviceAttestation: true });
    const attester = fakeAttester({ staleAfter: 1 });
    startWorker({ attester });
    await waitFor(() => pool.workerSummaries()[0]?.appleVerified === true);
    await waitFor(() => logs.some((line) => line.includes('failed re-attestation') && line.includes('disconnecting it')));
  });

  it('re-attests on a timer and admits unattested workers when not required', async () => {
    await setup({ verifyOnJoin: false, attestationIntervalMs: 50 });
    const attester = fakeAttester();
    startWorker({ attester });
    startWorker();
    await waitFor(() => pool.workerSummaries().length === 2);
    await waitFor(() => attester.calls >= 3);
    expect(pool.workerSummaries().map((w) => w.attested).sort()).toEqual([false, true]);
  });

  it('routes only to Macs Apple attests through the operator\'s MDM when required, and hands buyers that attestation', async () => {
    const mdm = fakeMdm();
    await setup({ verifyOnJoin: false, deviceAttestor: mdm, requireDeviceAttestation: true });
    const apple = startWorker({ attester: fakeAttester() });
    startWorker(); // reports no Mac: disconnected
    await waitFor(() => provider.services.includes(SERVICE));
    await waitFor(() => pool.workerSummaries().length === 1);
    expect(pool.workerSummaries()[0]).toMatchObject({ address: apple.address.toLowerCase(), appleVerified: true });
    expect(mdm.asked).toEqual(['00000000-0000-1000-8000-0123456789AB']);

    const assignment = await assign() as WorkerKeyCertificate & { deviceAttestation?: { chain: string[]; challenge: string } };
    expect(assignment.deviceAttestation?.chain).toHaveLength(2);
  });

  it('keeps a Mac Apple reports with SIP off out of rotation when required', async () => {
    await setup({ verifyOnJoin: false, deviceAttestor: fakeMdm({ sip: false }), requireDeviceAttestation: true });
    startWorker({ attester: fakeAttester() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.services).toEqual([]);
    expect(pool.workerSummaries()).toEqual([]);
  });

  it('stops assigning a worker whose certificate is about to expire, and reconnects it to renew', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    await setup({ verifyOnJoin: false });
    startWorker();
    await waitFor(() => provider.services.includes(SERVICE));
    const first = await assign();

    // An hour before expiry the pool closes the connection; the worker reconnects with a fresh certificate.
    await vi.advanceTimersByTimeAsync((first.expires - Math.floor(Date.now() / 1000) - 3600) * 1000 + 1000);
    let renewed = first;
    for (let i = 0; i < 100 && renewed.expires === first.expires; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await provider.handleControlRequest({
        requestId: 'renew', method: 'POST', path: WORKER_ASSIGN_PATH, headers: {}, body: enc({ model: SERVICE }),
      });
      if (response.statusCode === 200) renewed = (JSON.parse(dec(response.body)) as { workers: WorkerKeyCertificate[] }).workers[0]!;
    }
    expect(renewed.worker).toBe(first.worker);
    expect(renewed.expires).toBeGreaterThan(first.expires);

    // A certificate buyers would stop using within 5 minutes is never handed out.
    vi.setSystemTime((renewed.expires - 200) * 1000);
    const response = await provider.handleControlRequest({
      requestId: 'late', method: 'POST', path: WORKER_ASSIGN_PATH, headers: {}, body: enc({ model: SERVICE }),
    });
    expect(response.statusCode).toBe(503);
  });

  it('keeps Apple\'s attestation while the worker re-attests, asking daily once Apple could issue a new one', async () => {
    // Apple issued this one 7 days and an hour ago and keeps returning it.
    const mdm = cachingMdm(7 * DAY_MS + 3600_000, { reissue: false });
    await setup({ verifyOnJoin: false, attestationIntervalMs: 30, deviceAttestor: mdm, deviceAttestationIntervalMs: 150 });
    const attester = fakeAttester();
    startWorker({ attester });
    await waitFor(() => mdm.asked === 1);
    await waitFor(() => attester.calls >= 4 && mdm.asked >= 3);
    expect(mdm.issued).toBe(1);
    expect(pool.workerSummaries()[0]).toMatchObject({ attested: true, appleVerified: true });
  });

  it('accepts Apple\'s cached attestation across reconnects and asks again only once it is 7 days old', async () => {
    const mdm = cachingMdm(3 * DAY_MS);
    await setup({ verifyOnJoin: false, deviceAttestor: mdm, requireDeviceAttestation: true, deviceAttestationIntervalMs: 50 });
    const key = Wallet.createRandom().privateKey;
    const attester = fakeAttester();
    const first = startWorker({ key, attester });
    await waitFor(() => pool.workerSummaries()[0]?.appleVerified === true);
    const assignment = await assign() as WorkerKeyCertificate & { deviceAttestation?: { chain: string[]; challenge: string } };
    expect(assignment.deviceAttestation?.challenge).toBe(deviceAttestationChallenge(first.address, attester.publicKey, TEST_UDID));

    // A reconnect asks again; Apple answers with the cached attestation, which still answers the derived challenge.
    first.stop();
    await waitFor(() => pool.workerSummaries().length === 0);
    startWorker({ key, attester });
    await waitFor(() => pool.workerSummaries()[0]?.appleVerified === true);
    expect(mdm.asked).toBe(2);
    expect(mdm.issued).toBe(1);

    // Apple can't issue a new one for 4 more days, so the pool doesn't ask, even with a short retry interval.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mdm.asked).toBe(2);
  });

  it('drops Apple\'s attestation once it is 8 days old', async () => {
    await setup({ verifyOnJoin: false, deviceAttestor: cachingMdm(8 * DAY_MS + 60_000, { reissue: false }), requireDeviceAttestation: true });
    startWorker({ attester: fakeAttester() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.services).toEqual([]);
    expect(pool.workerSummaries()).toEqual([]);
  });

  it('needs Apple\'s next attestation when a worker\'s attestation key changes', async () => {
    const mdm = cachingMdm(DAY_MS);
    await setup({ verifyOnJoin: false, deviceAttestor: mdm, requireDeviceAttestation: true });
    const key = Wallet.createRandom().privateKey;
    const first = startWorker({ key, attester: fakeAttester() });
    await waitFor(() => pool.workerSummaries()[0]?.appleVerified === true);
    first.stop();
    await waitFor(() => pool.workerSummaries().length === 0);

    // Same worker and Mac, new attestation key: Apple's cached attestation names the old key, so the Mac waits.
    startWorker({ key, attester: fakeAttester() });
    await waitFor(() => mdm.asked === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mdm.issued).toBe(1);
    expect(pool.workerSummaries()).toEqual([]);
  });

  it('ignores an older MDM answer that arrives after the worker named another Mac', async () => {
    const mdm = deferredMdm();
    await setup({ verifyOnJoin: false, attestationIntervalMs: 30, deviceAttestor: mdm });
    const device = { serial: 'C02TEST0MD6T', udid: TEST_UDID };
    startWorker({ attester: fakeAttester({ device }) });
    await waitFor(() => mdm.lookups.length === 1);

    // The worker re-attests naming another Mac: the pool asks about it while the first lookup is still out.
    device.serial = 'C02OTHERMAC1';
    device.udid = '00000000-0000-1000-8000-0000000000FF';
    await waitFor(() => mdm.lookups.length === 2);
    expect(mdm.lookups[1]!.udid).toBe(device.udid);

    // Apple's word for the old Mac must not verify the worker that now runs on another one.
    mdm.lookups[0]!.resolve('C02TEST0MD6T');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pool.workerSummaries()[0]).toMatchObject({ appleVerified: false });

    mdm.lookups[1]!.resolve('C02OTHERMAC1');
    await waitFor(() => pool.workerSummaries()[0]?.appleVerified === true);
  });

  it('keeps a newer MDM answer when an older lookup fails afterwards', async () => {
    const mdm = deferredMdm();
    await setup({ verifyOnJoin: false, attestationIntervalMs: 30, deviceAttestor: mdm, requireDeviceAttestation: true });
    const device = { serial: 'C02TEST0MD6T', udid: TEST_UDID };
    startWorker({ attester: fakeAttester({ device }) });
    await waitFor(() => mdm.lookups.length === 1);
    device.serial = 'C02OTHERMAC1';
    device.udid = '00000000-0000-1000-8000-0000000000FF';
    await waitFor(() => mdm.lookups.length === 2);

    mdm.lookups[1]!.resolve('C02OTHERMAC1');
    await waitFor(() => pool.workerSummaries()[0]?.appleVerified === true);

    // The stale failure neither clears the new verification nor disconnects the worker.
    mdm.lookups[0]!.reject(new Error('MDM timed out'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pool.workerSummaries()).toHaveLength(1);
    expect(pool.workerSummaries()[0]).toMatchObject({ appleVerified: true });
    expect(provider.services).toContain(SERVICE);
  });
});
