import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { SerializedHttpRequest } from '@antseed/node';
import {
  WORKER_ASSIGN_PATH,
  WORKER_UNAVAILABLE_STATUS,
  generateWorkerEncryptionKey,
  sealRequest,
  workerKeyCertificateMessage,
  workerKeyHex,
} from '@antseed/node/worker-e2e';
import { WorkerLedger } from './ledger.js';
import { ColonyPool } from './pool.js';
import { encodeBody, parsePoolFrame, workerAuthMessage } from './protocol.js';
import { ColonyPoolProvider } from './provider.js';
import { BENCH_BASE_MS, BENCH_MAX_MS, benchMs, newRank, parseWorkerPriority, rankScores, recordOutcome } from './ranking.js';

const SERVICE = 'qwen3-30b-a3b';
const SELLER = '0x00000000000000000000000000000000000000aa';
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

describe('worker ranking', () => {
  it('benches for 30 s, doubling with each failure in a row up to 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(benchMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, BENCH_MAX_MS, BENCH_MAX_MS]);
    const rank = newRank();
    recordOutcome(rank, { ok: false, bench: true, at: 1_000 });
    expect(rank.benchedUntil).toBe(1_000 + BENCH_BASE_MS);
    // A request that was already running when it was benched fails too: the bench doesn't grow.
    recordOutcome(rank, { ok: false, bench: true, at: 2_000 });
    expect(rank.failures).toBe(1);
    // Failing again after the bench doubles it; a success clears it.
    recordOutcome(rank, { ok: false, bench: true, at: 40_000 });
    expect(rank.benchedUntil).toBe(40_000 + 2 * BENCH_BASE_MS);
    recordOutcome(rank, { ok: true, at: 200_000 });
    expect(rank).toMatchObject({ failures: 0, benchedUntil: 0 });
    recordOutcome(rank, { ok: false, bench: true, at: 300_000 });
    expect(rank.benchedUntil).toBe(300_000 + BENCH_BASE_MS);
  });

  it('counts a failure that is not the worker\'s fault against it without benching', () => {
    const rank = recordOutcome(newRank(), { ok: false, at: 1_000 });
    expect(rank.benchedUntil).toBe(0);
    expect(rank.reliability).toBeCloseTo(0.8);
  });

  it('prefers reliable and fast workers, spreads load, and treats a new worker as average', () => {
    const [reliable, flaky] = rankScores([
      { reliability: 1, tokensPerSecond: 100, priority: 1, load: 0 },
      { reliability: 0.5, tokensPerSecond: 100, priority: 1, load: 0 },
    ]);
    expect(reliable).toBeGreaterThan(flaky!);
    const [fast, slow] = rankScores([
      { reliability: 1, tokensPerSecond: 300, priority: 1, load: 0 },
      { reliability: 1, tokensPerSecond: 100, priority: 1, load: 0 },
    ]);
    expect(fast).toBeGreaterThan(slow!);
    const [idle, busy] = rankScores([
      { reliability: 1, tokensPerSecond: 100, priority: 1, load: 0 },
      { reliability: 1, tokensPerSecond: 100, priority: 1, load: 0.5 },
    ]);
    expect(idle).toBeGreaterThan(busy!);
    const scores = rankScores([
      { reliability: 0.9, tokensPerSecond: 200, priority: 1, load: 0 },
      { reliability: 0.5, tokensPerSecond: 100, priority: 1, load: 0 },
      { reliability: null, tokensPerSecond: 0, priority: 1, load: 0 },
    ]);
    // Average reliability (0.7) × average speed (0.75).
    expect(scores[2]).toBeCloseTo(0.7 * 0.75);
    const [preferred, plain] = rankScores([
      { reliability: 0.6, tokensPerSecond: 100, priority: 2, load: 0 },
      { reliability: 1, tokensPerSecond: 100, priority: 1, load: 0 },
    ]);
    expect(preferred).toBeGreaterThan(plain!);
  });

  it('parses operator priorities and rejects malformed ones', () => {
    const a = Wallet.createRandom().address;
    expect(parseWorkerPriority(`${a}=2, ${Wallet.createRandom().address}=0`).get(a.toLowerCase())).toBe(2);
    expect(parseWorkerPriority(undefined).size).toBe(0);
    expect(() => parseWorkerPriority('0x12=1')).toThrow(/address=weight/);
    expect(() => parseWorkerPriority(`${a}=-1`)).toThrow(/address=weight/);
  });
});

