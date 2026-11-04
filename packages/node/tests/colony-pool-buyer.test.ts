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
  capabilities: [WORKER_E2E_CAPABILITY],
};
const SELLER = `0x${'a'.repeat(40)}`;

function chatRequest(requestId: string, stream = false): SerializedHttpRequest {
  return {
    requestId,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: enc({ model: 'qwen', stream, messages: [{ role: 'user', content: PROMPT }] }),
  };
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

function deviceAttestation(kind: Device, worker: string, attestationKey: string) {
  const challenge = 'mdm-challenge';
  return {
    challenge,
    chain: appleCa.issue({
      serialNumber: kind === 'other-mac' ? 'SOMEONEELSE1' : 'C02TEST0MD6T',
      udid: '00000000-0000-1000-8000-0123456789AB',
      nonce: deviceAttestationNonce(worker, attestationKey, challenge),
      sip: kind !== 'apple-sip-off',
    }),
  };
}

function fakePool(opts: { workers?: number; certSeller?: string; unavailableOnce?: boolean; tamper?: 'ciphertext' | 'usage'; attest?: Attest; requireAttested?: boolean; device?: Device; requireApple?: boolean } = {}) {
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
          ...(attested && opts.device ? { deviceAttestation: deviceAttestation(opts.device, worker.wallet.address, attested.attestationKey) } : {}),
        });
        return;
      }
      const envelope = JSON.parse(dec(req.body)).antseed_e2e as { worker: string };
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
        onResponse({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'text/event-stream', [ANTSEED_STREAMING_RESPONSE_HEADER]: '1' }, body: new Uint8Array() }, { streamingStart: true });
        const upstream = `data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
        const sealed = Buffer.concat([opened.sealer.pushStream(enc(upstream).subarray(0, 0)), opened.sealer.pushStream(new TextEncoder().encode(upstream)), opened.sealer.finishStream()]);
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
  const handler = new BuyerRequestHandler({}, {
    localPeerId: buyer.address.slice(2).toLowerCase() as PeerInfo['peerId'],
    negotiator: null,
    verificationStorage: null,
    verificationSampler: null,
    getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
    getMux: vi.fn(() => proxyMux as any),
    getVerificationMux: vi.fn(() => ({} as any)),
    registerPaymentMux: vi.fn(),
    workerE2E: new NodeWorkerE2EClient(buyer, {
      requireAttestedWorkers: opts.requireAttested === true,
      requireAppleVerifiedWorkers: opts.requireApple === true,
      deviceAttestationRoots: [appleCa.rootPem],
    }),
  });
  return { handler, wire, assigned, workers };
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

  it('fails a response whose ciphertext does not verify', async () => {
    const pool = fakePool({ tamper: 'ciphertext' });
    await expect(pool.handler.sendRequest(peer, chatRequest('t1'))).rejects.toThrow(/failed verification/);
  });

  it('fails a response whose billed usage differs from the worker\'s sealed usage', async () => {
    const pool = fakePool({ tamper: 'usage' });
    await expect(pool.handler.sendRequest(peer, chatRequest('t2'))).rejects.toThrow(/failed verification/);
  });

  it('leaves sellers without the capability untouched', async () => {
    const pool = fakePool();
    const plainPeer = { ...peer, capabilities: [] };
    await expect(pool.handler.sendRequest(plainPeer, chatRequest('p1'))).rejects.toThrow();
    expect(dec(pool.wire[0]!.body)).toContain(PROMPT);
  });
});
