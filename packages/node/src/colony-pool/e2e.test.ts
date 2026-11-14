import { concat, getBytes, keccak256, toBeHex, toUtf8Bytes, Wallet, zeroPadValue } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  generateWorkerEncryptionKey,
  inspectRequest,
  isSealedRequest,
  isWorkerAttestation,
  modelFilesDigest,
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
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

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
    expect(() => openRequest(sealed.body, Wallet.createRandom().address, key)).toThrow(/addressed to other workers/);

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

  it('binds only a 32-byte channel, so one on-chain channel never appears under two keys', async () => {
    const { worker, key, buyer, binding } = setup();
    const sealed = JSON.parse(dec((await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey, buyer: binding })).body));
    // The buyer signs the same binding over the channel with a byte appended (the Mac app once read the first 32 on-chain).
    const longer = `${CHANNEL}00`;
    const ct = Buffer.from(sealed.antseed_e2e.ct, 'base64');
    const hash = keccak256(concat([toUtf8Bytes('antseed-worker-e2e/v2'), worker.address, longer, zeroPadValue(toBeHex(sealed.antseed_e2e.exp), 8), keccak256(ct)]));
    sealed.antseed_e2e.channel = longer;
    sealed.antseed_e2e.sig = buyer.signMessageSync(getBytes(hash));
    expect(inspectRequest(enc(sealed), worker.address).binding).toBeNull();
    // Upper-case hex names the same channel as lower-case.
    const upper = JSON.parse(dec((await sealRequest({ body: enc({ model: 'qwen' }), worker: worker.address, workerKey: key.publicKey, buyer: { ...binding, channel: `0x${'AB'.repeat(32)}` } })).body));
    expect(inspectRequest(enc(upper), worker.address).binding?.channel).toBe(CHANNEL);
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

    const bases = (sealed.opener as unknown as { bases: Map<string, Buffer> }).bases;
    expect(JSON.parse(dec(new ResponseOpener(bases).openBody(first)))).toEqual({ answer: 'first' });
    expect(JSON.parse(dec(new ResponseOpener(bases).openBody(second)))).toEqual({ answer: 'second' });
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

  it('signs the models it attests, sorted by service, and leaves the message unchanged without them', () => {
    const models = { zeta: { model: 'org/z@1', sha256: 'cd'.repeat(32) }, alpha: { model: 'org/a@2', sha256: 'ab'.repeat(32) } };
    const { cert, attestation } = attestedWorker({ models });
    expect(isWorkerAttestation(attestation)).toBe(true);
    expect(verifyWorkerAttestation(attestation, cert, { maxAgeS: 60 }).valid).toBe(true);
    const message = workerAttestationMessage(cert.worker, cert.key, attestation);
    expect(message).toContain(`\nmodels:alpha=org/a@2#${'ab'.repeat(32)},zeta=org/z@1#${'cd'.repeat(32)}\nissued:`);
    // Other files, or dropping the models, breaks the signature.
    expect(verifyWorkerAttestation({ ...attestation, models: { ...models, alpha: { model: 'org/a@2', sha256: 'ef'.repeat(32) } } }, cert, { maxAgeS: 60 }).valid).toBe(false);
    expect(verifyWorkerAttestation({ ...attestation, models: undefined }, cert, { maxAgeS: 60 }).valid).toBe(false);
    const { models: _models, ...without } = attestation;
    expect(workerAttestationMessage(cert.worker, cert.key, { ...without, models: {} })).toBe(workerAttestationMessage(cert.worker, cert.key, without));
    expect(workerAttestationMessage(cert.worker, cert.key, without)).not.toContain('models:');
    for (const bad of [{ a: { model: 'org/a', sha256: 'ab'.repeat(32) } }, { a: { model: 'org/a@1', sha256: 'AB'.repeat(32) } }, { 'a,b': { model: 'org/a@1', sha256: 'ab'.repeat(32) } }, { a: 'org/a@1' }]) {
      expect(isWorkerAttestation({ ...attestation, models: bad })).toBe(false);
    }
  });

  it('digests a checkpoint\'s files as shasum lists them, sorted bytewise by path', () => {
    const files = [{ path: './model.safetensors', sha256: '11'.repeat(32) }, { path: './Config.json', sha256: '22'.repeat(32) }, { path: './config.json', sha256: '33'.repeat(32) }];
    // printf '%s  ./Config.json\n%s  ./config.json\n%s  ./model.safetensors\n' 22… 33… 11… | shasum -a 256
    const listing = `${'22'.repeat(32)}  ./Config.json\n${'33'.repeat(32)}  ./config.json\n${'11'.repeat(32)}  ./model.safetensors\n`;
    expect(modelFilesDigest(files)).toBe(createHash('sha256').update(listing).digest('hex'));
    expect(modelFilesDigest([...files].reverse())).toBe(modelFilesDigest(files));
  });

});

