// Fault shapes for the stress scenarios: the mock's slow fault, chats without max_tokens, a seller crash mid-load,
// the proof that an injected fault fired, composed gates and the seeded chaos plan.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { analyzePayments } from '../../stress/analysis.mjs';
import { chaosGate, CHAOS_SLOW_BLOCK_SEC, CHAOS_SLOW_MS, drawChaosPlan } from '../lib/chaos.mjs';
import { sanitizeConfig, DEFAULT_SOURCE_CONFIG } from '../lib/config.mjs';
import { startMock } from '../lib/mock.mjs';
import { cliBuyerConfig } from '../lib/node-options.mjs';
import { createPrng } from '../lib/prng.mjs';
import { BUYER_PATTERNS, clientSummary, composeGate, deliveryCounts, GATES, gateProblems, injectedEvidence, runLoad, SELLER_PATTERNS, stressRun, stressTopology } from '../lib/stress.mjs';
import { createTestbenchApi } from '../lib/tb.mjs';
import { MAX_MOCK_LATENCY_MS, normalizeTopology, topologyFingerprint } from '../lib/topology.mjs';

const source = sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chat = (tag, extra = {}) => ({ model: 'm', messages: [{ role: 'user', content: `[req:${tag}] hi` }], ...extra });

/** An OpenAI-shaped server that keeps every request body it gets. */
async function recordingServer() {
  const bodies = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  return { bodies, url: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((closed) => server.close(closed)) };
}

describe('mock slow fault', () => {
  it('holds a share of tagged requests for slowMs and counts them in the ledger', async () => {
    const mock = await startMock({ models: ['m'], slowRate: 1, slowMs: 150 });
    try {
      const started = Date.now();
      assert.equal((await post(`${mock.url}/v1/chat/completions`, chat('a'))).status, 200);
      assert.ok(Date.now() - started >= 140);
      // Untagged traffic (warm-ups, probes) is never slowed.
      const untagged = Date.now();
      await post(`${mock.url}/v1/chat/completions`, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(Date.now() - untagged < 140);
      const ledger = mock.deliveries();
      assert.deepEqual([ledger.slow, ledger.byTag.a.slow, ledger.byTag.a.latencyMs, ledger.byTag.a.status], [1, true, 150, 'ok']);
    } finally {
      await mock.stop();
    }
  });

  it('setFaults changes only the faults it names and ignores unknown keys', async () => {
    const mock = await startMock({ models: ['m'], fault500Rate: 0.5 });
    try {
      assert.deepEqual(mock.setFaults({ slowRate: 0.2, slowMs: 900, bogus: 1, disconnectRate: undefined }), { fault500Rate: 0.5, disconnectRate: 0, slowRate: 0.2, slowMs: 900 });
      assert.deepEqual(mock.setFaults({ slowRate: 0 }), { fault500Rate: 0.5, disconnectRate: 0, slowRate: 0, slowMs: 900 });
    } finally {
      await mock.stop();
    }
  });

  it('leaves a seed\'s other draws alone while the fault is off', async () => {
    const outcomes = async (extra) => {
      const mock = await startMock({ models: ['m'], usage: 'load', latencyRangeMs: [1, 5], outTokens: [1, 500], random: createPrng(7), ...extra });
      try {
        for (const tag of ['a', 'b', 'c']) await post(`${mock.url}/v1/chat/completions`, chat(tag));
        return Object.values(mock.deliveries().byTag).map((entry) => [entry.completion, entry.status]);
      } finally {
        await mock.stop();
      }
    };
    assert.deepEqual(await outcomes({ slowRate: 1, slowMs: 1 }), await outcomes({}));
  });
});

describe('fault topology options', () => {
  it('writes buyer.requestTimeoutMs into the CLI buyer config, in cli mode only', () => {
    const topology = normalizeTopology(stressTopology({ buyer: { requestTimeoutMs: 20_000 } }), source);
    assert.equal(topology.buyer.requestTimeoutMs, 20_000);
    const config = (requestTimeoutMs) => cliBuyerConfig({ proxyPort: 43000, routingPreferences: {}, requestTimeoutMs, chain: {}, bootstrapNodes: [{ host: '127.0.0.1', port: 40000 }], payments: { crypto: {} } }).buyer;
    assert.equal(config(20_000).requestTimeoutMs, 20_000);
    assert.equal('requestTimeoutMs' in config(undefined), false);
    assert.throws(() => normalizeTopology(stressTopology({ mode: 'sdk', buyer: { requestTimeoutMs: 20_000 } }), source), /needs mode cli/);
    assert.throws(() => normalizeTopology(stressTopology({ buyer: { requestTimeoutMs: 10 } }), source), /requestTimeoutMs must be/);
  });

  it('validates the slow fault and keeps older topologies\' fingerprints', () => {
    const slow = normalizeTopology({ sellers: [{ id: 'a', mock: { slowRate: 0.1, slowMs: 5000 } }] }, source);
    assert.deepEqual([slow.sellers[0].mock.slowRate, slow.sellers[0].mock.slowMs], [0.1, 5000]);
    assert.equal('slowRate' in normalizeTopology({}, source).sellers[0].mock, false);
    assert.notEqual(topologyFingerprint(slow), topologyFingerprint(normalizeTopology({ sellers: [{ id: 'a' }] }, source)));
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { slowRate: 2 } }] }, source), /slowRate/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { slowMs: MAX_MOCK_LATENCY_MS + 1 } }] }, source), /slowMs/);
    assert.throws(() => normalizeTopology({ chain: { blockTimeSec: 31 } }, source), /blockTimeSec must be 1-30/);
  });
});