type Behavior =
  | 'answer' | 'hang' | 'accept-then-hang' | 'refuse' | 'accept-then-fail'
  | { acceptThenAnswerAfterMs: number }
  /** Takes the request and answers it in full with this HTTP status. */
  | { answerStatus: number }
  /** Streams `chunks` SSE events `gapMs` apart. */
  | { streamChunks: number; gapMs: number };

/** A worker on the wire, scripted per request. */
class ScriptedWorker {
  readonly wallet = Wallet.createRandom();
  readonly key = generateWorkerEncryptionKey();
  readonly requests: string[] = [];
  private ws: WebSocket | null = null;

  constructor(private readonly poolUrl: string, public behavior: Behavior) {}

  get address(): string {
    return this.wallet.address.toLowerCase();
  }

  connect(): Promise<void> {
    const ws = new WebSocket(this.poolUrl);
    this.ws = ws;
    const keyHex = workerKeyHex(this.key.publicKey);
    return new Promise((resolve) => {
      ws.on('message', async (data) => {
        const frame = parsePoolFrame(data.toString());
        if (frame?.t === 'challenge') {
          const expires = Math.floor(Date.now() / 1000) + 24 * 3600;
          ws.send(JSON.stringify({
            t: 'hello',
            address: this.wallet.address,
            signature: await this.wallet.signMessage(workerAuthMessage(frame.pool, frame.nonce)),
            services: [SERVICE],
            maxConcurrency: 4,
            encryption: { key: keyHex, expires, certificate: await this.wallet.signMessage(workerKeyCertificateMessage(frame.seller, keyHex, expires)) },
          }));
        } else if (frame?.t === 'welcome') {
          resolve();
        } else if (frame?.t === 'request') {
          this.requests.push(frame.id);
          void this.serve(frame.id);
        }
      });
    });
  }