describe('worker end-to-end encryption for several recipients', () => {
  function recipients(n: number) {
    return Array.from({ length: n }, () => ({ wallet: Wallet.createRandom(), key: generateWorkerEncryptionKey() }));
  }
  const sealFor = (workers: ReturnType<typeof recipients>, binding?: Parameters<typeof sealRequest>[0]['buyer'], body = enc({ model: 'qwen', messages: [{ role: 'user', content: 'secret prompt' }] })) =>
    sealRequest({ body, recipients: workers.map((w) => ({ worker: w.wallet.address, key: w.key.publicKey })), ...(binding ? { buyer: binding } : {}) });

  it('lets each recipient open the request, bound to the buyer, and answer under its own key', async () => {
    const { binding, buyer } = setup();
    const workers = recipients(3);
    const sealed = await sealFor(workers, binding);
    const outer = JSON.parse(dec(sealed.body));
    expect(outer.antseed_e2e.recipients.map((r: { worker: string }) => r.worker)).toEqual(workers.map((w) => w.wallet.address));
    expect(dec(sealed.body)).not.toContain('secret prompt');
    for (const worker of workers) {
      const opened = openRequest(sealed.body, worker.wallet.address, worker.key);
      expect(dec(opened.body)).toContain('secret prompt');
      expect(opened.buyer).toBe(buyer.address);
      expect(opened.recipients).toEqual(workers.map((w) => w.wallet.address));
    }
    // The second recipient answers: the buyer opens it and knows who answered.
    const answer = openRequest(sealed.body, workers[1]!.wallet.address, workers[1]!.key).sealer.sealBody(enc({ answer: 'two', usage: { completion_tokens: 3 } }));
    expect(JSON.parse(dec(sealed.opener.openBody(answer)))).toEqual({ answer: 'two', usage: { completion_tokens: 3 } });
    expect(sealed.opener.verified).toBe(true);
    expect(sealed.opener.worker).toBe(workers[1]!.wallet.address);
  });

  it('streams an answer from any recipient and names it', async () => {
    const workers = recipients(2);
    const sealed = await sealFor(workers, undefined, enc({ model: 'qwen', stream: true }));
    const { sealer } = openRequest(sealed.body, workers[1]!.wallet.address, workers[1]!.key);
    const wire = Buffer.concat([sealer.pushStream(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')), sealer.finishStream()]);
    expect(sealed.opener.worker).toBeNull();
    expect(dec(sealed.opener.pushStream(wire))).toContain('"hi"');
    expect(sealed.opener.verified).toBe(true);
    expect(sealed.opener.worker).toBe(workers[1]!.wallet.address);
  });

  it('refuses a worker the envelope does not name', async () => {
    const workers = recipients(2);
    const outsider = recipients(1)[0]!;
    const sealed = await sealFor(workers);
    expect(() => openRequest(sealed.body, outsider.wallet.address, outsider.key)).toThrow(/addressed to other workers/);
    // Nor can it pass for a recipient with its own key.
    expect(() => openRequest(sealed.body, workers[0]!.wallet.address, outsider.key)).toThrow();
  });

  it('fails an answer one recipient seals and labels as another\'s', async () => {
    const workers = recipients(2);
    const sealed = await sealFor(workers);
    const forged = JSON.parse(dec(openRequest(sealed.body, workers[1]!.wallet.address, workers[1]!.key).sealer.sealBody(enc({ answer: 'mine' }))));
    forged.antseed_e2e.worker = workers[0]!.wallet.address;
    expect(() => sealed.opener.openBody(enc(forged))).toThrow();
    expect(sealed.opener.verified).toBe(false);
    // Naming a worker the request was not encrypted for is refused outright.
    forged.antseed_e2e.worker = Wallet.createRandom().address;
    expect(() => sealed.opener.openBody(enc(forged))).toThrow(/not encrypted for/);
  });

  it('binds the ciphertext and the buyer\'s signature to the ordered recipient list', async () => {
    const { binding } = setup();
    const workers = recipients(2);
    const sealed = await sealFor(workers, binding);
    const reordered = JSON.parse(dec(sealed.body));
    reordered.antseed_e2e.recipients.reverse();
    expect(() => openRequest(enc(reordered), workers[0]!.wallet.address, workers[0]!.key)).toThrow();
    // Dropping a recipient changes the list too: the request no longer opens.
    const dropped = JSON.parse(dec(sealed.body));
    dropped.antseed_e2e.recipients = dropped.antseed_e2e.recipients.slice(0, 1);
    expect(() => openRequest(enc(dropped), workers[0]!.wallet.address, workers[0]!.key)).toThrow();
    // An envelope naming a worker twice is refused.
    const twice = JSON.parse(dec(sealed.body));
    twice.antseed_e2e.recipients[1] = twice.antseed_e2e.recipients[0];
    expect(() => openRequest(enc(twice), workers[0]!.wallet.address, workers[0]!.key)).toThrow(/twice/);
  });

  it('takes one to three distinct recipients', async () => {
    await expect(sealFor(recipients(4))).rejects.toThrow(/1 to 3/);
    await expect(sealFor([])).rejects.toThrow(/1 to 3/);
    const one = recipients(1);
    await expect(sealFor([one[0]!, one[0]!])).rejects.toThrow(/distinct/);
  });
});
