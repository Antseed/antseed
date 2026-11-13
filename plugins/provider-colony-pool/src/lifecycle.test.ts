import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBytes, Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { signTestWorkerPayment } from '@antseed/node/worker-e2e/testing';
import { generateWorkerEncryptionKey, requestBindingHash, sealRequest, workerKeyHex, type WorkerEncryptionKey, type WorkerPayment } from '@antseed/node/worker-e2e';
import { WorkerLedger } from './ledger.js';
import { ColonyPool } from './pool.js';
import { COLONY_POOL_PROTOCOL_VERSION, encodeBody } from './protocol.js';
import { ColonyPoolProvider } from './provider.js';
import { PoolWorker, trustedChannelVerifier, type ChannelVerifier } from './worker.js';

const SERVICE = 'qwen3-30b-a3b';
const SELLER = '0x00000000000000000000000000000000000000aa';
const CHANNEL = `0x${'cd'.repeat(32)}`;
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Upstream {
  url: string;
  server: Server;
  bodies: Array<Record<string, unknown>>;
  /** Requests the model is working on right now, and the most at once. */
  active: number;
  peak: number;
  aborted: number;
}

/** A local model server whose answer `handler` writes. */
async function startUpstream(handler: (body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) => void | Promise<void>): Promise<Upstream> {
  const upstream: Upstream = { url: '', server: createServer(), bodies: [], active: 0, peak: 0, aborted: 0 };
  upstream.server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      upstream.bodies.push(body);
      upstream.active++;
      upstream.peak = Math.max(upstream.peak, upstream.active);
      res.on('close', () => {
        upstream.active--;
        if (!res.writableEnded) upstream.aborted++;
      });
      void handler(body, res, req);
    });
  });
  await new Promise<void>((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  upstream.url = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;
  return upstream;
}

function answer(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ready' } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
}

/** A pool stand-in: drives one worker frame by frame. */
async function startFakePool() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const frames: Array<Record<string, unknown>> = [];
  let socket: WebSocket | null = null;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame['t'] === 'hello') {
        ws.send(JSON.stringify({ t: 'welcome', workerId: frame['address'], accepted: frame['services'], rejected: [], workerShareBps: 9000, prices: Object.fromEntries((frame['services'] as string[]).map((service) => [service, { inputUsdPerMillion: 1, outputUsdPerMillion: 4 }])) }));
      }
    });
    ws.send(JSON.stringify({ t: 'challenge', version: COLONY_POOL_PROTOCOL_VERSION, pool: 'fake', nonce: 'ab'.repeat(32), seller: SELLER }));
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    frames,
    send: (frame: unknown) => socket!.send(JSON.stringify(frame)),
    errorFor: (id: string) => frames.find((f) => f['t'] === 'response-error' && f['id'] === id)?.['message'] as string | undefined,
    ended: (id: string) => frames.some((f) => f['t'] === 'response-end' && f['id'] === id),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('worker lifecycle', () => {
  let fakePool: Awaited<ReturnType<typeof startFakePool>>;
  let upstream: Upstream | null = null;
  let worker: PoolWorker | null = null;
  let key: WorkerEncryptionKey;
  const buyer = Wallet.createRandom();

  function start(opts: { channelVerifier?: ChannelVerifier; channelsDomain?: { chainId: number; channelsAddress: string }; maxConcurrency?: number; upstreamIdleMs?: number; upstreamTimeoutMs?: number; channelWaitMs?: number; poolSilenceMs?: number } = {}): PoolWorker {
    key = generateWorkerEncryptionKey();
    worker = new PoolWorker({
      poolUrl: fakePool.url,
      baseUrl: upstream!.url,
      services: { [SERVICE]: 'local' },
      privateKey: Wallet.createRandom().privateKey,
      encryptionKey: key,
      channelVerifier: async () => true, // no chain in these tests; tests that check channels pass their own
      ...opts,
    });
    worker.start();
    return worker;
  }

  /** Send the worker a sealed request, bound to a buyer's channel unless `unbound`. */
  async function request(id: string, opts: { unbound?: boolean; content?: string; stream?: boolean; payment?: WorkerPayment } = {}): Promise<void> {
    const body = enc({ model: SERVICE, stream: opts.stream ?? false, messages: [{ role: 'user', content: opts.content ?? 'hi' }] });
    const target = { worker: worker!.address, workerKey: workerKeyHex(key.publicKey) };
    const sealed = opts.unbound
      ? await sealRequest({ body, ...target })
      : await sealRequest({ body, ...target, buyer: { address: buyer.address, channel: CHANNEL, ...(opts.payment ? { payment: opts.payment } : {}), signMessage: (m) => buyer.signMessage(m) } });
    fakePool.send({ t: 'request', id, method: 'POST', path: '/v1/chat/completions', headers: {}, body: encodeBody(sealed.body) });
  }

  beforeEach(async () => {
    fakePool = await startFakePool();
  });

  afterEach(async () => {
    worker?.stop();
    worker = null;
    await fakePool.close();
    if (upstream) await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
    upstream?.server.closeAllConnections();
    upstream = null;
  });

  it('sends accepted once a request passes its channel check, before the model answers, and never for a refused one', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    let settle: (verdict: boolean | null) => void = () => {};
    start({ channelVerifier: () => new Promise((resolve) => { settle = resolve; }) });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('a1');
    await sleep(100);
    // Still checking the channel: not taken yet.
    expect(fakePool.frames.some((f) => f['t'] === 'accepted')).toBe(false);
    settle(true);
    await waitFor(() => fakePool.ended('a1'));
    const order = fakePool.frames.filter((f) => f['id'] === 'a1').map((f) => f['t']);
    expect(order.slice(0, 2)).toEqual(['accepted', 'response-start']);
    // A refused channel is never accepted.
    worker!.stop();
    start({ channelVerifier: async () => false });
    await waitFor(() => fakePool.frames.filter((f) => f['t'] === 'hello').length >= 2);
    await request('a2');
    await waitFor(() => fakePool.errorFor('a2') !== undefined);
    expect(fakePool.frames.some((f) => f['t'] === 'accepted' && f['id'] === 'a2')).toBe(false);
  });

  it('serves a request it is one of several recipients of, and refuses one that does not name it', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start({ channelVerifier: async () => true });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    const other = generateWorkerEncryptionKey();
    const otherAddress = Wallet.createRandom().address;
    const body = enc({ model: SERVICE, messages: [{ role: 'user', content: 'hi' }] });
    const binding = { address: buyer.address, channel: CHANNEL, signMessage: (m: Uint8Array) => buyer.signMessage(m) };
    const both = await sealRequest({ body, recipients: [{ worker: otherAddress, key: other.publicKey }, { worker: worker!.address, key: key.publicKey }], buyer: binding });
    fakePool.send({ t: 'request', id: 'm1', method: 'POST', path: '/v1/chat/completions', headers: {}, body: encodeBody(both.body) });
    await waitFor(() => fakePool.ended('m1'));
    // Its answer is sealed under its own key and names it.
    const chunks = fakePool.frames.filter((f) => f['t'] === 'response-chunk' && f['id'] === 'm1').map((f) => Buffer.from(f['data'] as string, 'base64'));
    both.opener.openBody(Buffer.concat(chunks));
    expect(both.opener.worker?.toLowerCase()).toBe(worker!.address.toLowerCase());
    const notMine = await sealRequest({ body, recipients: [{ worker: otherAddress, key: other.publicKey }], buyer: binding });
    fakePool.send({ t: 'request', id: 'm2', method: 'POST', path: '/v1/chat/completions', headers: {}, body: encodeBody(notMine.body) });
    await waitFor(() => fakePool.errorFor('m2') !== undefined);
    expect(fakePool.errorFor('m2')).toMatch(/could not be decrypted/);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('serves a buyer\'s signed request once, whatever dispatch ID the pool sends it under, and never after it expires', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start();
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    const body = enc({ model: SERVICE, messages: [{ role: 'user', content: 'hi' }] });
    const target = { worker: worker!.address, workerKey: workerKeyHex(key.publicKey) };
    const seal = (expires?: number) => sealRequest({ body, ...target, buyer: { address: buyer.address, channel: CHANNEL, expires, signMessage: (m) => buyer.signMessage(m) } });
    const send = (id: string, sealed: { body: Uint8Array }) => fakePool.send({ t: 'request', id, method: 'POST', path: '/v1/chat/completions', headers: {}, body: encodeBody(sealed.body) });
    const once = await seal();
    send('r1', once);
    await waitFor(() => fakePool.ended('r1'));
    send('r2', once);
    await waitFor(() => fakePool.errorFor('r2') !== undefined);
    expect(fakePool.errorFor('r2')).toMatch(/already served/);
    const now = Math.floor(Date.now() / 1000);
    send('r3', await seal(now - 1));
    await waitFor(() => fakePool.errorFor('r3') !== undefined);
    expect(fakePool.errorFor('r3')).toMatch(/expired/);
    // An expiry far ahead would make the worker remember it for that long.
    send('r4', await seal(now + 24 * 60 * 60));
    await waitFor(() => fakePool.errorFor('r4') !== undefined);
    expect(fakePool.errorFor('r4')).toMatch(/too far ahead/);
    expect(upstream.bodies).toHaveLength(1);
  });

  it('drops a request cancelled while its channel check is pending, before it reaches the model', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    let settle: (verdict: boolean) => void = () => {};
    start({ channelVerifier: () => new Promise((resolve) => { settle = resolve; }) });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('c1');
    await sleep(100);
    fakePool.send({ t: 'cancel', id: 'c1' });
    await waitFor(() => fakePool.errorFor('c1') !== undefined);
    expect(fakePool.errorFor('c1')).toBe('cancelled');
    settle(true);
    await sleep(100);
    expect(upstream.bodies).toHaveLength(0);
  });

  it('drops a request whose worker stops while its channel check is pending', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    let settle: (verdict: boolean) => void = () => {};
    const w = start({ channelVerifier: () => new Promise((resolve) => { settle = resolve; }) });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('s1');
    await sleep(100);
    w.stop();
    settle(true);
    await sleep(200);
    expect(upstream.bodies).toHaveLength(0);
  });

  it('refuses requests beyond its own concurrency, counting ones waiting on a channel check', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    let settle: (verdict: boolean) => void = () => {};
    const verdict = new Promise<boolean>((resolve) => { settle = resolve; });
    start({ maxConcurrency: 1, channelVerifier: () => verdict });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('k1');
    await request('k2');
    await request('k3', { unbound: true });
    await waitFor(() => fakePool.errorFor('k2') !== undefined && fakePool.errorFor('k3') !== undefined);
    expect(fakePool.errorFor('k2')).toBe('Worker is at capacity');
    expect(fakePool.errorFor('k3')).toBe('Worker is at capacity');
    settle(true);
    await waitFor(() => fakePool.ended('k1'));
    expect(upstream.bodies).toHaveLength(1);
    // The slot is free again.
    await request('k4');
    await waitFor(() => fakePool.ended('k4'));
  });

  it('refuses a large unbound check before it reaches the model', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start();
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('big', { unbound: true, content: 'x'.repeat(64 * 1024) });
    await waitFor(() => fakePool.errorFor('big') !== undefined);
    expect(fakePool.errorFor('big')).toMatch(/limited to 8192 bytes/);
    await request('small', { unbound: true });
    await waitFor(() => fakePool.ended('small'));
    expect(upstream.bodies).toHaveLength(1);
    expect(upstream.bodies[0]!['max_tokens']).toBe(16);
  });

  it('refuses buyer requests without a channel verifier and still runs pool checks', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start({ channelVerifier: undefined });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    // A correctly signed binding proves a key, not a payment: never full inference unverified.
    await request('nv1');
    await waitFor(() => fakePool.errorFor('nv1') !== undefined);
    expect(fakePool.errorFor('nv1')).toMatch(/no channel verifier/);
    expect(fakePool.frames.some((f) => f['t'] === 'accepted' && f['id'] === 'nv1')).toBe(false);
    await request('nv2', { unbound: true });
    await waitFor(() => fakePool.ended('nv2'));
    expect(upstream.bodies).toHaveLength(1);
    expect(upstream.bodies[0]!['max_tokens']).toBe(16);
  });

  it('gives up on a local model that stops sending mid-stream', async () => {
    upstream = await startUpstream((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`);
      // …and nothing more.
    });
    start({ upstreamIdleMs: 200 });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('i1', { stream: true });
    await waitFor(() => fakePool.errorFor('i1') !== undefined);
    expect(fakePool.errorFor('i1')).toBe('Local model timed out');
    await waitFor(() => upstream!.aborted === 1);
  });

  it('reads channels only through the trusted Channels contract', async () => {
    const reads: string[] = [];
    const sessions: Record<string, { buyer: string; seller: string; status: number; deposit: bigint }> = {
      [`0x${'01'.repeat(32)}`]: { buyer: buyer.address, seller: SELLER, status: 1, deposit: 1_000_000n },
      [`0x${'02'.repeat(32)}`]: { buyer: buyer.address, seller: '0x00000000000000000000000000000000000000bb', status: 1, deposit: 1_000_000n },
      [`0x${'03'.repeat(32)}`]: { buyer: '0x0000000000000000000000000000000000000000', seller: '0x0000000000000000000000000000000000000000', status: 0, deposit: 1_000_000n },
      [`0x${'04'.repeat(32)}`]: { buyer: buyer.address, seller: SELLER, status: 2, deposit: 1_000_000n }, // settled
      [`0x${'05'.repeat(32)}`]: { buyer: buyer.address, seller: SELLER, status: 3, deposit: 1_000_000n }, // timed out
    };
    const verifier = trustedChannelVerifier(async (channel) => { reads.push(channel); return sessions[channel]!; });
    expect(await verifier(`0x${'01'.repeat(32)}`, buyer.address.toLowerCase(), SELLER)).toEqual({ deposit: 1_000_000n });
    // The pool's own seller address must be the channel's seller on the trusted contract.
    expect(await verifier(`0x${'02'.repeat(32)}`, buyer.address, SELLER)).toBe(false);
    expect(await verifier(`0x${'03'.repeat(32)}`, buyer.address, SELLER)).toBeNull();
    // A closed channel keeps its buyer and seller but is no longer active.
    expect(await verifier(`0x${'04'.repeat(32)}`, buyer.address, SELLER)).toBe('closed');
    expect(await verifier(`0x${'05'.repeat(32)}`, buyer.address, SELLER)).toBe('closed');
    expect(reads).toHaveLength(5);
  });

  it('reconnects when the pool goes silent without closing', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start({ poolSilenceMs: 300 });
    await waitFor(() => fakePool.frames.filter((f) => f['t'] === 'hello').length === 1);
    // The fake pool never pings; after the silence the worker drops the connection and joins again.
    await waitFor(() => fakePool.frames.filter((f) => f['t'] === 'hello').length >= 2, 4_000);
  });

  it('refuses a buyer request on its clear binding before decrypting it', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    let lookups = 0;
    start({ channelVerifier: async () => { lookups++; return false; } });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    // A validly bound request whose ciphertext no key opens: refused on its channel, never decrypted.
    const target = { worker: worker!.address, workerKey: workerKeyHex(key.publicKey) };
    const sealed = await sealRequest({ body: enc({ model: SERVICE, messages: [{ role: 'user', content: 'hi' }] }), ...target });
    const outer = JSON.parse(new TextDecoder().decode(sealed.body)) as { antseed_e2e: { recipients: Array<{ worker: string }>; ct: string } & Record<string, unknown> };
    const envelope = outer.antseed_e2e;
    const ct = Buffer.from(envelope.ct, 'base64');
    ct[0] ^= 0xff;
    envelope.ct = ct.toString('base64');
    const exp = Math.floor(Date.now() / 1000) + 300;
    const hash = requestBindingHash(envelope.recipients.map((r) => r.worker), CHANNEL, exp, ct);
    Object.assign(envelope, { buyer: buyer.address, channel: CHANNEL, exp, sig: await buyer.signMessage(getBytes(hash)) });
    fakePool.send({ t: 'request', id: 'garbled', method: 'POST', path: '/v1/chat/completions', headers: {}, body: encodeBody(enc(outer)) });
    await waitFor(() => fakePool.errorFor('garbled') !== undefined);
    expect(fakePool.errorFor('garbled')).toBe('Request channel does not belong to a buyer of this pool');
    expect(lookups).toBe(1);
    expect(upstream.bodies).toHaveLength(0);
  });

  it('refuses a channel closed before its first lookup', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start({ channelVerifier: trustedChannelVerifier(async () => ({ buyer: buyer.address, seller: SELLER, status: 2 })) });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('closed');
    await waitFor(() => fakePool.errorFor('closed') !== undefined);
    expect(upstream.bodies).toHaveLength(0);
  });

  it('reads the channel again for every request and stops serving it once closed', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    let status = 1;
    let reads = 0;
    start({ channelVerifier: trustedChannelVerifier(async () => { reads++; return { buyer: buyer.address, seller: SELLER, status, deposit: 1_000_000n }; }) });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    await request('v1');
    await waitFor(() => fakePool.ended('v1'));
    await request('v2');
    await waitFor(() => fakePool.ended('v2'));
    expect(reads).toBe(2);
    status = 2; // the buyer closes the channel
    await request('v3');
    await waitFor(() => fakePool.errorFor('v3') !== undefined);
    expect(reads).toBe(3);
    // Closed for good: refused without another read.
    await request('v4');
    await waitFor(() => fakePool.errorFor('v4') !== undefined);
    expect(reads).toBe(3);
    expect(upstream.bodies).toHaveLength(2);
  });

  it('serves a buyer that never pays only two answers on a channel, and serves it again once it pays', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    const domain = { chainId: 8453, channelsAddress: '0x3000000000000000000000000000000000000003' };
    start({ channelsDomain: domain, channelVerifier: trustedChannelVerifier(async () => ({ buyer: buyer.address, seller: SELLER, status: 1, deposit: 1_000_000n })) });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    /** The buyer's SpendingAuth attributing `amount` to this worker, signed by `signer`. */
    const pay = (amount: bigint, signer: Wallet = buyer): Promise<WorkerPayment> =>
      signTestWorkerPayment({ signer, channel: CHANNEL, worker: worker!.address, amount, domain });
    // A pool operator's own buyer: fresh signed bindings on a real channel, never a payment.
    for (const id of ['p1', 'p2']) {
      await request(id);
      await waitFor(() => fakePool.ended(id));
    }
    await request('p3');
    await waitFor(() => fakePool.errorFor('p3') !== undefined);
    expect(fakePool.errorFor('p3')).toMatch(/earlier answers on this channel has not arrived/);
    // Paid by someone other than the channel's buyer: still refused, and never decrypted.
    await request('p4', { payment: await pay(18n, Wallet.createRandom()) });
    await waitFor(() => fakePool.errorFor('p4') !== undefined);
    expect(upstream.bodies).toHaveLength(2);
    // Each answer (5 in, 1 out at $1 / $4 per million) costs 9; the buyer pays for both.
    await request('p5', { payment: await pay(18n) });
    await waitFor(() => fakePool.ended('p5'));
    expect(upstream.bodies).toHaveLength(3);
  });

  it('counts only attribution the pool can still pay, and refuses a buyer once a settlement paid this worker less than signed', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    const domain = { chainId: 8453, channelsAddress: '0x3000000000000000000000000000000000000003' };
    const reads: Array<[string, string, string]> = [];
    let credit = { settled: 0n, credited: 0n };
    start({
      channelsDomain: domain,
      channelVerifier: trustedChannelVerifier(async () => ({ buyer: buyer.address, seller: SELLER, status: 1, deposit: 1_000_000n })),
      poolCredit: async (pool, channel, address) => { reads.push([pool, channel, address]); return credit; },
    });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    const pay = (amount: bigint, cumulativeAmount = amount): Promise<WorkerPayment> =>
      signTestWorkerPayment({ signer: buyer, channel: CHANNEL, worker: worker!.address, amount, domain, cumulativeAmount });
    for (const id of ['k1', 'k2']) {
      await request(id);
      await waitFor(() => fakePool.ended(id));
    }
    // The channel already settled to 18 without paying this worker: a payment of 18 adds nothing it can redeem.
    credit = { settled: 18n, credited: 0n };
    await request('k3', { payment: await pay(18n) });
    await waitFor(() => fakePool.errorFor('k3') !== undefined);
    expect(fakePool.errorFor('k3')).toMatch(/has not arrived/);
    // Unsettled, 18 more on the channel pays for both answers.
    credit = { settled: 18n, credited: 0n };
    await request('k4', { payment: await pay(18n, 36n) });
    await waitFor(() => fakePool.ended('k4'));
    expect(reads.at(-1)).toEqual([SELLER, CHANNEL.toLowerCase(), worker!.address]);
    // Then the pool settles past that payment and pays this worker nothing: the buyer gets no more work.
    credit = { settled: 36n, credited: 0n };
    await request('k5', { payment: await pay(27n, 45n) });
    await waitFor(() => fakePool.errorFor('k5') !== undefined);
    expect(fakePool.errorFor('k5')).toMatch(/no longer serves this buyer/);
    expect(upstream.bodies).toHaveLength(3);
  });

  it('refuses a request when the pool credit read fails, and trusts the signed payment only for a pool with no contract', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    const domain = { chainId: 8453, channelsAddress: '0x3000000000000000000000000000000000000003' };
    let read: () => Promise<{ settled: bigint; credited: bigint } | null> = async () => { throw new Error('rpc down'); };
    start({
      channelsDomain: domain,
      channelVerifier: trustedChannelVerifier(async () => ({ buyer: buyer.address, seller: SELLER, status: 1, deposit: 1_000_000n })),
      poolCredit: () => read(),
    });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    const pay = (amount: bigint): Promise<WorkerPayment> =>
      signTestWorkerPayment({ signer: buyer, channel: CHANNEL, worker: worker!.address, amount, domain });
    await request('f1', { payment: await pay(18n) });
    await waitFor(() => fakePool.errorFor('f1') !== undefined);
    expect(fakePool.errorFor('f1')).toMatch(/Could not read the pool's settlement/);
    expect(upstream.bodies).toHaveLength(0);
    // A seller paying workers from its own address: nothing on-chain to check, so the signed payment counts.
    read = async () => null;
    for (const id of ['f2', 'f3']) {
      await request(id);
      await waitFor(() => fakePool.ended(id));
    }
    await request('f4', { payment: await pay(18n) });
    await waitFor(() => fakePool.ended('f4'));
    expect(upstream.bodies).toHaveLength(3);
  });

  it('owes nothing for error answers without usage, so a buyer\'s corrected request still reaches the model', async () => {
    let refuse = 2;
    upstream = await startUpstream((_body, res) => {
      if (refuse-- > 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad request' } }));
        return;
      }
      answer(res);
    });
    start({ channelsDomain: { chainId: 8453, channelsAddress: '0x3000000000000000000000000000000000000003' } });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    for (const id of ['e1', 'e2', 'e3']) {
      await request(id);
      await waitFor(() => fakePool.ended(id));
    }
    expect(upstream.bodies).toHaveLength(3);
  });

  it('refuses buyers of a pool that declares zero prices, under which no answer would ever be owed', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start();
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    const free = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 };
    fakePool.send({ t: 'welcome', workerId: worker!.address, accepted: [SERVICE], rejected: [], workerShareBps: 9000, prices: { [SERVICE]: free } });
    await sleep(50);
    for (const id of ['z1', 'z2', 'z3']) {
      await request(id);
      await waitFor(() => fakePool.errorFor(id) !== undefined);
      expect(fakePool.errorFor(id)).toMatch(/declared no price/);
    }
    expect(upstream.bodies).toHaveLength(0);
  });

  it('keeps serving an honest buyer whose answers price at zero, which its payments never grow for', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    start({ channelsDomain: { chainId: 8453, channelsAddress: '0x3000000000000000000000000000000000000003' } });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    // A positive price at which an answer (5 in, 1 out) rounds to 0 base units.
    const cheap = { inputUsdPerMillion: 0.001, outputUsdPerMillion: 0.001 };
    fakePool.send({ t: 'welcome', workerId: worker!.address, accepted: [SERVICE], rejected: [], workerShareBps: 9000, prices: { [SERVICE]: cheap } });
    await sleep(50);
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      await request(id);
      await waitFor(() => fakePool.ended(id));
    }
    expect(upstream.bodies).toHaveLength(4);
  });

  it('shares one read between requests that arrive while it runs', async () => {
    upstream = await startUpstream((_body, res) => answer(res));
    let reads = 0;
    start({
      maxConcurrency: 3,
      channelVerifier: trustedChannelVerifier(async () => {
        reads++;
        await sleep(100);
        return { buyer: buyer.address, seller: SELLER, status: 1, deposit: 1_000_000n };
      }),
    });
    await waitFor(() => fakePool.frames.some((f) => f['t'] === 'hello'));
    // Two: as many as a buyer may run ahead of paying on one channel.
    await Promise.all([request('s1'), request('s2')]);
    await waitFor(() => ['s1', 's2'].every((id) => fakePool.ended(id)));
    expect(reads).toBe(1);
  });
});

describe('pool deadlines and capacity', () => {
  let dir: string;
  let ledger: WorkerLedger;
  let pool: ColonyPool;
  let provider: ColonyPoolProvider;
  let upstream: Upstream;
  const workers: PoolWorker[] = [];

  async function setup(handler: Parameters<typeof startUpstream>[0], opts: { responseIdleTimeoutMs?: number; verifyOnJoin?: boolean; heartbeatIntervalMs?: number } = {}): Promise<string> {
    upstream = await startUpstream(handler);
    pool = new ColonyPool({
      poolId: 'test-pool', seller: SELLER, catalog: [SERVICE, 'other-model'], prices: { [SERVICE]: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 }, 'other-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 4 } }, workerShareBps: 9000, ledger, port: 0, host: '127.0.0.1',
      verifyOnJoin: opts.verifyOnJoin ?? false,
      ...(opts.responseIdleTimeoutMs ? { responseIdleTimeoutMs: opts.responseIdleTimeoutMs } : {}),
      ...(opts.heartbeatIntervalMs ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {}),
    });
    provider = new ColonyPoolProvider({ pool, ledger, pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 } }, workerShareBps: 9000, maxConcurrency: 64 });
    return `ws://127.0.0.1:${await pool.start()}`;
  }

  function startWorker(poolUrl: string, services: Record<string, string>, maxConcurrency = 1): PoolWorker {
    const worker = new PoolWorker({
      poolUrl, baseUrl: upstream.url, services, privateKey: Wallet.createRandom().privateKey, encryptionKey: generateWorkerEncryptionKey(), maxConcurrency,
      channelVerifier: async () => true, // no chain in these tests
    });
    workers.push(worker);
    worker.start();
    return worker;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'colony-pool-lifecycle-'));
    ledger = new WorkerLedger(join(dir, 'ledger.db'));
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) worker.stop();
    await pool.stop();
    upstream.server.closeAllConnections();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cancels a started response that goes silent and frees the worker\'s slot', async () => {
    const poolUrl = await setup((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`);
    }, { responseIdleTimeoutMs: 300 });
    startWorker(poolUrl, { [SERVICE]: 'local' });
    await waitFor(() => provider.services.includes(SERVICE));
    const certificate = (JSON.parse(new TextDecoder().decode((await provider.handleControlRequest({
      requestId: 'assign', method: 'POST', path: '/_antseed/provider/colony-pool/assign', headers: {}, body: enc({ model: SERVICE }),
    })).body)) as { workers: Array<{ worker: string; key: string }> }).workers[0]!;
    const sealed = await sealRequest({ body: enc({ model: SERVICE, stream: true, messages: [{ role: 'user', content: 'hi' }] }), worker: certificate.worker, workerKey: certificate.key });
    let started = false;
    const result = provider.handleRequestStream(
      { requestId: 'silent', method: 'POST', path: '/v1/chat/completions', headers: {}, body: sealed.body },
      { onResponseStart: () => { started = true; }, onResponseChunk: () => {} },
    );
    await expect(result).rejects.toThrow(/sent nothing for 300ms/);
    expect(started).toBe(true);
    expect(pool.capacity().current).toBe(0);
    // The pool cancelled it, so the worker let go of the model too.
    await waitFor(() => upstream.aborted === 1);
  });

  it('runs join checks one at a time within the worker\'s capacity', async () => {
    const poolUrl = await setup(async (_body, res) => {
      await sleep(150);
      answer(res);
    }, { verifyOnJoin: true });
    startWorker(poolUrl, { [SERVICE]: 'local', 'other-model': 'local' }, 1);
    await waitFor(() => provider.services.length === 2);
    expect(upstream.bodies).toHaveLength(2);
    expect(upstream.peak).toBe(1);
  });

  it('fails a join check whose answer is too large', async () => {
    const poolUrl = await setup((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024) } }] }));
    }, { verifyOnJoin: true });
    startWorker(poolUrl, { [SERVICE]: 'local' });
    await waitFor(() => upstream.bodies.length === 1);
    await sleep(500);
    expect(provider.services).toEqual([]);
  });

  async function assign(): Promise<{ worker: string; key: string }> {
    return (JSON.parse(new TextDecoder().decode((await provider.handleControlRequest({
      requestId: 'assign', method: 'POST', path: '/_antseed/provider/colony-pool/assign', headers: {}, body: enc({ model: SERVICE }),
    })).body)) as { workers: Array<{ worker: string; key: string }> }).workers[0]!;
  }

  it('keeps two buyers\' requests apart when they use the same request ID', async () => {
    const poolUrl = await setup(async (body, res) => {
      await sleep(150);
      res.writeHead(200, { 'content-type': 'application/json' });
      const content = (body['messages'] as Array<{ content: string }>)[0]!.content;
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo ${content}` } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    });
    startWorker(poolUrl, { [SERVICE]: 'local' }, 2);
    await waitFor(() => provider.services.includes(SERVICE));
    const target = await assign();
    const send = async (content: string) => {
      const sealed = await sealRequest({ body: enc({ model: SERVICE, messages: [{ role: 'user', content }] }), worker: target.worker, workerKey: target.key });
      // Each buyer connection numbers its own requests, so both say req-1.
      const response = await provider.handleRequest({ requestId: 'req-1', method: 'POST', path: '/v1/chat/completions', headers: {}, body: sealed.body });
      const answer = JSON.parse(new TextDecoder().decode(sealed.opener.openBody(response.body))) as { choices: Array<{ message: { content: string } }> };
      return { status: response.statusCode, content: answer.choices[0]!.message.content };
    };
    const [a, b] = await Promise.all([send('first'), send('second')]);
    // Each buyer gets its own answer, sealed to its own key.
    expect(a).toEqual({ status: 200, content: 'echo first' });
    expect(b).toEqual({ status: 200, content: 'echo second' });
    expect(upstream.bodies).toHaveLength(2);
    expect(pool.capacity().current).toBe(0);
  });

  it('disconnects a worker that stops answering pings without closing', async () => {
    const poolUrl = await setup((_body, res) => answer(res), { heartbeatIntervalMs: 100 });
    const worker = startWorker(poolUrl, { [SERVICE]: 'local' });
    await waitFor(() => provider.services.includes(SERVICE));
    // The worker's machine goes to sleep: its socket stays open but reads nothing, so pings go unanswered.
    const socket = (worker as unknown as { ws: { _socket: { pause(): void } } }).ws._socket;
    socket.pause();
    await waitFor(() => !provider.services.includes(SERVICE), 3_000);
  });
});