  private async serve(id: string): Promise<void> {
    const send = (frame: unknown) => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(frame));
    const answer = () => {
      send({ t: 'response-start', id, status: 200, headers: { 'content-type': 'application/json' } });
      send({ t: 'response-chunk', id, data: encodeBody(enc({ answer: this.address })) });
      send({ t: 'response-end', id });
    };
    const behavior = this.behavior;
    if (behavior === 'hang') return;
    if (behavior === 'answer') return answer();
    // A refusal (bad channel, binding, capacity) comes before `accepted`; a model failure after it.
    if (behavior === 'refuse') return send({ t: 'response-error', id, message: 'Request channel does not belong to a buyer of this pool' });
    send({ t: 'accepted', id });
    if (typeof behavior === 'object' && 'streamChunks' in behavior) {
      send({ t: 'response-start', id, status: 200, headers: { 'content-type': 'text/event-stream' } });
      for (let i = 0; i < behavior.streamChunks; i++) {
        await sleep(behavior.gapMs);
        send({ t: 'response-chunk', id, data: encodeBody(new TextEncoder().encode(`data: {"seq":${i}}\n\n`)) });
      }
      send({ t: 'response-end', id });
      return;
    }
    if (behavior === 'accept-then-hang') return;
    if (behavior === 'accept-then-fail') return send({ t: 'response-error', id, message: 'Local model timed out' });
    if ('answerStatus' in behavior) {
      send({ t: 'response-start', id, status: behavior.answerStatus, headers: { 'content-type': 'application/json' } });
      send({ t: 'response-chunk', id, data: encodeBody(enc({ error: { message: `status ${behavior.answerStatus}` } })) });
      send({ t: 'response-end', id });
      return;
    }
    await sleep(behavior.acceptThenAnswerAfterMs);
    answer();
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

describe('routing, failover and ranking in the pool', () => {
  let dir: string;
  let ledger: WorkerLedger;
  let pool: ColonyPool;
  let provider: ColonyPoolProvider;
  let poolUrl: string;
  const workers: ScriptedWorker[] = [];

  async function setup(opts: { firstByteTimeoutMs?: number; acceptTimeoutMs?: number; workerPriority?: Map<string, number> } = {}): Promise<void> {
    pool = new ColonyPool({
      poolId: 'test-pool', seller: SELLER, catalog: [SERVICE], prices: { [SERVICE]: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 } }, workerShareBps: 9000, ledger, port: 0, host: '127.0.0.1',
      verifyOnJoin: false,
      firstByteTimeoutMs: opts.firstByteTimeoutMs ?? 300,
      ...(opts.acceptTimeoutMs ? { acceptTimeoutMs: opts.acceptTimeoutMs } : {}),
      ...(opts.workerPriority ? { workerPriority: opts.workerPriority } : {}),
    });
    provider = new ColonyPoolProvider({ pool, ledger, pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 } }, workerShareBps: 9000, maxConcurrency: 64 });
    poolUrl = `ws://127.0.0.1:${await pool.start()}`;
  }

  async function connect(behavior: Behavior, wallet?: Wallet): Promise<ScriptedWorker> {
    const worker = new ScriptedWorker(poolUrl, behavior);
    if (wallet) Object.defineProperty(worker, 'wallet', { value: wallet });
    workers.push(worker);
    await worker.connect();
    return worker;
  }

  async function assign(): Promise<{ worker: string; key: string; status: number }> {
    const response = await provider.handleControlRequest({
      requestId: 'assign', method: 'POST', path: WORKER_ASSIGN_PATH, headers: {}, body: enc({ model: SERVICE }),
    });
    return response.statusCode === 200 ? { ...(JSON.parse(dec(response.body)) as { workers: Array<{ worker: string; key: string }> }).workers[0]!, status: 200 } : { worker: '', key: '', status: response.statusCode };
  }

  /** A request sealed to `worker`, as a buyer would send it. */
  async function requestFor(worker: ScriptedWorker, requestId = 'req-1'): Promise<SerializedHttpRequest> {
    const sealed = await sealRequest({ body: enc({ model: SERVICE, messages: [{ role: 'user', content: 'hi' }] }), worker: worker.address, workerKey: workerKeyHex(worker.key.publicKey) });
    return { requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: sealed.body };
  }

  /** One request sealed for several workers, in the order given. */
  async function requestForAll(recipients: ScriptedWorker[], requestId = 'req-1'): Promise<SerializedHttpRequest> {
    const sealed = await sealRequest({
      body: enc({ model: SERVICE, messages: [{ role: 'user', content: 'hi' }] }),
      recipients: recipients.map((w) => ({ worker: w.address, key: workerKeyHex(w.key.publicKey) })),
    });
    return { requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: sealed.body };
  }

  const summary = (worker: ScriptedWorker) => pool.workerSummaries().find((w) => w.address === worker.address)!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'colony-pool-routing-'));
    ledger = new WorkerLedger(join(dir, 'ledger.db'));
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    await pool.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers worker_unavailable when a worker never answers, benches it, and assigns the next buyer elsewhere', async () => {
    await setup();
    const hung = await connect('hang');
    const healthy = await connect('answer');
    const response = await provider.handleRequest(await requestFor(hung));
    // Nothing reached the buyer, so it takes another worker instead of failing.
    expect(response.statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    expect(JSON.parse(dec(response.body)).error.code).toBe('worker_unavailable');
    expect(summary(hung).benchedUntil).toBeGreaterThan(Date.now());
    for (let i = 0; i < 4; i++) expect((await assign()).worker.toLowerCase()).toBe(healthy.address);
    // A buyer still holding the benched worker's assignment is turned away before it waits again.
    const again = await provider.handleRequest(await requestFor(hung, 'req-2'));
    expect(again.statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    expect(dec(again.body)).toMatch(/benched/);
    expect(hung.requests).toHaveLength(1);
    expect((await provider.handleRequest(await requestFor(healthy))).statusCode).toBe(200);
    expect(summary(healthy).reliability).toBe(1);
  });

  it('gives a worker a short deadline to pick a request up, and the full one to answer', async () => {
    await setup({ firstByteTimeoutMs: 2_000, acceptTimeoutMs: 200 });
    const silent = await connect('hang');
    const started = Date.now();
    expect((await provider.handleRequest(await requestFor(silent))).statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    expect(Date.now() - started).toBeLessThan(1_500);
    // Accepted, then a slow (non-streamed) answer within the first-byte deadline: fine.
    const slow = await connect({ acceptThenAnswerAfterMs: 600 });
    expect((await provider.handleRequest(await requestFor(slow))).statusCode).toBe(200);
    expect(summary(slow).benchedUntil).toBeNull();
  });

  it('benches a worker that accepts a request and then never answers it', async () => {
    await setup({ firstByteTimeoutMs: 300, acceptTimeoutMs: 100 });
    const stuck = await connect('accept-then-hang');
    expect((await provider.handleRequest(await requestFor(stuck))).statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    expect(summary(stuck).benchedUntil).toBeGreaterThan(Date.now());
  });

  it('counts a worker\'s own failure against it, but never a refusal the buyer caused', async () => {
    await setup();
    const refusing = await connect('refuse');
    for (let i = 0; i < 5; i++) {
      expect((await provider.handleRequest(await requestFor(refusing, `bad-${i}`))).statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    }
    // Five requests it refused before taking them: its rank and history are untouched.
    expect(summary(refusing)).toMatchObject({ reliability: null, benchedUntil: null });
    expect(ledger.loadRank(refusing.address)?.reliability ?? null).toBeNull();

    const failing = await connect('accept-then-fail');
    expect((await provider.handleRequest(await requestFor(failing))).statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    // It took the request and its model failed: that is its fault, so it drops and is benched.
    expect(summary(failing).reliability).toBeLessThan(1);
    expect(summary(failing).benchedUntil).toBeGreaterThan(Date.now());
    expect(ledger.loadRank(failing.address)?.reliability).toBeLessThan(1);
    const history = new (await import('better-sqlite3')).default(join(dir, 'ledger.db'), { readonly: true });
    try {
      expect(history.prepare('SELECT worker, ok, reason FROM dispatches').all()).toEqual([{ worker: failing.address, ok: 0, reason: 'worker-error' }]);
    } finally {
      history.close();
    }
  });

  it('counts a completed 500 or 429 answer as the worker\'s failure, and a 400 as no one\'s', async () => {
    await setup();
    for (const status of [500, 429]) {
      const worker = await connect({ answerStatus: status });
      expect((await provider.handleRequest(await requestFor(worker, `s-${status}`))).statusCode).toBe(status);
      expect(summary(worker).reliability).toBeLessThan(1);
      expect(summary(worker).benchedUntil).toBeGreaterThan(Date.now());
      await worker.close();
    }
    const strict = await connect({ answerStatus: 400 });
    expect((await provider.handleRequest(await requestFor(strict, 's-400'))).statusCode).toBe(400);
    expect(summary(strict)).toMatchObject({ reliability: null, benchedUntil: null });
    const history = new (await import('better-sqlite3')).default(join(dir, 'ledger.db'), { readonly: true });
    try {
      expect(history.prepare('SELECT ok, reason FROM dispatches').all()).toEqual([{ ok: 0, reason: 'http-500' }, { ok: 0, reason: 'http-429' }]);
    } finally {
      history.close();
    }
  });

  it('keeps the decode speed it routes by in the ledger, across reconnects', async () => {
    await setup();
    const wallet = Wallet.createRandom();
    const fast = await connect('answer', wallet);
    pool.recordThroughput(fast.address, 100, 1_000);
    pool.recordThroughput(fast.address, 1, 1_000);
    // The same smoothing the pool routes by: 100 × 0.8 + 1 × 0.2.
    expect(summary(fast).tokensPerSecond).toBeCloseTo(80.2);
    expect(ledger.loadRank(fast.address)?.tokensPerSecond).toBeCloseTo(80.2);
    await fast.close();
    await waitFor(() => pool.workerSummaries().length === 0);
    const back = await connect('answer', wallet);
    expect(summary(back).tokensPerSecond).toBeCloseTo(80.2);
  });

  it('measures decode speed only on streamed answers, so a buffered one cannot read as instant', async () => {
    await setup({ firstByteTimeoutMs: 5_000 });
    // Generates for 400 ms, then sends the whole answer in one burst (as both workers do without `stream`).
    const buffered = await connect({ acceptThenAnswerAfterMs: 400 });
    // Streams the same 100 tokens over about 200 ms: 500 tok/s.
    const streaming = await connect({ streamChunks: 4, gapMs: 50 });
    const charge = async (worker: ScriptedWorker) => {
      const request = await requestFor(worker);
      expect((await provider.handleRequest(request)).statusCode).toBe(200);
      provider.onRequestCharged({ requestId: 'req-1', request, service: SERVICE, costUsdc: 1000n, inputTokens: 10, outputTokens: 100, freshInputTokens: 10, cachedInputTokens: 0 });
    };
    await charge(buffered);
    await charge(streaming);
    // Before, the buffered answer's ~1 ms delivery read as ~100,000 tok/s and won every assignment.
    expect(summary(buffered).tokensPerSecond).toBe(0);
    expect(summary(streaming).tokensPerSecond).toBeGreaterThan(100);
    expect(summary(streaming).tokensPerSecond).toBeLessThan(1_000);
    expect(ledger.loadRank(buffered.address)?.tokensPerSecond ?? 0).toBe(0);
  });

  it('never routes to a worker the operator weights 0, and favors one weighted higher', async () => {
    const excluded = Wallet.createRandom();
    const favored = Wallet.createRandom();
    await setup({ workerPriority: new Map([[excluded.address.toLowerCase(), 0], [favored.address.toLowerCase(), 3]]) });
    const off = await connect('answer', excluded);
    await sleep(50);
    // Its service isn't offered while only the excluded worker serves it.
    expect(provider.services).toEqual([]);
    expect((await assign()).status).toBe(503);
    expect((await provider.handleRequest(await requestFor(off))).statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    const plain = await connect('answer');
    const preferred = await connect('answer', favored);
    await waitFor(() => provider.services.includes(SERVICE));
    const first = await assign();
    expect(first.worker.toLowerCase()).toBe(preferred.address);
    expect([off.address]).not.toContain(first.worker.toLowerCase());
    expect(summary(off).priority).toBe(0);
    expect(summary(plain).priority).toBe(1);
  });

  it('keeps a worker\'s rank across reconnects and pool restarts', async () => {
    await setup();
    const wallet = Wallet.createRandom();
    const flaky = await connect('hang', wallet);
    expect((await provider.handleRequest(await requestFor(flaky))).statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    const benchedUntil = summary(flaky).benchedUntil!;
    expect(benchedUntil).toBeGreaterThan(Date.now());
    await flaky.close();
    await waitFor(() => pool.workerSummaries().length === 0);
    const back = await connect('answer', wallet);
    expect(summary(back).benchedUntil).toBe(benchedUntil);
    expect(summary(back).reliability).toBeLessThan(1);
    await back.close();
    await pool.stop();

    await setup();
    const restarted = await connect('answer', wallet);
    expect(summary(restarted).benchedUntil).toBe(benchedUntil);
    expect((await assign()).status).toBe(503);
  });

  it('credits each buyer\'s request when buyers reuse a request ID, on one worker or two', async () => {
    await setup();
    const a = await connect('answer');
    const b = await connect('answer');
    const requests = [await requestFor(a, 'req-1'), await requestFor(a, 'req-1'), await requestFor(b, 'req-1')];
    const responses = await Promise.all(requests.map((request) => provider.handleRequest(request)));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    for (const request of requests) {
      provider.onRequestCharged({ requestId: 'req-1', request, service: SERVICE, costUsdc: 1000n, inputTokens: 10, outputTokens: 5, freshInputTokens: 10, cachedInputTokens: 0 });
    }
    // 1000 − 2% = 980, then 90% = 882 per request.
    expect(ledger.stats(a.address)).toMatchObject({ requestsTotal: 2, earnedTotal: String(2 * 882) });
    expect(ledger.stats(b.address)).toMatchObject({ requestsTotal: 1, earnedTotal: '882' });
    // Charging the same request again credits nothing more.
    provider.onRequestCharged({ requestId: 'req-1', request: requests[0]!, service: SERVICE, costUsdc: 1000n, inputTokens: 10, outputTokens: 5, freshInputTokens: 10, cachedInputTokens: 0 });
    expect(ledger.stats(a.address).requestsTotal).toBe(2);
  });

  it('assigns the top-ranked workers a buyer asks for, best first', async () => {
    const favored = Wallet.createRandom();
    await setup({ workerPriority: new Map([[favored.address.toLowerCase(), 3]]) });
    const a = await connect('answer');
    const b = await connect('answer', favored);
    const c = await connect('answer');
    const response = await provider.handleControlRequest({
      requestId: 'assign', method: 'POST', path: WORKER_ASSIGN_PATH, headers: {}, body: enc({ model: SERVICE, recipients: 2 }),
    });
    const { workers: assigned } = JSON.parse(dec(response.body)) as { workers: Array<{ worker: string }> };
    expect(assigned).toHaveLength(2);
    expect(assigned[0]!.worker.toLowerCase()).toBe(b.address);
    expect([a.address, c.address]).toContain(assigned[1]!.worker.toLowerCase());
    // Never more than three, and never the same worker twice.
    const many = await provider.handleControlRequest({
      requestId: 'assign', method: 'POST', path: WORKER_ASSIGN_PATH, headers: {}, body: enc({ model: SERVICE, recipients: 9 }),
    });
    const all = (JSON.parse(dec(many.body)) as { workers: Array<{ worker: string }> }).workers.map((w) => w.worker.toLowerCase());
    expect(new Set(all).size).toBe(3);
  });

  it('fails over to the next recipient without the buyer, and never to a worker outside the set', async () => {
    await setup({ firstByteTimeoutMs: 2_000, acceptTimeoutMs: 150 });
    const hung = await connect('hang');
    const healthy = await connect('answer');
    const outsider = await connect('answer');
    // The hung worker ranks first (equal scores keep the buyer's order), so the pool tries it first.
    const response = await provider.handleRequest(await requestForAll([hung, healthy]));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(dec(response.body))).toEqual({ answer: healthy.address });
    expect(hung.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(1);
    expect(outsider.requests).toHaveLength(0);
    expect(summary(hung).benchedUntil).toBeGreaterThan(Date.now());
    // Now benched, the hung worker is skipped outright: the request goes straight to the healthy one.
    expect((await provider.handleRequest(await requestForAll([hung, healthy], 'req-2'))).statusCode).toBe(200);
    expect(hung.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(2);
  });

  it('tries recipients in rank order, not the order the buyer sent', async () => {
    const favored = Wallet.createRandom();
    await setup({ workerPriority: new Map([[favored.address.toLowerCase(), 3]]) });
    const plain = await connect('answer');
    const preferred = await connect('answer', favored);
    const response = await provider.handleRequest(await requestForAll([plain, preferred]));
    expect(JSON.parse(dec(response.body))).toEqual({ answer: preferred.address });
    expect(plain.requests).toHaveLength(0);
  });

  it('answers worker_unavailable once every recipient fails, leaving other workers alone', async () => {
    await setup({ firstByteTimeoutMs: 2_000, acceptTimeoutMs: 100 });
    const first = await connect('hang');
    const second = await connect('accept-then-hang');
    const outsider = await connect('answer');
    const response = await provider.handleRequest(await requestForAll([first, second]));
    expect(response.statusCode).toBe(WORKER_UNAVAILABLE_STATUS);
    expect(JSON.parse(dec(response.body)).error.code).toBe('worker_unavailable');
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(outsider.requests).toHaveLength(0);
    // Each failed attempt counts against its own worker's rank.
    expect(summary(first).reliability).toBeLessThan(1);
    expect(summary(second).reliability).toBeLessThan(1);
    expect(summary(outsider).reliability ?? 1).toBe(1);
    expect(summary(outsider).benchedUntil).toBeNull();
  });
});
