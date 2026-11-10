import { generateKeyPairSync, sign } from 'node:crypto';
import { Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '../src/types/http.js';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';
import { createTestAppleCa } from '../src/colony-pool/apple-attestation-testing.js';
import {
  NodeWorkerE2EClient,
  deviceAttestationNonce,
  WORKER_ASSIGN_PATH,
  WORKER_E2E_CAPABILITY,
  workerE2EProviderCapability,
  generateWorkerEncryptionKey,
  openRequest,
  workerAttestationMessage,
  workerKeyCertificateMessage,
  workerKeyHex,
} from '../src/colony-pool/e2e.js';

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const PROMPT = 'buyer secret';
const ANSWER = 'worker secret';

type OnResponse = (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void;
type OnChunk = (chunk: SerializedHttpResponseChunk) => void | Promise<void>;

const peer: PeerInfo = {
  peerId: 'a'.repeat(40) as PeerInfo['peerId'],
  lastSeen: Date.now(),
  providers: ['colony-pool'],
  providerServiceApiProtocols: { 'colony-pool': { services: { qwen: ['openai-chat-completions'] } } },
  capabilities: [WORKER_E2E_CAPABILITY, workerE2EProviderCapability('colony-pool')],
};
/** The same seller with an ordinary provider next to its colony pool. */
const mixedPeer: PeerInfo = {
  ...peer,
  providers: ['openai', 'colony-pool'],
  providerServiceApiProtocols: {
    openai: { services: { llama: ['openai-chat-completions'] } },
    'colony-pool': { services: { qwen: ['openai-chat-completions'] } },
  },
};
/** An ordinary provider and the colony pool offering the same model. */
function sharedPeer(order: string[]): PeerInfo {
  return {
    ...peer,
    providers: order,
    providerServiceApiProtocols: Object.fromEntries(order.map((provider) => [provider, { services: { qwen: ['openai-chat-completions'] } }])),
  };
}
const SELLER = `0x${'a'.repeat(40)}`;

function chatRequest(requestId: string, stream = false, model = 'qwen'): SerializedHttpRequest {
  return {
    requestId,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: enc({ model, stream, messages: [{ role: 'user', content: PROMPT }] }),
  };
}

/** A stand-in for the payment negotiator that records what the handler tells its payment manager. */
function recordingNegotiator(bpm: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const recorder = (target: Record<string, unknown> = {}) => new Proxy(target, {
    get: (object, prop) => {
      if (prop in object) return object[prop as string];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => { calls.push({ method: String(prop), args }); return undefined; };
    },
  });
  return { negotiator: recorder({ bpm: recorder(bpm) }), calls };
}

/** A pool with workers that really decrypt and encrypt, behind a fake mux. */
type Attest = 'hardened' | 'sip-off' | 'forged';
type Device = 'apple' | 'apple-sip-off' | 'other-mac';
const appleCa = createTestAppleCa();

/** What the pool forwards for an attested worker: its attestation key in the certificate, and a signed attestation. */
function attestation(kind: Attest, worker: string, key: string) {
  const make = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    return { privateKey, hex: `04${Buffer.from(jwk.x!, 'base64url').toString('hex')}${Buffer.from(jwk.y!, 'base64url').toString('hex')}` };
  };
  const certified = make();
  const signer = kind === 'forged' ? make() : certified;
  const statement = {
    v: 1 as const, teamId: 'H3M5BXXQR2', signingId: 'com.antseed.macworker', cdhash: 'ab'.repeat(20), sip: kind !== 'sip-off',
    hardenedRuntime: true, debuggerDenied: true, keyAppBound: true, os: 'macOS 26.2', serial: 'C02TEST0MD6T', udid: '00000000-0000-1000-8000-0123456789AB', issued: Math.floor(Date.now() / 1000), nonce: 'n',
  };
  const signature = sign('sha256', Buffer.from(workerAttestationMessage(worker, key, statement)), { key: signer.privateKey, dsaEncoding: 'der' }).toString('base64');
  return { attestationKey: certified.hex, attestation: { ...statement, signature } };
}

function deviceAttestation(kind: Device, worker: string, attestationKey: string, ca = appleCa, notBefore?: Date) {
  const challenge = 'mdm-challenge';
  return {
    challenge,
    chain: ca.issue({
      ...(notBefore ? { notBefore } : {}),
      serialNumber: kind === 'other-mac' ? 'SOMEONEELSE1' : 'C02TEST0MD6T',
      udid: '00000000-0000-1000-8000-0123456789AB',
      nonce: deviceAttestationNonce(worker, attestationKey, challenge),
      sip: kind !== 'apple-sip-off',
    }),
  };
}

function fakePool(opts: { payments?: boolean; bpm?: Record<string, unknown>; failSigning?: boolean; now?: () => number; appleCa?: ReturnType<typeof createTestAppleCa>; deviceNotBefore?: Date; workers?: number; recipients?: number; certSeller?: string; unavailableOnce?: boolean; tamper?: 'ciphertext' | 'usage'; attest?: Attest | Attest[]; device?: Device; requireApple?: boolean; streamTamper?: 'no-end' | 'usage' | 'not-sse' | 'padding'; maxStreamBufferBytes?: number; failover?: boolean; forgeAnswer?: boolean; noHook?: boolean; assignFails?: boolean } = {}) {
  const workers = Array.from({ length: opts.workers ?? 1 }, () => ({ wallet: Wallet.createRandom(), key: generateWorkerEncryptionKey() }));
  let next = 0;
  let unavailable = opts.unavailableOnce === true;
  const wire: SerializedHttpRequest[] = [];
  const assigned: string[] = [];
  const encryptedFor: string[][] = [];
  const respond = (onResponse: OnResponse, requestId: string, statusCode: number, body: unknown) =>
    onResponse({ requestId, statusCode, headers: { 'content-type': 'application/json' }, body: enc(body) }, { streamingStart: false });

  const proxyMux = {
    sendProxyRequest: vi.fn((req: SerializedHttpRequest, onResponse: OnResponse, onChunk: OnChunk) => {
      wire.push(req);
      if (req.path === WORKER_ASSIGN_PATH) {
        if (opts.assignFails) {
          respond(onResponse, req.requestId, 503, { error: { message: 'No worker is available for qwen' } });
          return;
        }
        const wanted = (JSON.parse(dec(req.body)) as { recipients?: number }).recipients ?? 1;
        const start = next++;
        const chosen = Array.from({ length: Math.min(wanted, workers.length) }, (_, i) => (start + i) % workers.length);
        assigned.push(workers[chosen[0]!]!.wallet.address);
        respond(onResponse, req.requestId, 200, {
          workers: chosen.map((index) => {
            const worker = workers[index]!;
            const key = workerKeyHex(worker.key.publicKey);
            const expires = Math.floor(Date.now() / 1000) + 3600;
            const pool = opts.certSeller ?? SELLER;
            const kind = Array.isArray(opts.attest) ? opts.attest[index] : opts.attest;
            const attested = kind ? attestation(kind, worker.wallet.address, key) : null;
            return {
              worker: worker.wallet.address, key, expires, pool,
              certificate: worker.wallet.signMessageSync(workerKeyCertificateMessage(pool, key, expires, attested?.attestationKey)),
              ...(attested ?? {}),
              ...(attested && opts.device ? { deviceAttestation: deviceAttestation(opts.device, worker.wallet.address, attested.attestationKey, opts.appleCa, opts.deviceNotBefore) } : {}),
            };
          }),
        });
        return;
      }
      const envelope = JSON.parse(dec(req.body)).antseed_e2e as { recipients: Array<{ worker: string }> } | undefined;
      // An ordinary provider's plaintext answer.
      if (!envelope) {
        respond(onResponse, req.requestId, 200, { choices: [{ message: { content: 'plain answer' } }] });
        return;
      }
      if (unavailable) {
        unavailable = false;
        respond(onResponse, req.requestId, 421, { error: { code: 'worker_unavailable', message: 'gone' } });
        return;
      }
      const recipients = envelope.recipients.map((r) => r.worker);
      encryptedFor.push(recipients);
      // The pool fails over from the first recipient to the next one without the buyer.
      const answering = (opts.failover || opts.forgeAnswer) && recipients.length > 1 ? recipients[1]! : recipients[0]!;
      const worker = workers.find((w) => w.wallet.address === answering)!;
      const opened = openRequest(req.body, worker.wallet.address, worker.key);
      expect(dec(opened.body)).toContain(PROMPT);
      const inner = JSON.parse(dec(opened.body)) as { stream?: boolean };
      const usage = { prompt_tokens: 10, completion_tokens: 5 };
      if (inner.stream) {
        const contentType = opts.streamTamper === 'not-sse' ? 'application/json' : 'text/event-stream';
        onResponse({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': contentType, [ANTSEED_STREAMING_RESPONSE_HEADER]: '1' }, body: new Uint8Array() }, { streamingStart: true });
        const upstream = `data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
        const parts = [opened.sealer.pushStream(enc(upstream).subarray(0, 0)), opened.sealer.pushStream(new TextEncoder().encode(upstream))];
        // The pool bills more than the worker's sealed usage in a clear line of its own.
        if (opts.streamTamper === 'usage') parts.push(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [], usage: { ...usage, completion_tokens: 50 } })}\n\n`));
        // Events the opener ignores: wire bytes without any plaintext.
        if (opts.streamTamper === 'padding') parts.push(new TextEncoder().encode(`data: ${JSON.stringify({ pad: 'x'.repeat(200) })}\n\n`.repeat(50)));
        if (opts.streamTamper !== 'no-end') parts.push(opened.sealer.finishStream());
        const sealed = Buffer.concat(parts);
        void onChunk({ requestId: req.requestId, data: sealed.subarray(0, 40), done: false });
        void onChunk({ requestId: req.requestId, data: sealed.subarray(40), done: false });
        void onChunk({ requestId: req.requestId, data: new Uint8Array(), done: true });
        return;
      }
      let sealed = opened.sealer.sealBody(enc({ choices: [{ message: { content: ANSWER } }], usage }));
      if (opts.forgeAnswer) {
        // The second recipient answers but claims to be the first, to be paid in its place.
        const envelope = JSON.parse(dec(sealed)) as { antseed_e2e: { worker: string } };
        envelope.antseed_e2e.worker = recipients[0]!;
        sealed = enc(envelope);
      }
      if (opts.tamper) {
        const envelope = JSON.parse(dec(sealed)) as { antseed_e2e: { ct: string }; usage: { completion_tokens: number } };
        if (opts.tamper === 'ciphertext') {
          const ct = Buffer.from(envelope.antseed_e2e.ct, 'base64');
          ct[0] ^= 1;
          envelope.antseed_e2e.ct = ct.toString('base64');
        } else {
          envelope.usage.completion_tokens *= 10; // the pool bills for more than the worker produced
        }
        sealed = enc(envelope);
      }
      onResponse({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: sealed }, { streamingStart: false });
    }),
    cancelProxyRequest: vi.fn(),
    activeRequestCount: () => 0,
  };
  const buyer = Wallet.createRandom();
  const payments = opts.payments || opts.bpm ? recordingNegotiator(opts.bpm) : null;
  const handler = new BuyerRequestHandler(opts.maxStreamBufferBytes ? { maxStreamBufferBytes: opts.maxStreamBufferBytes } : {}, {
    localPeerId: buyer.address.slice(2).toLowerCase() as PeerInfo['peerId'],
    negotiator: (payments?.negotiator ?? null) as any,
    verificationStorage: null,
    verificationSampler: null,
    getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
    getMux: vi.fn(() => proxyMux as any),
    getVerificationMux: vi.fn(() => ({} as any)),
    registerPaymentMux: vi.fn(),
    workerE2E: opts.noHook ? undefined : new NodeWorkerE2EClient(opts.failSigning ? { address: buyer.address, signMessage: async () => { throw new Error('signer locked'); } } as never : buyer, {
      ...(opts.recipients ? { recipients: opts.recipients } : {}),
      requireAppleVerifiedWorkers: opts.requireApple === true,
      deviceAttestationRoots: [(opts.appleCa ?? appleCa).rootPem],
      ...(opts.now ? { now: opts.now } : {}),
    }),
  });
  const deliveries = () => (payments?.calls ?? [])
    .filter((call) => call.method === 'recordWorkerAttribution' || call.method === 'recordWorkerDelivery')
    .map((call) => call.method === 'recordWorkerAttribution' ? 'assigned' : call.args[1] === null ? 'failed' : call.args[1]);
  return { handler, wire, assigned, workers, deliveries, encryptedFor, calls: payments?.calls ?? [] };
}

describe('buyer requests to colony pools', () => {
  it('encrypts to an assigned worker, keeps the assignment, and returns the decrypted answer', async () => {
    const pool = fakePool();
    const first = await pool.handler.sendRequest(peer, chatRequest('r1'));
    const second = await pool.handler.sendRequest(peer, chatRequest('r2'));

    expect(JSON.parse(dec(first.body)).choices[0].message.content).toBe(ANSWER);
    expect(JSON.parse(dec(second.body)).choices[0].message.content).toBe(ANSWER);
    expect(pool.assigned).toHaveLength(1);
    const sent = pool.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH);
    expect(sent).toHaveLength(2);
    for (const req of sent) {
      expect(dec(req.body)).not.toContain(PROMPT);
      expect(JSON.parse(dec(req.body)).antseed_e2e.recipients.map((r: { worker: string }) => r.worker)).toEqual([pool.workers[0]!.wallet.address]);
      expect(JSON.parse(dec(req.body)).model).toBe('qwen');
    }
  });

  it('carries the latest payment, encrypts only for the workers the channel can credit, and records them as it chooses', async () => {
    const channel = `0x${'ab'.repeat(32)}`;
    const latest = { channelId: channel, cumulativeAmount: '9000', metadata: '0x00', signature: `0x${'11'.repeat(65)}` };
    let creditable: (assigned: string[]) => string[] = (assigned) => assigned;
    const pool = fakePool({
      workers: 3, recipients: 3,
      bpm: { getActiveSession: () => ({ sessionId: channel }), latestSpendingAuth: () => latest, creditableWorkers: (_seller: string, assigned: string[]) => creditable(assigned) },
    });
    const third = pool.workers[2]!.wallet.address;
    creditable = (assigned) => assigned.filter((w) => w === third);
    expect((await pool.handler.sendRequest(peer, chatRequest('c1'))).statusCode).toBe(200);
    expect(pool.encryptedFor).toEqual([[third]]);
    expect(pool.calls.find((call) => call.method === 'recordWorkerAttribution')?.args.slice(1, 3)).toEqual(['c1', [third]]);
    const sent = pool.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH);
    expect(JSON.parse(dec(sent[0]!.body)).antseed_e2e.pay).toEqual({ cumulativeAmount: '9000', metadata: '0x00', signature: latest.signature });
    // None of the assigned workers can be credited: refused before anything is sent, and assigned afresh next time.
    creditable = () => [];
    const requestsSent = () => pool.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH).length;
    const before = requestsSent();
    const assignments = pool.assigned.length;
    await expect(pool.handler.sendRequest(peer, chatRequest('c2'))).rejects.toThrow(/already credits the most workers/);
    expect(requestsSent()).toBe(before);
    creditable = (assigned) => assigned;
    await pool.handler.sendRequest(peer, chatRequest('c3'));
    expect(pool.assigned.length).toBe(assignments + 1);
  });

  it('releases the workers it chose when sealing then fails, so they hold no attribution slot', async () => {
    const channel = `0x${'ab'.repeat(32)}`;
    const pool = fakePool({ failSigning: true, bpm: { getActiveSession: () => ({ sessionId: channel }), creditableWorkers: (_seller: string, assigned: string[]) => assigned } });
    await expect(pool.handler.sendRequest(peer, chatRequest('f1'))).rejects.toThrow(/signer locked/);
    const recorded = pool.calls.filter((call) => call.method === 'recordWorkerAttribution' || call.method === 'recordWorkerDelivery').map((call) => [call.method, call.args[0], call.args[1]]);
    expect(recorded).toEqual([['recordWorkerAttribution', peer.peerId, 'f1'], ['recordWorkerDelivery', 'f1', null]]);
    expect(pool.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH)).toHaveLength(0);
  });

  it('decrypts a streamed answer for the client', async () => {
    const pool = fakePool();
    const chunks: string[] = [];
    const response = await pool.handler.sendRequest(peer, chatRequest('s1', true), {
      onResponseChunk: (chunk) => { chunks.push(dec(chunk.data)); },
    });
    expect(chunks.join('')).toContain(ANSWER);
    expect(chunks.join('')).not.toContain('antseed_e2e');
    expect(dec(response.body)).toContain('[DONE]');
  });

  it('with several recipients, takes other workers once when the pool says the assigned ones are unavailable', async () => {
    const pool = fakePool({ workers: 2, recipients: 2, unavailableOnce: true });
    const response = await pool.handler.sendRequest(peer, chatRequest('u1'));
    expect(response.statusCode).toBe(200);
    expect(pool.assigned).toHaveLength(2);
  });

  it('with one recipient (the default), never sends a request another worker could read', async () => {
    const pool = fakePool({ workers: 2, unavailableOnce: true });
    const response = await pool.handler.sendRequest(peer, chatRequest('u2'));
    expect(response.statusCode).toBe(421);
    expect(pool.assigned).toHaveLength(1);
  });

  it('refuses a worker key certified for a different seller', async () => {
    const pool = fakePool({ certSeller: Wallet.createRandom().address });
    await expect(pool.handler.sendRequest(peer, chatRequest('x1'))).rejects.toThrow(/not certified for this seller/);
    expect(pool.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH)).toHaveLength(0);
  });

  it('checks a forwarded attestation before encrypting, but never requires its self-reported hardening', async () => {
    expect((await fakePool({ attest: 'hardened' }).handler.sendRequest(peer, chatRequest('a1'))).statusCode).toBe(200);
    // Valid but SIP off: the worker signs its own report, so it is shown, never a requirement.
    expect((await fakePool({ attest: 'sip-off' }).handler.sendRequest(peer, chatRequest('a2'))).statusCode).toBe(200);
    // Signed by a key the worker never certified (the pool forging one).
    const forged = fakePool({ attest: 'forged' });
    await expect(forged.handler.sendRequest(peer, chatRequest('a5'))).rejects.toThrow(/invalid worker attestation/);
    expect(forged.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH)).toHaveLength(0);
  });

  it('checks Apple\'s attestation of the worker\'s Mac, and can require it', async () => {
    expect((await fakePool({ attest: 'hardened', device: 'apple', requireApple: true }).handler.sendRequest(peer, chatRequest('d1'))).statusCode).toBe(200);
    await expect(fakePool({ attest: 'hardened', requireApple: true }).handler.sendRequest(peer, chatRequest('d2'))).rejects.toThrow(/Apple does not attest/);
    await expect(fakePool({ attest: 'hardened', device: 'apple-sip-off' }).handler.sendRequest(peer, chatRequest('d3'))).rejects.toThrow(/SIP off/);
    await expect(fakePool({ attest: 'hardened', device: 'other-mac' }).handler.sendRequest(peer, chatRequest('d4'))).rejects.toThrow(/another Mac/);
  });

  it('accepts Apple\'s cached attestation for 8 days, Apple\'s 7-day reissue interval plus a day', async () => {
    const clock = Math.floor(Date.now() / 1000);
    // Apple returns its cached attestation for 7 days, so a leaf issued 3 days ago is current.
    const recent = fakePool({ attest: 'hardened', device: 'apple', requireApple: true, now: () => clock, deviceNotBefore: new Date((clock - 3 * 24 * 3600) * 1000) });
    expect((await recent.handler.sendRequest(peer, chatRequest('a8'))).statusCode).toBe(200);
    const old = fakePool({ attest: 'hardened', device: 'apple', requireApple: true, now: () => clock, deviceNotBefore: new Date((clock - 8 * 24 * 3600 - 60) * 1000) });
    await expect(old.handler.sendRequest(peer, chatRequest('a9'))).rejects.toThrow(/device attestation is stale/);
  });

  it('stops using a cached assignment once its Apple attestation grows too old', async () => {
    let clock = Math.floor(Date.now() / 1000);
    // Apple's leaf is a minute short of the 8-day limit when the buyer first uses it.
    const pool = fakePool({ attest: 'hardened', device: 'apple', now: () => clock, deviceNotBefore: new Date((clock - 8 * 24 * 3600 + 60) * 1000) });
    expect((await pool.handler.sendRequest(peer, chatRequest('c1'))).statusCode).toBe(200);
    clock += 30;
    expect((await pool.handler.sendRequest(peer, chatRequest('c2'))).statusCode).toBe(200);
    expect(pool.assigned).toHaveLength(1);
    clock += 90;
    await expect(pool.handler.sendRequest(peer, chatRequest('c3'))).rejects.toThrow(/device attestation is stale/);
    expect(pool.assigned).toHaveLength(2);
  });

  it('stops using a cached assignment once a certificate in its Apple chain expires', async () => {
    let clock = Math.floor(Date.now() / 1000);
    // Apple's intermediate expires 10 minutes from now.
    const ca = createTestAppleCa({ created: new Date((clock - 365 * 24 * 3600 + 600) * 1000) });
    const pool = fakePool({ attest: 'hardened', device: 'apple', appleCa: ca, now: () => clock });
    expect((await pool.handler.sendRequest(peer, chatRequest('c4'))).statusCode).toBe(200);
    clock += 500;
    expect((await pool.handler.sendRequest(peer, chatRequest('c5'))).statusCode).toBe(200);
    expect(pool.assigned).toHaveLength(1);
    clock += 200;
    await expect(pool.handler.sendRequest(peer, chatRequest('c6'))).rejects.toThrow(/not valid now/);
    expect(pool.assigned).toHaveLength(2);
  });

  it('fails a response whose ciphertext does not verify', async () => {
    const pool = fakePool({ tamper: 'ciphertext' });
    await expect(pool.handler.sendRequest(peer, chatRequest('t1'))).rejects.toThrow(/failed verification/);
  });

  it('fails a response whose billed usage differs from the worker\'s sealed usage', async () => {
    const pool = fakePool({ tamper: 'usage' });
    await expect(pool.handler.sendRequest(peer, chatRequest('t2'))).rejects.toThrow(/failed verification/);
  });

  it('fails a stream that ends without the worker\'s end marker', async () => {
    const pool = fakePool({ streamTamper: 'no-end' });
    await expect(pool.handler.sendRequest(peer, chatRequest('e1', true), { onResponseChunk: () => {} })).rejects.toThrow(/ended without its end marker/);
  });

  it('fails a stream whose billed usage differs from the worker\'s sealed usage', async () => {
    const pool = fakePool({ streamTamper: 'usage' });
    await expect(pool.handler.sendRequest(peer, chatRequest('e2', true), { onResponseChunk: () => {} })).rejects.toThrow(/differs from its worker/);
  });

  it('fails a successful worker stream that is not sealed SSE', async () => {
    const pool = fakePool({ streamTamper: 'not-sse' });
    await expect(pool.handler.sendRequest(peer, chatRequest('e3', true), { onResponseChunk: () => {} })).rejects.toThrow(/not sealed SSE/);
  });

  it('bounds the wire bytes of a sealed stream, not only its plaintext', async () => {
    expect((await fakePool({ maxStreamBufferBytes: 4000 }).handler.sendRequest(peer, chatRequest('e4', true), { onResponseChunk: () => {} })).statusCode).toBe(200);
    const pool = fakePool({ streamTamper: 'padding', maxStreamBufferBytes: 4000 });
    await expect(pool.handler.sendRequest(peer, chatRequest('e5', true), { onResponseChunk: () => {} })).rejects.toThrow(/exceeded max buffered size/);
  });

  it('leaves sellers without the capability untouched', async () => {
    const pool = fakePool();
    const plainPeer = { ...peer, capabilities: [] };
    expect(JSON.parse(dec((await pool.handler.sendRequest(plainPeer, chatRequest('p1'))).body)).choices[0].message.content).toBe('plain answer');
    expect(dec(pool.wire[0]!.body)).toContain(PROMPT);
  });

  it('encrypts only the colony pool\'s services on a seller that also has an ordinary provider', async () => {
    const pool = fakePool();
    const ordinary = await pool.handler.sendRequest(mixedPeer, chatRequest('m1', false, 'llama'));
    expect(JSON.parse(dec(ordinary.body)).choices[0].message.content).toBe('plain answer');
    expect(pool.wire.map((req) => req.path)).toEqual(['/v1/chat/completions']);
    expect(dec(pool.wire[0]!.body)).toContain(PROMPT);

    const pooled = await pool.handler.sendRequest(mixedPeer, chatRequest('m2'));
    expect(JSON.parse(dec(pooled.body)).choices[0].message.content).toBe(ANSWER);
    expect(dec(pool.wire.at(-1)!.body)).not.toContain(PROMPT);
  });

  it('encrypts by the provider a request is routed to when both offer the same model', async () => {
    const withProvider = (requestId: string, provider: string) => {
      const request = chatRequest(requestId);
      return { ...request, headers: { ...request.headers, 'x-antseed-provider': provider } };
    };
    const pool = fakePool();
    const shared = sharedPeer(['openai', 'colony-pool']);

    const ordinary = await pool.handler.sendRequest(shared, withProvider('s1', 'openai'));
    expect(JSON.parse(dec(ordinary.body)).choices[0].message.content).toBe('plain answer');
    expect(pool.wire.map((req) => req.path)).toEqual(['/v1/chat/completions']);
    expect(dec(pool.wire[0]!.body)).toContain(PROMPT);

    const pooled = await pool.handler.sendRequest(shared, withProvider('s2', 'colony-pool'));
    expect(JSON.parse(dec(pooled.body)).choices[0].message.content).toBe(ANSWER);
    expect(pool.wire.at(-1)!.headers['x-antseed-provider']).toBe('colony-pool');
    expect(dec(pool.wire.at(-1)!.body)).not.toContain(PROMPT);
  });

  it('encrypts by the default route\'s provider when both offer the same model', async () => {
    // The route takes the first provider offering the model, as the seller does, and names it.
    const ordinaryFirst = fakePool();
    await ordinaryFirst.handler.sendRequest(sharedPeer(['openai', 'colony-pool']), chatRequest('d1'));
    expect(ordinaryFirst.wire.map((req) => req.path)).toEqual(['/v1/chat/completions']);
    expect(ordinaryFirst.wire[0]!.headers['x-antseed-provider']).toBe('openai');
    expect(dec(ordinaryFirst.wire[0]!.body)).toContain(PROMPT);

    const poolFirst = fakePool();
    const pooled = await poolFirst.handler.sendRequest(sharedPeer(['colony-pool', 'openai']), chatRequest('d2'));
    expect(JSON.parse(dec(pooled.body)).choices[0].message.content).toBe(ANSWER);
    expect(poolFirst.wire.map((req) => req.path)).toEqual([WORKER_ASSIGN_PATH, '/v1/chat/completions']);
    expect(poolFirst.wire[0]!.headers['x-antseed-provider']).toBe('colony-pool');
    expect(poolFirst.wire.at(-1)!.headers['x-antseed-provider']).toBe('colony-pool');
    expect(dec(poolFirst.wire.at(-1)!.body)).not.toContain(PROMPT);
  });

  it('encrypts a request that names the pool even when the buyer\'s metadata lists the model only for an ordinary provider', async () => {
    // Pools gain models as workers join, so the buyer's view of them can be stale.
    const naming = (requestId: string, provider: string, model: string) => {
      const request = chatRequest(requestId, false, model);
      return { ...request, headers: { ...request.headers, 'x-antseed-provider': provider } };
    };
    const pool = fakePool();
    const answer = await pool.handler.sendRequest(mixedPeer, naming('x1', 'colony-pool', 'llama'));
    expect(JSON.parse(dec(answer.body)).choices[0].message.content).toBe(ANSWER);
    expect(pool.wire.map((req) => req.path)).toEqual([WORKER_ASSIGN_PATH, '/v1/chat/completions']);
    expect(pool.wire[0]!.headers['x-antseed-provider']).toBe('colony-pool');
    expect(pool.wire.at(-1)!.headers['x-antseed-provider']).toBe('colony-pool');
    expect(pool.wire.some((req) => dec(req.body).includes(PROMPT))).toBe(false);

    const noHook = fakePool({ noHook: true });
    await expect(noHook.handler.sendRequest(mixedPeer, naming('x2', 'colony-pool', 'llama'))).rejects.toThrow(/needs worker encryption/);
    expect(noHook.wire).toHaveLength(0);
  });

  it('keeps a request that names an ordinary provider plaintext only when that provider offers the model', async () => {
    const naming = (requestId: string, provider: string, model: string) => {
      const request = chatRequest(requestId, false, model);
      return { ...request, headers: { ...request.headers, 'x-antseed-provider': provider } };
    };
    const pool = fakePool();
    await pool.handler.sendRequest(mixedPeer, naming('y1', 'openai', 'llama'));
    expect(pool.wire.map((req) => req.path)).toEqual(['/v1/chat/completions']);
    expect(dec(pool.wire[0]!.body)).toContain(PROMPT);

    // The named provider does not offer qwen, so the seller would serve it through another provider, possibly its pool.
    const fallback = fakePool();
    await fallback.handler.sendRequest(mixedPeer, naming('y2', 'openai', 'qwen'));
    expect(fallback.wire.some((req) => dec(req.body).includes(PROMPT))).toBe(false);
    // The assignment is left to the seller to place rather than asked of the ordinary provider.
    expect(fallback.wire[0]!.path).toBe(WORKER_ASSIGN_PATH);
    expect(fallback.wire[0]!.headers['x-antseed-provider']).toBeUndefined();
    const noHook = fakePool({ noHook: true });
    await expect(noHook.handler.sendRequest(mixedPeer, naming('y3', 'openai', 'qwen'))).rejects.toThrow(/needs worker encryption/);
    await expect(noHook.handler.sendRequest(mixedPeer, naming('y4', 'unknown', 'llama'))).rejects.toThrow(/needs worker encryption/);
    // Unnamed, a model no provider announces falls back to the ordinary provider listed first, which is no proof it is safe.
    await expect(noHook.handler.sendRequest(mixedPeer, chatRequest('y6', false, 'unlisted'))).rejects.toThrow(/needs worker encryption/);
    expect(noHook.wire).toHaveLength(0);
    const unlisted = fakePool();
    await unlisted.handler.sendRequest(mixedPeer, chatRequest('y7', false, 'unlisted'));
    expect(unlisted.wire.some((req) => dec(req.body).includes(PROMPT))).toBe(false);
    expect(unlisted.wire[0]!.path).toBe(WORKER_ASSIGN_PATH);
    expect(unlisted.wire[0]!.headers['x-antseed-provider']).toBeUndefined();

    // A padded ordinary model name is resolved trimmed, as the seller does, and stays plaintext.
    const padded = fakePool({ noHook: true });
    await padded.handler.sendRequest(mixedPeer, chatRequest('y5', false, ' llama '));
    expect(dec(padded.wire[0]!.body)).toContain(PROMPT);
  });

  it('never sends a pool request in the clear when this client cannot encrypt', async () => {
    const pool = fakePool({ noHook: true });
    await expect(pool.handler.sendRequest(peer, chatRequest('h1'))).rejects.toThrow(/needs worker encryption/);
    // A model name with spaces (the seller trims it) and a model no provider announces go nowhere either.
    await expect(pool.handler.sendRequest(peer, chatRequest('h2', false, ' qwen '))).rejects.toThrow(/needs worker encryption/);
    await expect(pool.handler.sendRequest(peer, chatRequest('h3', false, 'unlisted'))).rejects.toThrow(/needs worker encryption/);
    expect(pool.wire).toHaveLength(0);
    // The seller's ordinary provider still works without the hook.
    const ordinary = await pool.handler.sendRequest(mixedPeer, chatRequest('h4', false, 'llama'));
    expect(JSON.parse(dec(ordinary.body)).choices[0].message.content).toBe('plain answer');
  });

  it('encrypts a pool model named with surrounding spaces', async () => {
    const pool = fakePool();
    const answer = await pool.handler.sendRequest(peer, chatRequest('w1', false, ' qwen '));
    expect(JSON.parse(dec(answer.body)).choices[0].message.content).toBe(ANSWER);
    expect(pool.wire.map((req) => req.path)).toEqual([WORKER_ASSIGN_PATH, '/v1/chat/completions']);
    expect(dec(pool.wire.at(-1)!.body)).not.toContain(PROMPT);
  });

  it('encrypts a padded pool-only model on a seller listing an ordinary provider first', async () => {
    // Untrimmed, " qwen " matches no provider and would fall back to openai, in the clear.
    const pool = fakePool();
    const answer = await pool.handler.sendRequest(mixedPeer, chatRequest('w2', false, ' qwen '));
    expect(JSON.parse(dec(answer.body)).choices[0].message.content).toBe(ANSWER);
    expect(pool.wire.map((req) => req.path)).toEqual([WORKER_ASSIGN_PATH, '/v1/chat/completions']);
    expect(pool.wire.at(-1)!.headers['x-antseed-provider']).toBe('colony-pool');
    expect(pool.wire.some((req) => dec(req.body).includes(PROMPT))).toBe(false);
    const noHook = fakePool({ noHook: true });
    await expect(noHook.handler.sendRequest(mixedPeer, chatRequest('w3', false, ' qwen '))).rejects.toThrow(/needs worker encryption/);
    expect(noHook.wire).toHaveLength(0);
  });

  it('sends nothing but the assignment when the pool assigns no worker', async () => {
    const pool = fakePool({ assignFails: true });
    await expect(pool.handler.sendRequest(peer, chatRequest('a1'))).rejects.toThrow();
    expect(pool.wire.map((req) => req.path)).toEqual([WORKER_ASSIGN_PATH]);
    expect(pool.wire.some((req) => dec(req.body).includes(PROMPT))).toBe(false);
  });

  it('tells the payment manager which requests to a pool seller went to an ordinary provider', async () => {
    const pool = fakePool({ payments: true });
    await pool.handler.sendRequest(mixedPeer, chatRequest('o1', false, 'llama'));
    await pool.handler.sendRequest(mixedPeer, chatRequest('o2'));
    expect(pool.calls.some((call) => call.method === 'markWorkerSeller' && call.args[0] === mixedPeer.peerId)).toBe(true);
    const tracked = pool.calls.filter((call) => call.method === 'trackPoolSellerRequest').map((call) => call.args[1]);
    expect(tracked).toEqual(['o1']);
    // The seller is marked before the payment mux exists, so no claim can arrive first.
    const order = pool.calls.map((call) => call.method);
    expect(order.indexOf('markWorkerSeller')).toBeLessThan(order.indexOf('releaseRequestCoverage'));
  });

  it('does not encrypt when the colony-pool capability names no provider of the service', async () => {
    const pool = fakePool();
    const unscoped = { ...peer, capabilities: [WORKER_E2E_CAPABILITY] };
    await pool.handler.sendRequest(unscoped, chatRequest('m3'));
    expect(pool.wire.map((req) => req.path)).toEqual(['/v1/chat/completions']);
  });

  it('tells the payment manager whether the worker\'s sealed answer verified, with its authenticated usage', async () => {
    const verified = fakePool({ payments: true });
    await verified.handler.sendRequest(peer, chatRequest('v1'));
    expect(verified.deliveries()).toEqual(['assigned', { inputTokens: 10n, cachedInputTokens: 0n, outputTokens: 5n }]);

    const streamed = fakePool({ payments: true });
    await streamed.handler.sendRequest(peer, chatRequest('v2', true), { onResponseChunk: () => {} });
    expect(streamed.deliveries()).toEqual(['assigned', { inputTokens: 10n, cachedInputTokens: 0n, outputTokens: 5n }]);

    const tampered = fakePool({ payments: true, tamper: 'ciphertext' });
    await expect(tampered.handler.sendRequest(peer, chatRequest('v3'))).rejects.toThrow();
    expect(tampered.deliveries()).toEqual(['assigned', 'failed']);

    const truncated = fakePool({ payments: true, streamTamper: 'no-end' });
    await expect(truncated.handler.sendRequest(peer, chatRequest('v4', true), { onResponseChunk: () => {} })).rejects.toThrow();
    expect(truncated.deliveries()).toEqual(['assigned', 'failed']);

    // The first worker was unavailable: its attempt fails, the second worker's verifies.
    const retried = fakePool({ payments: true, workers: 2, recipients: 2, unavailableOnce: true });
    await retried.handler.sendRequest(peer, chatRequest('v5'));
    expect(retried.deliveries()).toEqual(['assigned', 'failed', 'assigned', { inputTokens: 10n, cachedInputTokens: 0n, outputTokens: 5n }]);
  });

  it('encrypts each request for the pool\'s top worker by default, and for the top two when the buyer asks', async () => {
    const single = fakePool({ workers: 3 });
    await single.handler.sendRequest(peer, chatRequest('n1'));
    expect(single.encryptedFor[0]).toEqual([single.workers[0]!.wallet.address]);
    const pool = fakePool({ workers: 3, recipients: 2 });
    await pool.handler.sendRequest(peer, chatRequest('n2'));
    expect(pool.encryptedFor[0]).toEqual([pool.workers[0]!.wallet.address, pool.workers[1]!.wallet.address]);
    expect(() => new NodeWorkerE2EClient(Wallet.createRandom(), { recipients: 4 })).toThrow(/1 to 3/);
  });

  it('takes the answer of the recipient the pool failed over to, without a new assignment, and credits only it', async () => {
    const pool = fakePool({ workers: 2, recipients: 2, failover: true, payments: true });
    const response = await pool.handler.sendRequest(peer, chatRequest('f1'));
    expect(JSON.parse(dec(response.body)).choices[0].message.content).toBe(ANSWER);
    expect(pool.wire.filter((req) => req.path === WORKER_ASSIGN_PATH)).toHaveLength(1);
    const attribution = pool.calls.find((call) => call.method === 'recordWorkerAttribution')!;
    expect(attribution.args[2]).toEqual([pool.workers[0]!.wallet.address, pool.workers[1]!.wallet.address]);
    const delivery = pool.calls.find((call) => call.method === 'recordWorkerDelivery')!;
    expect(delivery.args[1]).toEqual({ inputTokens: 10n, cachedInputTokens: 0n, outputTokens: 5n });
    expect(delivery.args[2]).toBe(pool.workers[1]!.wallet.address);
  });

  it('fails an answer one recipient seals but labels as another\'s', async () => {
    const pool = fakePool({ workers: 2, recipients: 2, forgeAnswer: true, payments: true });
    await expect(pool.handler.sendRequest(peer, chatRequest('g1'))).rejects.toThrow(/failed verification/);
    expect(pool.deliveries()).toEqual(['assigned', 'failed']);
  });

  it('applies the buyer\'s trust policy to every recipient, leaving out those that fail it', async () => {
    const mixed = fakePool({ workers: 2, recipients: 2, attest: ['forged', 'sip-off'] });
    expect((await mixed.handler.sendRequest(peer, chatRequest('p1'))).statusCode).toBe(200);
    expect(mixed.encryptedFor[0]).toEqual([mixed.workers[1]!.wallet.address]);
    const none = fakePool({ workers: 2, recipients: 2, attest: ['forged', 'forged'] });
    await expect(none.handler.sendRequest(peer, chatRequest('p2'))).rejects.toThrow();
    expect(none.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH)).toHaveLength(0);
  });
});