describe('load faults', () => {
  it('sends the drawn share of chats without max_tokens and counts them', async () => {
    const server = await recordingServer();
    try {
      const all = await runLoad({ proxyUrl: server.url, model: 'm', load: { concurrency: 2, requests: 6, streamRatio: 0, minInTokens: 1, maxInTokens: 2, omitMaxTokensRatio: 1 }, random: createPrng(3) });
      assert.equal(server.bodies.every((body) => !('max_tokens' in body)), true);
      assert.deepEqual([all.client.noMaxTokens, all.client.ok], [6, 6]);
      server.bodies.length = 0;
      const none = await runLoad({ proxyUrl: server.url, model: 'm', load: { concurrency: 2, requests: 6, streamRatio: 0, minInTokens: 1, maxInTokens: 2 }, random: createPrng(3) });
      assert.equal(server.bodies.every((body) => body.max_tokens === 4096), true);
      assert.equal(none.client.noMaxTokens, 0);
      // The option is off by default, so the same seed sends the same requests as before it existed.
      assert.deepEqual(none.results.map((record) => record.tag).sort(), all.results.map((record) => record.tag).sort());
    } finally {
      await server.stop();
    }
  });

  it('tb.load crashes the seller instead of stopping it, and records that it was really killed', async () => {
    const server = await recordingServer();
    const dir = await mkdtemp(join(tmpdir(), 'tb-faults-'));
    const calls = [];
    const control = {
      crashSeller: async (id) => { calls.push(`crash ${id}`); return { crashed: true }; },
      stopSeller: async (id) => { calls.push(`stop ${id}`); return { stopped: true }; },
      startSeller: async (id) => { calls.push(`start ${id}`); return { started: true }; },
    };
    const manifest = { dir, proxyUrl: server.url, rpcUrl: 'http://127.0.0.1:1', buyer: { address: ZERO_ADDRESS }, topology: { sellers: [] }, sellers: [{ id: 'seller', peerId: 'a'.repeat(40), address: ZERO_ADDRESS, models: ['m'] }] };
    const chain = { depositsContractAddress: ZERO_ADDRESS, usdcContractAddress: ZERO_ADDRESS, channelsContractAddress: ZERO_ADDRESS };
    const tb = createTestbenchApi({ manifest, control, eventsPath: join(dir, 'events.jsonl'), chain });
    try {
      const shape = { concurrency: 2, requests: 4, streamRatio: 0, minInTokens: 1, maxInTokens: 2 };
      const crashed = await tb.load({ ...shape, restart: { who: 'seller', atFraction: 0.5, crash: true } });
      assert.deepEqual(calls, ['crash seller', 'start seller']);
      assert.deepEqual([crashed.restart.who, crashed.restart.crash, crashed.restart.crashed], ['seller', true, true]);
      calls.length = 0;
      const graceful = await tb.load({ ...shape, restart: { who: 'seller', atFraction: 0.5 } });
      assert.deepEqual(calls, ['stop seller', 'start seller']);
      assert.equal('crash' in graceful.restart, false);
      await assert.rejects(tb.load({ ...shape, restart: { who: 'buyer', atFraction: 0.5, crash: true } }), /restart.crash kills a seller/);
    } finally {
      await tb.dispose();
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the failure kinds outside a restart window', () => {
    const results = [
      { start: 1000, ms: 100, error: 'a' },
      { start: 5000, ms: 100, error: 'b' },
      { start: 40_000, ms: 10, error: 'a' },
    ];
    const summary = clientSummary(results, { startedAt: 0, restart: { stoppedAt: 4000, downMs: 1000 } });
    assert.deepEqual(summary.failuresOutsideRestartWindow, { a: 2 });
  });
});

describe('fault evidence', () => {
  it('counts a ledger\'s outcomes after the snapshot', () => {
    const ledger = { byTag: { old: { status: '500' }, a: { status: '500' }, b: { status: 'ok', slow: true }, c: { status: 'disconnect' } } };
    assert.deepEqual(deliveryCounts([ledger], new Set(['old'])), { slow: 1, 500: 1, ok: 1, disconnect: 1 });
  });

  it('has one entry per injected fault, failed when that fault never fired', () => {
    const client = { clientAborted: 2, noMaxTokens: 0 };
    const entries = injectedEvidence({
      faults: { fault500Rate: 0.05, disconnectRate: 0.05, slowRate: 0.1, slowMs: 1000 },
      load: { abortRatio: 0.1, omitMaxTokensRatio: 0.4, restart: { who: 'seller', atFraction: 0.4, crash: true } },
      client, restart: { who: 'seller', crash: true, crashed: false }, deliveries: { 500: 3, slow: 1 },
    });
    assert.deepEqual(entries.map((entry) => [entry.name.replace('fault path ran: ', ''), entry.ok]), [
      ['the upstream answered 500s', true],
      ['the upstream cut responses midway', false],
      ['the upstream held responses back', true],
      ['clients aborted requests', true],
      ['chats went out without max_tokens', false],
      ['the seller was killed and started again mid-load', false],
    ]);
    assert.deepEqual(injectedEvidence({ load: {}, client, deliveries: {} }), []);
    const [restarted] = injectedEvidence({ load: { restart: { who: 'buyer', atFraction: 0.4 } }, client, restart: { who: 'buyer' }, deliveries: {} });
    assert.equal(restarted.ok, true);
    const [never] = injectedEvidence({ load: { restart: { who: 'buyer', atFraction: 0.4 } }, client, restart: null, deliveries: {} });
    assert.equal(never.ok, false);
  });

  /** A stand-in tb for stressRun with a ledger and log counters to read. */
  function fakeTb({ byTag = {}, logPatterns = { seller: {}, buyer: {} } } = {}) {
    const calls = [];
    const checks = [];
    return {
      calls, checks,
      paymentSnapshot: async () => ({ deliveredTags: ['old'] }),
      chat: async () => ({}),
      waitFor: async (predicate) => predicate(),
      prng: () => Math.random,
      setMockFaults: async (id, faults) => { calls.push(`faults ${JSON.stringify(faults)}`); },
      deliveries: async () => ({ byTag }),
      summary: () => ({ metrics: { logPatterns } }),
      check: (name, ok) => { checks.push([name, ok]); assert(ok, name); },
      load: async (shape) => { calls.push(`load ${shape.requests}`); return { results: [{ tag: `r${shape.requests}` }], client: clientSummary([]), loadMs: 5, restart: null }; },
      assertDeliveredWorkPaid: async ({ results, injected }) => { calls.push(`oracle ${results.map((entry) => entry.tag).join('+')} slowRate=${injected.slowRate}`); },
      assertNoCrashes: async () => { calls.push('crashes'); },
      checkGate: (run) => { calls.push(`gate ${run.results[0].tag}`); },
      timings: () => {},
    };
  }

  it('stressRun fails a run whose fault never fired, after every other verdict', async () => {
    const tb = fakeTb({ byTag: { old: { status: '500' } } });
    await assert.rejects(stressRun(tb, { load: { requests: 3 }, faults: { fault500Rate: 0.1 } }), /fault path ran: the upstream answered 500s/);
    assert.deepEqual(tb.calls.slice(-3), ['oracle r3 slowRate=undefined', 'crashes', 'gate r3']);
  });

  it('stressRun runs a fault-free follow-up load, judges both together and records the scenario\'s own evidence', async () => {
    const tb = fakeTb({ byTag: { a: { status: 'ok', slow: true } }, logPatterns: { seller: {}, buyer: { requestTimedOut: 2 } } });
    const run = await stressRun(tb, {
      load: { requests: 3 }, faults: { slowRate: 0.1, slowMs: 500 }, followUp: { load: { requests: 2 } },
      evidence: ({ logPatterns, followUp }) => [{ name: 'timed out', ok: logPatterns.buyer.requestTimedOut > 0 && followUp.results.length === 1 }],
    });
    assert.deepEqual(tb.calls, [
      'faults {"slowRate":0.1,"slowMs":500}', 'load 3', 'faults {"fault500Rate":0,"disconnectRate":0,"slowRate":0}', 'load 2',
      'oracle r3+r2 slowRate=0.1', 'crashes', 'gate r3', 'gate r2',
    ]);
    assert.deepEqual(tb.checks, [['fault path ran: the upstream held responses back', true], ['timed out', true]]);
    assert.equal(run.followUp.results[0].tag, 'r2');
  });
});

describe('gates for combined faults', () => {
  it('lets anything fail inside the restart window and only allowed kinds outside it', () => {
    const gate = composeGate([GATES.faults, GATES['crash-seller']]);
    assert.deepEqual([gate.minOk, gate.restart], [0.7, true]);
    const client = { total: 100, ok: 90, clientAborted: 0, failures: { '500:server_error': 4, 'fetch:ECONNRESET': 6 } };
    assert.deepEqual(gateProblems({ ...client, failuresOutsideRestartWindow: { '500:server_error': 4 }, failedOutsideRestartWindow: 4 }, gate), []);
    assert.deepEqual(gateProblems({ ...client, failuresOutsideRestartWindow: { 'fetch:ECONNRESET': 1 }, failedOutsideRestartWindow: 1 }, gate), ['unexpected failure kind outside the restart window: fetch:ECONNRESET (1)']);
    // No restart record: every failure counts as outside the window.
    assert.match(gateProblems(client, gate)[0], /fetch:ECONNRESET \(6\)/);
  });

  it('composes floors and failure kinds, never looser than the parts', () => {
    assert.equal(composeGate([]), GATES.default);
    assert.deepEqual(composeGate([GATES.default]), { minOk: 0.99 });
    const both = composeGate([{ minOk: 0.9, allowedFailures: /^a$/ }, { minOk: 0.8, allowedFailures: /^b$/ }]);
    assert.equal(both.minOk, 0.8);
    assert.deepEqual(['a', 'b', 'ab', 'c'].map((kind) => both.allowedFailures.test(kind)), [true, true, false, false]);
    assert.equal(composeGate([GATES['restart-buyer'], GATES.default]).allowedFailures, undefined);
  });
});

describe('chaos plan', () => {
  it('is fixed by the seed and always injects something', () => {
    assert.deepEqual(drawChaosPlan(createPrng(42)), drawChaosPlan(createPrng(42)));
    const seen = new Set();
    for (let seed = 0; seed < 300; seed += 1) {
      const plan = drawChaosPlan(createPrng(seed));
      assert.ok(plan.fired.length > 0, `seed ${seed} injects nothing`);
      for (const name of plan.fired) seen.add(name);
      assert.equal(plan.load.requests, 240);
      assert.ok([16, 32, 48].includes(plan.load.concurrency));
      assert.equal(plan.fired.includes('slowUpstream'), plan.faults.slowRate > 0);
      if (plan.faults.slowRate) assert.equal(plan.faults.slowMs, CHAOS_SLOW_MS);
      assert.equal(plan.fired.includes('slowBlocks'), plan.blockTimeSec === CHAOS_SLOW_BLOCK_SEC);
      assert.equal(plan.fired.includes('upstream500'), plan.faults.fault500Rate > 0);
      if (plan.load.restart) assert.ok(plan.load.restart.atFraction >= 0.2 && plan.load.restart.atFraction <= 0.7);
    }
    assert.deepEqual([...seen].sort(), ['clientAbort', 'crash-seller', 'disconnect', 'noMaxTokens', 'restart-buyer', 'restart-seller', 'slowBlocks', 'slowUpstream', 'upstream500']);
  });

  it('holds a plan to the gates of the shapes that inject its faults', () => {
    const plain = { faults: { fault500Rate: 0, disconnectRate: 0 }, load: { abortRatio: 0.1 } };
    assert.equal(chaosGate(plain), GATES.default);
    const faults = chaosGate({ faults: { fault500Rate: 0.05, disconnectRate: 0 }, load: {} });
    assert.deepEqual([faults.minOk, faults.restart], [0.7, undefined]);
    assert.equal(faults.allowedFailures.test('500:server_error'), true);
    const crash = chaosGate({ faults: { fault500Rate: 0.05, disconnectRate: 0 }, load: { restart: { who: 'seller', crash: true, atFraction: 0.3 } } });
    assert.deepEqual([crash.minOk, crash.restart], [0.7, true]);
    assert.equal(chaosGate({ faults: { fault500Rate: 0, disconnectRate: 0 }, load: { restart: { who: 'buyer', atFraction: 0.3 } } }).minOk, GATES['restart-buyer'].minOk);
  });
});

describe('oracle and log counters', () => {
  it('does not demand exact payment when the upstream was slower than the buyer waits', () => {
    const run = (sc) => analyzePayments({
      sellerRowsPre: [], sellerRowsPost: [], buyerRowsPost: [], allIds: [], onchain: {}, results: [],
      chain0: { buyerBalance: 0n, sellerUsdc: 0n, reserveUsdc: 0n, buyerReserved: 0n }, chain1: { buyerBalance: 0n, sellerUsdc: 0n, reserveUsdc: 0n, buyerReserved: 0n },
      // Delivered by the upstream after the buyer gave up: the seller's books need not show it.
      mockStats: { perRequest: new Map([['a', { status: 'ok', started: true, cost: '5' }]]), expectedCostBaseUnits: 5n },
      sc: { fault500Rate: 0, disconnectRate: 0, abortRatio: 0, restart: null, ...sc },
    }).violations.map((violation) => violation.kind);
    assert.deepEqual(run({}), ['seller-spent!=delivered-cost(fault-free)']);
    assert.deepEqual(run({ slowRate: 0.1 }), []);
  });

  it('counts the seller\'s ceiling waits and the buyer\'s timeouts', () => {
    assert.match('[SellerHandler] Still at the ceiling after a top-up for abc... (spent=1) — waiting for the next top-up', SELLER_PATTERNS.stillAtCeiling);
    assert.match('[SellerHandler] Top-up still mining at the wait budget for abc... — returning 503 top_up_pending', SELLER_PATTERNS.topUpPendingAtBudget);
    assert.match('[SellerPayment] Top-up verified: channel=0xabc... ceiling 1 → 2', SELLER_PATTERNS.topUpVerified);
    assert.match('[BuyerRequest] Request 1a2b3c4d timed out after 20001ms (timeout=20000ms, stream=false)', BUYER_PATTERNS.requestTimedOut);
  });
});

describe('seed sweep', () => {
  it('reads seed lists and ranges', async () => {
    const { parseSeeds, parseSweepArgs } = await import('../lib/sweep.mjs');
    assert.deepEqual(parseSeeds('1-3,9,2'), [1, 2, 3, 9]);
    assert.throws(() => parseSeeds('5-1'), /upwards/);
    assert.throws(() => parseSeeds('a'), /numbers and ranges/);
    assert.throws(() => parseSeeds('1-500'), /at most 200/);
    assert.deepEqual(parseSweepArgs(['stress-chaos', '--chain', 'local', '--seeds', '1-2', '--seller-tree', '/x']), { scenario: 'stress-chaos', seeds: [1, 2], runArgs: ['--chain', 'local', '--seller-tree', '/x'] });
    assert.throws(() => parseSweepArgs(['stress-chaos']), /Usage/);
    assert.throws(() => parseSweepArgs(['--seeds', '1']), /scenario name/);
    for (const flag of ['--keep', '--real-funds', '--live', '--seed']) assert.throws(() => parseSweepArgs(['s', '--seeds', '1', flag]), /does not take/);
    assert.throws(() => parseSweepArgs(['s', '--seeds', '1', '--chain', 'mainnet']), /does not take mainnet/);
  });

  it('reports each failed seed with its rerun line', async () => {
    const { readRunOutput, sweepSummary } = await import('../lib/sweep.mjs');
    const failed = readRunOutput(7, 1, [
      '[chaos] plan: upstream500, crash-seller {"faults":{}}',
      '[testbench] FAIL payment oracle: served-unpaid {"gap":"5"}',
      '[testbench] FAILED: /tmp/reports/x/report.json',
      '[testbench] rerun: pnpm testbench run stress-chaos --chain local --seed 7',
    ].join('\n'));
    assert.deepEqual(failed, {
      seed: 7, result: 'failed', report: '/tmp/reports/x/report.json', rerun: 'pnpm testbench run stress-chaos --chain local --seed 7',
      failed: ['payment oracle: served-unpaid {"gap":"5"}'], plan: 'upstream500, crash-seller {"faults":{}}',
    });
    const passed = readRunOutput(8, 0, '[testbench] PASSED: /tmp/reports/y/report.json');
    assert.deepEqual([passed.result, passed.rerun, passed.failed], ['passed', null, []]);
    assert.equal(readRunOutput(9, 2, '').result, 'blocked');
    assert.deepEqual(sweepSummary('stress-chaos', [failed, passed]), [
      'Sweep of stress-chaos: 1/2 seeds passed',
      '  seed 7: failed  [upstream500, crash-seller]',
      '  seed 8: passed',
      'FAILED seed 7 (failed): /tmp/reports/x/report.json',
      '    payment oracle: served-unpaid {"gap":"5"}',
      '    rerun: pnpm testbench run stress-chaos --chain local --seed 7',
    ]);
  });
});
