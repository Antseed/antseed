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
function recordingNegotiator() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const recorder = (target: Record<string, unknown> = {}) => new Proxy(target, {
    get: (object, prop) => {
      if (prop in object) return object[prop as string];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => { calls.push({ method: String(prop), args }); return undefined; };
    },
  });
  return { negotiator: recorder({ bpm: recorder() }), calls };
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

function fakePool(opts: { payments?: boolean; now?: () => number; appleCa?: ReturnType<typeof createTestAppleCa>; deviceNotBefore?: Date; workers?: number; certSeller?: string; unavailableOnce?: boolean; tamper?: 'ciphertext' | 'usage'; attest?: Attest; requireAttested?: boolean; device?: Device; requireApple?: boolean; streamTamper?: 'no-end' | 'usage' | 'not-sse' | 'padding'; maxStreamBufferBytes?: number } = {}) {
  const workers = Array.from({ length: opts.workers ?? 1 }, () => ({ wallet: Wallet.createRandom(), key: generateWorkerEncryptionKey() }));
  let next = 0;
  let unavailable = opts.unavailableOnce === true;
  const wire: SerializedHttpRequest[] = [];
  const assigned: string[] = [];
  const respond = (onResponse: OnResponse, requestId: string, statusCode: number, body: unknown) =>
    onResponse({ requestId, statusCode, headers: { 'content-type': 'application/json' }, body: enc(body) }, { streamingStart: false });

  const proxyMux = {
    sendProxyRequest: vi.fn((req: SerializedHttpRequest, onResponse: OnResponse, onChunk: OnChunk) => {
      wire.push(req);
      if (req.path === WORKER_ASSIGN_PATH) {
        const worker = workers[next++ % workers.length]!;
        assigned.push(worker.wallet.address);
        const key = workerKeyHex(worker.key.publicKey);
        const expires = Math.floor(Date.now() / 1000) + 3600;
        const pool = opts.certSeller ?? SELLER;
        const attested = opts.attest ? attestation(opts.attest, worker.wallet.address, key) : null;
        respond(onResponse, req.requestId, 200, {
          worker: worker.wallet.address, key, expires, pool,
          certificate: worker.wallet.signMessageSync(workerKeyCertificateMessage(pool, key, expires, attested?.attestationKey)),
          ...(attested ?? {}),
          ...(attested && opts.device ? { deviceAttestation: deviceAttestation(opts.device, worker.wallet.address, attested.attestationKey, opts.appleCa, opts.deviceNotBefore) } : {}),
        });
        return;
      }
      const envelope = JSON.parse(dec(req.body)).antseed_e2e as { worker: string } | undefined;
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
      const worker = workers.find((w) => w.wallet.address === envelope.worker)!;
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
  const payments = opts.payments ? recordingNegotiator() : null;
  const handler = new BuyerRequestHandler(opts.maxStreamBufferBytes ? { maxStreamBufferBytes: opts.maxStreamBufferBytes } : {}, {
    localPeerId: buyer.address.slice(2).toLowerCase() as PeerInfo['peerId'],
    negotiator: (payments?.negotiator ?? null) as any,
    verificationStorage: null,
    verificationSampler: null,
    getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
    getMux: vi.fn(() => proxyMux as any),
    getVerificationMux: vi.fn(() => ({} as any)),
    registerPaymentMux: vi.fn(),
    workerE2E: new NodeWorkerE2EClient(buyer, {
      requireAttestedWorkers: opts.requireAttested === true,
      requireAppleVerifiedWorkers: opts.requireApple === true,
      deviceAttestationRoots: [(opts.appleCa ?? appleCa).rootPem],
      ...(opts.now ? { now: opts.now } : {}),
    }),
  });
  const deliveries = () => (payments?.calls ?? [])
    .filter((call) => call.method === 'recordWorkerAttribution' || call.method === 'recordWorkerDelivery')
    .map((call) => call.method === 'recordWorkerAttribution' ? 'assigned' : call.args[1] === null ? 'failed' : call.args[1]);
  return { handler, wire, assigned, workers, deliveries };
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
      expect(JSON.parse(dec(req.body))).toMatchObject({ model: 'qwen', antseed_e2e: { worker: pool.workers[0]!.wallet.address } });
    }
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

  it('takes another worker once when the pool says the assigned one is unavailable', async () => {
    const pool = fakePool({ workers: 2, unavailableOnce: true });
    const response = await pool.handler.sendRequest(peer, chatRequest('u1'));
    expect(response.statusCode).toBe(200);
    expect(pool.assigned).toHaveLength(2);
  });

  it('refuses a worker key certified for a different seller', async () => {
    const pool = fakePool({ certSeller: Wallet.createRandom().address });
    await expect(pool.handler.sendRequest(peer, chatRequest('x1'))).rejects.toThrow(/not certified for this seller/);
    expect(pool.wire.filter((req) => req.path !== WORKER_ASSIGN_PATH)).toHaveLength(0);
  });

  it('checks a forwarded attestation before encrypting, and can require a hardened Mac', async () => {
    expect((await fakePool({ attest: 'hardened', requireAttested: true }).handler.sendRequest(peer, chatRequest('a1'))).statusCode).toBe(200);
    // Valid but SIP off: fine by default, refused when the buyer requires hardened workers.
    expect((await fakePool({ attest: 'sip-off' }).handler.sendRequest(peer, chatRequest('a2'))).statusCode).toBe(200);
    await expect(fakePool({ attest: 'sip-off', requireAttested: true }).handler.sendRequest(peer, chatRequest('a3'))).rejects.toThrow(/not an attested hardened Mac/);
    await expect(fakePool({ requireAttested: true }).handler.sendRequest(peer, chatRequest('a4'))).rejects.toThrow(/not an attested hardened Mac/);
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

  it('stops using a cached assignment once its Apple attestation grows too old', async () => {
    let clock = Math.floor(Date.now() / 1000);
    // Apple's leaf is a minute short of the 26-hour limit when the buyer first uses it.
    const pool = fakePool({ attest: 'hardened', device: 'apple', now: () => clock, deviceNotBefore: new Date((clock - 26 * 3600 + 60) * 1000) });
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
    const retried = fakePool({ payments: true, workers: 2, unavailableOnce: true });
    await retried.handler.sendRequest(peer, chatRequest('v5'));
    expect(retried.deliveries()).toEqual(['assigned', 'failed', 'assigned', { inputTokens: 10n, cachedInputTokens: 0n, outputTokens: 5n }]);
  });
});
