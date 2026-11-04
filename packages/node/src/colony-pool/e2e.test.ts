import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  generateWorkerEncryptionKey,
  isSealedRequest,
  openRequest,
  ResponseOpener,
  sealRequest,
  verifyWorkerAttestation,
  verifyWorkerKeyCertificate,
  workerAttestationMessage,
  workerKeyCertificateMessage,
  workerKeyHex,
  type WorkerAttestation,
  type WorkerKeyCertificate,
} from './e2e.js';
import { generateKeyPairSync, sign } from 'node:crypto';

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const POOL = '0x00000000000000000000000000000000000000aa';
const CHANNEL = `0x${'ab'.repeat(32)}`;

function setup() {
  const worker = Wallet.createRandom();
  const key = generateWorkerEncryptionKey();
  const buyer = Wallet.createRandom();
  const binding = { address: buyer.address, channel: CHANNEL, signMessage: (m: Uint8Array) => buyer.signMessageSync(m) };
  return { worker, key, buyer, binding };
}

describe('worker end-to-end encryption', async () => {
  it('round-trips a request and binds it to the buyer and channel', async () => {
    const { worker, key, buyer, binding } = setup();
    const body = enc({ model: 'qwen', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'secret prompt' }] });
    const sealed = await sealRequest({ body, worker: worker.address, workerKey: key.publicKey, buyer: binding });

    expect(isSealedRequest(sealed.body)).toBe(true);
    const outer = JSON.parse(dec(sealed.body));
    expect(outer).toMatchObject({ model: 'qwen', stream: true, max_tokens: 64 });
    expect(dec(sealed.body)).not.toContain('secret prompt');

    const opened = openRequest(sealed.body, worker.address, key);
    expect(dec(opened.body)).toBe(dec(body));
    expect(opened.buyer).toBe(buyer.address);
    expect(opened.channel).toBe(CHANNEL);
  });

  it('rejects envelopes for another worker, a swapped model, or a tampered ciphertext', async () => {
    const { worker, key, binding } = setup();
    const sealed = await sealRequest({ body: enc({ model: 'qwen', messages: [] }), worker: worker.address, workerKey: key.publicKey, buyer: binding });
    expect(() => openRequest(sealed.body, Wallet.createRandom().address, key)).toThrow(/another worker/);

    const swapped = JSON.parse(dec(sealed.body));
    swapped.model = 'expensive-model';
    expect(() => openRequest(enc(swapped), worker.address, key)).toThrow();

    const tampered = JSON.parse(dec(sealed.body));
    const ct = Buffer.from(tampered.antseed_e2e.ct, 'base64');
    ct[0] ^= 1;
    tampered.antseed_e2e.ct = ct.toString('base64');
    expect(() => openRequest(enc(tampered), worker.address, key)).toThrow();

    // A key held by anyone else (e.g. the pool) cannot open it.
    expect(() => openRequest(sealed.body, worker.address, generateWorkerEncryptionKey())).toThrow();
  });

  it('treats an unsigned or forged binding as unbound', async () => {
    const { worker, key, binding } = setup();
    const unsigned = await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey });
    expect(openRequest(unsigned.body, worker.address, key).buyer).toBeNull();

    const forged = JSON.parse(dec((await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey, buyer: binding })).body));
    forged.antseed_e2e.buyer = Wallet.createRandom().address;
    expect(openRequest(enc(forged), worker.address, key).buyer).toBeNull();
  });

  it('round-trips a non-streamed response and exposes usage in the clear for metering', async () => {
    const { worker, key } = setup();
    const sealed = await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey });
    const { sealer } = openRequest(sealed.body, worker.address, key);
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    const response = sealer.sealBody(enc({ choices: [{ message: { content: 'private answer' } }], usage }));

    expect(dec(response)).not.toContain('private answer');
    expect(JSON.parse(dec(response)).usage).toEqual(usage);
    const plain = sealed.opener.openBody(response);
    expect(JSON.parse(dec(plain)).choices[0].message.content).toBe('private answer');
    expect(sealed.opener.verified).toBe(true);
    expect(sealed.opener.usage).toEqual({ authenticated: usage, clear: usage });
  });

  it('streams SSE across arbitrary chunk boundaries and verifies the end marker', async () => {
    const { worker, key } = setup();
    const sealed = await sealRequest({ body: enc({ model: 'qwen', stream: true }), worker: worker.address, workerKey: key.publicKey });
    const { sealer } = openRequest(sealed.body, worker.address, key);
    const usage = { prompt_tokens: 3, completion_tokens: 2 };
    const upstream = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    let wire = '';
    for (let i = 0; i < upstream.length; i += 7) wire += dec(sealer.pushStream(new TextEncoder().encode(upstream.slice(i, i + 7))));
    wire += dec(sealer.finishStream());
    expect(wire).not.toContain('hel');
    // The pool can meter from the clear usage line alone.
    expect(wire).toContain(JSON.stringify({ choices: [], usage }));

    let plain = '';
    for (let i = 0; i < wire.length; i += 11) plain += dec(sealed.opener.pushStream(new TextEncoder().encode(wire.slice(i, i + 11))));
    expect(plain).toBe(upstream);
    expect(sealed.opener.verified).toBe(true);
    expect(sealed.opener.usage.authenticated).toEqual(usage);
  });

  it('detects a truncated or reordered stream', async () => {
    const { worker, key } = setup();
    const sealed = await sealRequest({ body: enc({ model: 'qwen', stream: true }), worker: worker.address, workerKey: key.publicKey });
    const { sealer } = openRequest(sealed.body, worker.address, key);
    const events = dec(sealer.pushStream(new TextEncoder().encode('data: {"a":1}\n\ndata: {"b":2}\n\n'))).split('\n\n').filter(Boolean);

    // Truncated: never reaches the end marker, so it is not attributable.
    sealed.opener.pushStream(new TextEncoder().encode(`${events[0]}\n\n`));
    expect(sealed.opener.verified).toBe(false);

    const second = await sealRequest({ body: enc({ model: 'qwen', stream: true }), worker: worker.address, workerKey: key.publicKey });
    const secondSealer = openRequest(second.body, worker.address, key).sealer;
    const reordered = dec(secondSealer.pushStream(new TextEncoder().encode('data: {"a":1}\n\ndata: {"b":2}\n\n'))).split('\n\n').filter(Boolean);
    expect(() => second.opener.pushStream(new TextEncoder().encode(`${reordered[1]}\n\n`))).toThrow(/out of order/);
  });

  it('seals each answer to a replayed request under its own salt and key', async () => {
    const { worker, key } = setup();
    const sealed = await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey });
    // The pool replays the same ciphertext to the worker twice; the answers differ.
    const first = openRequest(sealed.body, worker.address, key).sealer.sealBody(enc({ answer: 'first' }));
    const second = openRequest(sealed.body, worker.address, key).sealer.sealBody(enc({ answer: 'second' }));
    const envelope = (bytes: Uint8Array) => JSON.parse(dec(bytes)).antseed_e2e as { salt: string; ct: string };
    expect(envelope(first).salt).not.toBe(envelope(second).salt);

    // Same nonce (seq 0) and similar plaintext under one key would leak their XOR; under two keys it doesn't.
    const ct1 = Buffer.from(envelope(first).ct, 'base64');
    const ct2 = Buffer.from(envelope(second).ct, 'base64');
    const xor = ct1.subarray(0, 12).map((byte, i) => byte ^ ct2[i]!);
    const plainXor = Buffer.from('{"answer":"f').map((byte, i) => byte ^ Buffer.from('{"answer":"s')[i]!);
    expect(Buffer.from(xor).equals(Buffer.from(plainXor))).toBe(false);

    const base = (sealed.opener as unknown as { base: Buffer }).base;
    expect(JSON.parse(dec(new ResponseOpener(base).openBody(first)))).toEqual({ answer: 'first' });
    expect(JSON.parse(dec(new ResponseOpener(base).openBody(second)))).toEqual({ answer: 'second' });
  });

  it('rejects a response without its salt', async () => {
    const { worker, key } = setup();
    const sealed = await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey });
    const response = JSON.parse(dec(openRequest(sealed.body, worker.address, key).sealer.sealBody(enc({ answer: 1 }))));
    delete response.antseed_e2e.salt;
    expect(() => sealed.opener.openBody(enc(response))).toThrow(/salt/);
  });

  it('keeps multi-byte characters intact when a chunk splits them at any byte', async () => {
    const upstream = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'שלום 🐜 naïve 日本' } }] })}\n\ndata: [DONE]\n\n`);
    for (let cut = 1; cut < upstream.length; cut++) {
      const { worker, key } = setup();
      const sealed = await sealRequest({ body: enc({ model: 'qwen', stream: true }), worker: worker.address, workerKey: key.publicKey });
      const { sealer } = openRequest(sealed.body, worker.address, key);
      const wire = Buffer.concat([sealer.pushStream(upstream.subarray(0, cut)), sealer.pushStream(upstream.subarray(cut)), sealer.finishStream()]);
      const plain = Buffer.concat([sealed.opener.pushStream(wire.subarray(0, cut)), sealed.opener.pushStream(wire.subarray(cut))]);
      expect(plain.equals(Buffer.from(upstream))).toBe(true);
      expect(sealed.opener.verified).toBe(true);
    }
  });

  it('passes through bodies the pool itself returned', async () => {
    const { worker, key } = setup();
    const sealed = await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey });
    const poolError = enc({ error: { message: 'No worker is available', type: 'colony_pool_error' } });
    expect(sealed.opener.openBody(poolError)).toBe(poolError);
    expect(sealed.opener.verified).toBe(false);
  });

  it('verifies key certificates for the right pool only, until they expire', async () => {
    const { worker, key } = setup();
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const keyHex = workerKeyHex(key.publicKey);
    const cert: WorkerKeyCertificate = {
      worker: worker.address,
      key: keyHex,
      expires,
      pool: POOL,
      certificate: worker.signMessageSync(workerKeyCertificateMessage(POOL, keyHex, expires)),
    };
    expect(verifyWorkerKeyCertificate(cert, POOL)).toBe(true);
    expect(verifyWorkerKeyCertificate(cert, Wallet.createRandom().address)).toBe(false);
    expect(verifyWorkerKeyCertificate(cert, POOL, expires)).toBe(false);
    expect(verifyWorkerKeyCertificate({ ...cert, key: workerKeyHex(generateWorkerEncryptionKey().publicKey) }, POOL)).toBe(false);
    expect(verifyWorkerKeyCertificate({ ...cert, worker: Wallet.createRandom().address }, POOL)).toBe(false);
  });
});

describe('worker attestations', () => {
  function attestedWorker(overrides: Partial<WorkerAttestation> = {}) {
    const worker = Wallet.createRandom();
    const key = workerKeyHex(generateWorkerEncryptionKey().publicKey);
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const attestationKey = `04${Buffer.from(jwk.x!, 'base64url').toString('hex')}${Buffer.from(jwk.y!, 'base64url').toString('hex')}`;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const cert: WorkerKeyCertificate = {
      worker: worker.address, key, expires, pool: POOL, attestationKey,
      certificate: worker.signMessageSync(workerKeyCertificateMessage(POOL, key, expires, attestationKey)),
    };
    const statement = {
      v: 1 as const, teamId: 'H3M5BXXQR2', signingId: 'com.antseed.macworker', cdhash: 'ab'.repeat(20),
      sip: true, hardenedRuntime: true, debuggerDenied: true, keyAppBound: true, os: 'macOS 26.2', serial: 'C02TEST0MD6T', udid: '00000000-0000-1000-8000-0123456789AB',
      issued: Math.floor(Date.now() / 1000), nonce: 'n1', ...overrides,
    };
    const signature = sign('sha256', Buffer.from(workerAttestationMessage(worker.address, key, statement)), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
    return { cert, attestation: { ...statement, signature } as WorkerAttestation };
  }

  it('verifies a hardened attestation bound to the certificate', () => {
    const { cert, attestation } = attestedWorker();
    expect(verifyWorkerKeyCertificate(cert, POOL)).toBe(true);
    expect(verifyWorkerAttestation(attestation, cert, { nonce: 'n1', maxAgeS: 60 })).toEqual({ valid: true, hardened: true });
    expect(verifyWorkerAttestation(attestation, cert, { maxAgeS: 60, teams: new Set(['OTHERTEAM']) }).hardened).toBe(false);
  });

  it('reports valid but not hardened when SIP is off or the build is unsigned', () => {
    const sipOff = attestedWorker({ sip: false });
    expect(verifyWorkerAttestation(sipOff.attestation, sipOff.cert, { maxAgeS: 60 })).toEqual({ valid: true, hardened: false });
    const adhoc = attestedWorker({ teamId: null, hardenedRuntime: false });
    expect(verifyWorkerAttestation(adhoc.attestation, adhoc.cert, { maxAgeS: 60 })).toEqual({ valid: true, hardened: false });
  });

  it('rejects a tampered, stale, replayed, or rebound attestation', () => {
    const { cert, attestation } = attestedWorker();
    expect(verifyWorkerAttestation({ ...attestation, sip: false }, cert, { maxAgeS: 60 }).valid).toBe(false);
    expect(verifyWorkerAttestation(attestation, cert, { nonce: 'other', maxAgeS: 60 }).valid).toBe(false);
    expect(verifyWorkerAttestation(attestation, cert, { maxAgeS: 60, now: attestation.issued + 61 }).valid).toBe(false);
    // Another worker's certificate (e.g. the pool swapping attestations between workers).
    expect(verifyWorkerAttestation(attestation, attestedWorker().cert, { maxAgeS: 60 }).valid).toBe(false);
    // A certificate whose attestation key was swapped no longer verifies.
    expect(verifyWorkerKeyCertificate({ ...cert, attestationKey: attestedWorker().cert.attestationKey }, POOL)).toBe(false);
  });
});
