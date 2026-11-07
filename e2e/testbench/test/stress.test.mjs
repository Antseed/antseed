import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sanitizeConfig, DEFAULT_SOURCE_CONFIG } from '../lib/config.mjs';
import { startMock, summarizeDeliveries, usageCost } from '../lib/mock.mjs';
import { createTestbenchApi, parseSse } from '../lib/tb.mjs';
import { classifyScenarioError } from '../lib/report.mjs';
import { bootstrapCounts, BUYER_PATTERNS, classifyError, clientSummary, costLinesCheck, countPatterns, CRASH_PATTERN, externalHosts, GATES, gateProblems, latencyPercentiles, loadTimings, mergeDeliveries, peerLogs, runAll, runLoad, SELLER_PATTERNS, stressRun, stressTopology } from '../lib/stress.mjs';
import { combinedGate } from '../scenarios/issue-1050-stale-channel.mjs';
import { normalizeTopology, topologyFingerprint, validateScenarioModule } from '../lib/topology.mjs';

const source = sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// Deterministic stand-in for Math.random: cycles through the given values.
const sequence = (...values) => { let index = 0; return () => values[index++ % values.length]; };

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const CLEAN_HEALTH = { unexpectedExits: [], forcedStops: [], unhandledRejections: [] };
const STARTED = '[Node] Starting as seller with 1 bootstrap node(s)\n';

/** A real tb over a temp testbench directory: `logs` exist before the run starts, then the test appends to them. */
async function withTb({ proxyUrl = 'http://127.0.0.1:1', logs = {}, upStart = {}, health = CLEAN_HEALTH, budgets, enforceBudgets }, test) {
  const dir = await mkdtemp(join(tmpdir(), 'tb-stress-'));
  await mkdir(join(dir, 'logs'));
  for (const [name, text] of Object.entries(logs)) await writeFile(join(dir, 'logs', name), text);
  const manifest = {
    dir, proxyUrl, rpcUrl: 'http://127.0.0.1:1', buyer: { address: ZERO_ADDRESS }, topology: { sellers: [] },
    logStart: Object.fromEntries(Object.entries(upStart).map(([name, offset]) => [join(dir, 'logs', name), offset])),
    sellers: [{ id: 'seller', peerId: 'a'.repeat(40), address: ZERO_ADDRESS, models: ['m'] }],
  };
  const chain = { depositsContractAddress: ZERO_ADDRESS, usdcContractAddress: ZERO_ADDRESS, channelsContractAddress: ZERO_ADDRESS };
  const tb = createTestbenchApi({ manifest, control: { health: async () => health }, eventsPath: join(dir, 'events.jsonl'), chain, budgets, enforceBudgets });
  const append = (name, text) => appendFile(join(dir, 'logs', name), text);
  try {
    await test(tb, { append, dir });
  } finally {
    await tb.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A stand-in for tb that logs what stressRun calls, in order. `fail` names the steps that throw. */
function fakeTb(fail = []) {
  const calls = [];
  const metrics = {};
  const step = (name, value) => async () => {
    calls.push(name);
    if (fail.includes(name)) throw new Error(`${name} failed`);
    return value;
  };
  return {
    calls,
    metrics,
    paymentSnapshot: step('snapshot', {}),
    chat: step('warm-up', {}),
    waitFor: async (predicate) => predicate(),
    prng: () => Math.random,
    setMockFaults: async (id, faults) => { calls.push(faults.fault500Rate ? 'faults on' : 'faults off'); },
    load: step('load', { results: [], client: clientSummary([]), loadMs: 5 }),
    metric: (name, value) => { (metrics[name] = value); },
    assertDeliveredWorkPaid: step('oracle'),
    assertNoCrashes: step('crashes'),
    checkGate: step('gate'),
    timings: (measured) => { calls.push('timings'); Object.assign(metrics, measured); },
  };
}

describe('mock delivery ledger', () => {
  it('records tagged chat deliveries at the seller price (fixed usage)', async () => {
    const mock = await startMock({ models: ['m'], pricing: { m: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } } });
    try {
      await post(`${mock.url}/v1/chat/completions`, { model: 'm', messages: [{ role: 'user', content: '[req:abc] hi' }] });
      const stream = await post(`${mock.url}/v1/chat/completions`, { model: 'm', stream: true, messages: [{ role: 'user', content: '[req:def] hi' }] });
      assert.equal(parseSse(await stream.text()).done, true);
      await post(`${mock.url}/v1/chat/completions`, { model: 'm', messages: [{ role: 'user', content: 'untagged' }] });
      const ledger = mock.deliveries();
      const cost = String(10 * 3 + 8 * 15);
      assert.deepEqual([ledger.byTag.abc.status, ledger.byTag.abc.started, ledger.byTag.abc.cost], ['ok', true, cost]);
      assert.equal(ledger.byTag.def.stream, true);
      assert.ok(Object.keys(ledger.byTag).some((tag) => tag.startsWith('untagged-')));
      assert.equal(ledger.deliveredCost, String(3 * (10 * 3 + 8 * 15)));
      assert.equal(ledger.counts.ok, 3);
    } finally {
      await mock.stop();
    }
  });

  it('load usage sizes prompt and completion like real traffic', async () => {
    const mock = await startMock({ models: ['m'], usage: 'load', latencyRangeMs: [0, 0], outTokens: [50, 50], pricing: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } });
    try {
      const messages = [{ role: 'user', content: `[req:big] ${'x'.repeat(400)}` }];
      const body = await (await post(`${mock.url}/v1/chat/completions`, { model: 'm', messages })).json();
      const prompt = Math.ceil(JSON.stringify(messages).length / 4);
      assert.deepEqual(body.usage, { prompt_tokens: prompt, completion_tokens: 50, total_tokens: prompt + 50 });
      assert.equal(mock.deliveries().byTag.big.cost, String(prompt + 100));
      const streamed = parseSse(await (await post(`${mock.url}/v1/chat/completions`, { model: 'm', stream: true, messages: [{ role: 'user', content: '[req:s] y' }] })).text());
      assert.equal(streamed.done, true);
      assert.equal(streamed.usage.completion_tokens, 50);
    } finally {
      await mock.stop();
    }
  });

  it('injects 500s and disconnects on tagged requests and records what reached the wire', async () => {
    const mock = await startMock({ models: ['m'], fault500Rate: 1, pricing: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } });
    try {
      const failed = await post(`${mock.url}/v1/chat/completions`, { model: 'm', messages: [{ role: 'user', content: '[req:f1] hi' }] });
      assert.equal(failed.status, 500);
      // Untagged requests (health probes) never get faults.
      assert.equal((await post(`${mock.url}/v1/chat/completions`, { model: 'm', messages: [{ role: 'user', content: 'probe' }] })).status, 200);
      mock.setFaults({ fault500Rate: 0, disconnectRate: 1 });
      await assert.rejects(post(`${mock.url}/v1/chat/completions`, { model: 'm', messages: [{ role: 'user', content: '[req:d1] hi' }] }));
      // The cut can land before or after the client sees the headers.
      await assert.rejects(async () => (await post(`${mock.url}/v1/chat/completions`, { model: 'm', stream: true, messages: [{ role: 'user', content: '[req:d2] hi' }] })).text());
      const ledger = mock.deliveries();
      assert.deepEqual([ledger.byTag.f1.status, ledger.byTag.f1.started], ['500', false]);
      assert.deepEqual([ledger.byTag.d1.status, ledger.byTag.d1.started], ['disconnect', false]);
      assert.deepEqual([ledger.byTag.d2.status, ledger.byTag.d2.started], ['disconnect', true]);
      // Only the probe was delivered in full; the cut stream counts toward the most the buyer could owe.
      assert.equal(ledger.deliveredCost, '18');
      assert.equal(ledger.startedCost, '36');
    } finally {
      await mock.stop();
    }
  });

  it('prices images per image plus prompt tokens', () => {
    assert.equal(usageCost({ inputUsdPerMillion: 3, imageUsd: 0.04 }, { prompt: 10, images: 2 }), 30n + 80_000n);
    const totals = summarizeDeliveries(new Map([['a', { status: 'ok', started: true, cost: '5' }], ['b', { status: 'client-gone', started: true, cost: '7' }]]));
    assert.deepEqual([totals.deliveredCost, totals.startedCost, totals.counts], ['5', '12', { ok: 1, 'client-gone': 1 }]);
  });
});

describe('stress topology options', () => {
  it('defaults to direct RPCs, fixed mock usage and no caps', () => {
    const topology = normalizeTopology({}, source);
    assert.deepEqual(topology.chain, { rpc: 'direct' });
    assert.deepEqual(topology.sellers[0].mock, { latencyMs: 0, usage: 'fixed', fault500Rate: 0, disconnectRate: 0 });
    assert.equal(topology.buyer.maxReserveMicros, undefined);
  });

  it('normalizes the stress network: Base-like RPCs with 2 s blocks, load mock, caps, top-up threshold', () => {
    const topology = normalizeTopology(stressTopology({ buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' } }), source);
    assert.deepEqual(topology.chain, { rpc: 'base', blockTimeSec: 2, topUpThresholdBps: 6500 });
    assert.deepEqual(topology.sellers[0].mock, { latencyMs: 0, usage: 'load', fault500Rate: 0, disconnectRate: 0, latencyRangeMs: [50, 3000], outTokens: [100, 4000] });
    assert.equal(topology.buyer.depositMicros, '500000000');
    assert.equal(topology.buyer.maxReserveMicros, '250000');
    assert.equal(topology.buyer.maxPerRequestMicros, '150000');
    assert.equal(topology.payments.settlementIdleMs, 15_000);
    assert.equal(topology.payments.minBudgetPerRequestMicros, '10000');
    assert.equal(topology.mode, 'cli');
    assert.match(topologyFingerprint(topology), /~load#rpc=base#mode=cli$/);
    assert.equal(normalizeTopology(stressTopology({ mode: 'sdk' }), source).mode, 'sdk');
    assert.notEqual(topologyFingerprint(topology), topologyFingerprint(normalizeTopology({ ...stressTopology(), chain: { rpc: 'direct' } }, source)));
  });

  it('rejects bad stress options', () => {
    assert.throws(() => normalizeTopology({ chain: { rpc: 'mainnet' } }, source), /chain.rpc/);
    assert.throws(() => normalizeTopology({ chain: { blockTimeSec: 0 } }, source), /blockTimeSec/);
    assert.throws(() => normalizeTopology({ chain: { topUpThresholdBps: 20_000 } }, source), /topUpThresholdBps/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { fault500Rate: 2 } }] }, source), /fault500Rate/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { usage: 'chaos' } }] }, source), /mock.usage/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { outTokens: [1, 2] } }] }, source), /usage 'load'/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { usage: 'load', latencyRangeMs: [5, 1] } }] }, source), /latencyRangeMs/);
    assert.throws(() => normalizeTopology({ buyer: { maxReserveUsdc: '0' } }, source), /maxReserveUsdc/);
  });
});

describe('stress load and gates', () => {
  it('classifies failures like the stress harness', () => {
    assert.equal(classifyError(500, JSON.stringify({ error: { type: 'server_error' } })), '500:server_error');
    assert.equal(classifyError(402, JSON.stringify({ error: 'payment_required', reason: 'budget' })), '402:payment_required/budget');
    assert.equal(classifyError(502, 'Upstream   error'), '502:Upstream error');
  });

  it('applies the CI gates: ok floor, allowed failure kinds, restart window', () => {
    const client = { total: 100, ok: 80, clientAborted: 10, failed: 10, failures: { '500:server_error': 8, 'fetch:ECONNRESET': 2 } };
    assert.deepEqual(gateProblems(client, GATES.faults), ['unexpected failure kind: fetch:ECONNRESET (2)']);
    assert.match(gateProblems(client, GATES.default)[0], /80\/100 ok, below the 99% floor/);
    assert.deepEqual(gateProblems({ total: 10, ok: 10, clientAborted: 0, failures: {}, failedOutsideRestartWindow: 1 }, GATES['restart-buyer']), ['1 failures outside the restart window']);
  });

  it('takes nearest-rank percentiles, null with no samples', () => {
    const hundred = Array.from({ length: 100 }, (_, index) => 100 - index);
    assert.deepEqual(latencyPercentiles(hundred), { p50Ms: 51, p95Ms: 96, p99Ms: 100, maxMs: 100 });
    assert.deepEqual(latencyPercentiles([7]), { p50Ms: 7, p95Ms: 7, p99Ms: 7, maxMs: 7 });
    assert.deepEqual(latencyPercentiles([]), { p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
  });

  it('summarizes successful requests only, split by streaming, with throughput', () => {
    const summary = clientSummary([
      { start: 0, ms: 100, stream: true, ttfbMs: 40 },
      { start: 0, ms: 300, stream: true, ttfbMs: 60 },
      { start: 100, ms: 200 },
      { start: 100, ms: 900, error: '500:server_error', stream: true, ttfbMs: 1 },
      { start: 200, ms: 800, clientAborted: true },
    ]);
    assert.deepEqual([summary.p50Ms, summary.p95Ms, summary.p99Ms, summary.maxMs], [200, 300, 300, 300]);
    assert.deepEqual([summary.streamed.count, summary.streamed.p50Ms, summary.streamed.maxMs], [2, 300, 300]);
    assert.deepEqual(summary.streamed.ttfb, { p50Ms: 60, p95Ms: 60, p99Ms: 60, maxMs: 60 });
    assert.deepEqual([summary.nonStreamed.count, summary.nonStreamed.maxMs], [1, 200]);
    // 3 ok over the 1000 ms from the first start to the last end.
    assert.equal(summary.okPerSecond, 3);
    assert.equal(clientSummary([]).okPerSecond, null);
    assert.equal(clientSummary([]).streamed.ttfb.p95Ms, null);
  });

  it('times the first byte of a real stream', async () => {
    const mock = await startMock({ models: ['m'], pricing: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } });
    try {
      const run = await runLoad({ proxyUrl: mock.url, model: 'm', load: { concurrency: 2, requests: 4, streamRatio: 1, minInTokens: 1, maxInTokens: 2 } });
      assert.equal(run.client.streamed.count, 4);
      for (const record of run.results) assert.ok(record.ttfbMs >= 0 && record.ttfbMs <= record.ms);
      assert.ok(run.client.okPerSecond > 0);
    } finally {
      await mock.stop();
    }
  });

  it('splits failures inside and outside a restart window', () => {
    const results = [
      { start: 1000, ms: 100, error: 'a' }, // ends before the window
      { start: 5000, ms: 100, error: 'b' }, // inside
      { start: 40_000, ms: 10, error: 'c' }, // after window end (4000 + 1000 + 15000)
      { start: 6000, ms: 50 },
    ];
    const summary = clientSummary(results, { startedAt: 0, restart: { stoppedAt: 4000, downMs: 1000 } });
    assert.deepEqual([summary.failed, summary.failedInRestartWindow, summary.failedOutsideRestartWindow, summary.ok], [3, 1, 2, 1]);
  });

  it('merges ledgers, skipping tags recorded before the run', () => {
    const merged = mergeDeliveries([
      { byTag: { old: { status: 'ok', cost: '100' }, a: { status: 'ok', cost: '5' } } },
      { byTag: { b: { status: '500', cost: '9' }, c: { status: 'ok', cost: '7' } } },
    ], new Set(['old']));
    assert.equal(merged.expectedCostBaseUnits, 12n);
    assert.deepEqual([...merged.perRequest.keys()].sort(), ['a', 'b', 'c']);
  });

  it('runs tagged load against an OpenAI-compatible endpoint and restarts once mid-load', async () => {
    const mock = await startMock({ models: ['m'], pricing: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } });
    try {
      let restarts = 0;
      const run = await runLoad({
        proxyUrl: mock.url, model: 'm', random: sequence(0.9, 0.1, 0.9),
        load: { concurrency: 3, requests: 9, streamRatio: 0.5, minInTokens: 1, maxInTokens: 2, restart: { atFraction: 0.5, run: async () => { restarts += 1; } } },
      });
      assert.equal(run.results.length, 9);
      assert.equal(run.client.ok, 9);
      assert.equal(restarts, 1);
      assert.ok(run.restart && run.restart.downMs >= 0);
      const ledger = mock.deliveries();
      for (const record of run.results) assert.equal(ledger.byTag[record.tag]?.status, 'ok', record.tag);
    } finally {
      await mock.stop();
    }
  });

  it('sums the estimated cost header per request, null when no response carried it', async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.url === '/v1/chat/completions') response.setHeader('x-antseed-estimated-cost-usd', '0.000125');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{}], usage: {} }));
      });
    });
    await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
    try {
      const run = await runLoad({ proxyUrl: `http://127.0.0.1:${server.address().port}`, model: 'm', load: { concurrency: 2, requests: 4, streamRatio: 0, minInTokens: 1, maxInTokens: 2 } });
      assert.deepEqual(run.results.map((record) => record.costHeader), Array(4).fill('0.000125'));
      assert.equal(run.client.estimatedCostUsd, 0.0005);
      assert.equal(clientSummary([{ start: 0, ms: 1 }]).estimatedCostUsd, null);
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });
});

describe('stress verdict', () => {
  it('tb.load evaluates the gate without throwing or recording; checkGate records it', async () => {
    const mock = await startMock({ models: ['m'], pricing: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } });
    try {
      await withTb({ proxyUrl: mock.url }, async (tb) => {
        const run = await tb.load({ concurrency: 1, requests: 2, streamRatio: 0, minInTokens: 1, maxInTokens: 2, gate: { minOk: 1.01 } });
        assert.equal(run.client.ok, 2);
        assert.match(run.gateProblems[0], /2\/2 ok, below the 101% floor/);
        assert.deepEqual(tb.summary().checks, []);
        assert.throws(() => tb.checkGate(run), /below the 101% floor/);
        const [check] = tb.summary().checks;
        assert.equal(check.ok, false);
        assert.match(check.name, /^load gate: at least 101% ok/);
        const passing = await tb.load({ concurrency: 1, requests: 1, streamRatio: 0, minInTokens: 1, maxInTokens: 2, gate: GATES.default });
        assert.deepEqual(passing.gateProblems, []);
        tb.checkGate(passing);
        assert.equal(tb.summary().checks[1].ok, true);
        assert.deepEqual((await tb.load({ concurrency: 1, requests: 1, streamRatio: 0, minInTokens: 1, maxInTokens: 2 })).gateProblems, []);
      });
    } finally {
      await mock.stop();
    }
  });

  it('stressRun switches faults off, then judges in order: oracle, crashes, gate', async () => {
    const tb = fakeTb();
    await stressRun(tb, { load: {}, faults: { fault500Rate: 0.1 } });
    assert.deepEqual(tb.calls, ['snapshot', 'warm-up', 'faults on', 'load', 'faults off', 'oracle', 'crashes', 'gate', 'timings']);
  });

  it('stressRun runs every verdict after a failure and reports them all', async () => {
    const tb = fakeTb(['oracle', 'crashes', 'gate']);
    await assert.rejects(stressRun(tb, { load: {} }), /oracle failed\ncrashes failed\ngate failed/);
    assert.deepEqual(tb.calls.slice(-4), ['oracle', 'crashes', 'gate', 'timings']);
    const oracleOnly = fakeTb(['oracle']);
    await assert.rejects(stressRun(oracleOnly, { load: {} }), /^Error: oracle failed$/);
    assert.deepEqual(oracleOnly.calls.slice(-4), ['oracle', 'crashes', 'gate', 'timings']);
  });

  it('a load that throws still switches faults off and scans for crashes, with nothing to judge', async () => {
    const tb = fakeTb(['load']);
    await assert.rejects(stressRun(tb, { load: {}, faults: { fault500Rate: 0.1 } }), /load failed/);
    assert.deepEqual(tb.calls.slice(-3), ['load', 'faults off', 'crashes']);
  });

  it('runAll runs every step and rethrows the only error unchanged', async () => {
    const original = new Error('one');
    const ran = [];
    await assert.rejects(runAll([() => { ran.push(1); throw original; }, () => ran.push(2)]), (error) => error === original);
    assert.deepEqual(ran, [1, 2]);
    await runAll([() => ran.push(3)]);
  });

  it('runAll keeps joined failed checks an assertion, so the run is failed and not error', async () => {
    const failedCheck = () => assert.fail('a check');
    const broke = () => { throw new Error('the control API'); };
    const caught = await runAll([failedCheck, failedCheck]).catch((error) => error);
    assert.equal(caught.message, 'a check\na check');
    assert.equal(classifyScenarioError(caught), 'failed');
    assert.equal(classifyScenarioError(await runAll([failedCheck, broke]).catch((error) => error)), 'error');
  });

  it('records what the load measured as flat metrics, also when a verdict failed', async () => {
    const tb = fakeTb(['oracle']);
    await assert.rejects(stressRun(tb, { load: {} }));
    assert.equal(tb.metrics.loadMs, 5);
    assert.ok('p95Ms' in tb.metrics && 'ttfbP95Ms' in tb.metrics && 'okPerSecond' in tb.metrics);
    assert.equal('restartDownMs' in tb.metrics, false);
  });

  it('flattens restart timings', () => {
    const timings = loadTimings({ client: clientSummary([]), loadMs: 1, restart: { downMs: 700, settleOnDisconnectMs: 900 } });
    assert.deepEqual([timings.restartDownMs, timings.settleOnDisconnectMs], [700, 900]);
  });

  it('fails when paid requests left no seller cost lines', () => {
    const missing = costLinesCheck([{ status: 200 }, { error: 'x' }], 0);
    assert.equal(missing.ok, false);
    assert.equal(missing.name, 'seller cost lines missing (ANTSEED_DEBUG not set?)');
    assert.deepEqual(missing.detail, { okRequests: 1 });
    assert.equal(costLinesCheck([{ status: 200 }], 3).ok, true);
    // Nothing got through, so no cost line was due.
    assert.equal(costLinesCheck([{ error: 'x' }, { clientAborted: true }], 0), null);
    assert.equal(costLinesCheck([], 0), null);
  });

  it('issue-1050 gates both loads as one: a bad second load fails though the first was clean', () => {
    const clean = Array.from({ length: 24 }, (_, index) => ({ i: index, start: 0, ms: 1 }));
    const bad = clean.map((entry, index) => (index < 3 ? { ...entry, error: '500:server_error' } : entry));
    const combined = combinedGate([...clean, ...bad]);
    assert.equal(combined.client.total, 48);
    assert.deepEqual(combined.gateProblems, ['45/48 ok, below the 95% floor']);
    assert.deepEqual(combinedGate([...clean, ...clean]).gateProblems, []);
    // 47/48 clears the floor a second load of 23/24 alone would not have to share.
    assert.deepEqual(combinedGate([...clean, ...clean.map((entry, index) => (index === 0 ? { ...entry, error: 'x' } : entry))]).gateProblems, []);
  });
});

describe('peer logs', () => {
  it('finds the leak the stress harness finds, with its exclusions', () => {
    assert.deepEqual(externalHosts('POST http://10.1.2.3:8545 then https://8.8.8.8/x and http://10.1.2.3:1'), ['10.1.2.3', '8.8.8.8']);
    assert.deepEqual(externalHosts('rpc http://0.0.0.0:1'), ['0.0.0.0']);
    assert.deepEqual(externalHosts('http://127.0.0.1:8545 http://127.9.9.9:1 https://base.org ws://8.8.8.8 peer 8.8.8.8:6881 http://[::1]:1'), []);
    assert.equal(externalHosts(Array.from({ length: 9 }, (_, index) => `http://9.9.9.${index}`).join(' ')).length, 5);
  });

  it('reads the bootstrap count of every node start', () => {
    assert.deepEqual(bootstrapCounts(`${STARTED}x\n[Node] Starting as buyer with 12 bootstrap node(s)\n`), [1, 12]);
    assert.deepEqual(bootstrapCounts('no such line'), []);
  });

  it('counts the seller and buyer patterns per line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-patterns-'));
    try {
      const file = join(dir, 'seller-a.log');
      await writeFile(file, 'old Rejecting underfunded SpendingAuth\n');
      const offsets = { [file]: 39 };
      await appendFile(file, 'Rejecting underfunded SpendingAuth\nSpendingAuth behind spend, accepted\nTop-up on-chain failed permanently\nTop-up threshold not met\nTypeError: x\n');
      const seller = await countPatterns([file], offsets, SELLER_PATTERNS);
      assert.deepEqual(Object.keys(seller), Object.keys(SELLER_PATTERNS));
      assert.deepEqual([seller.rejectUnderfunded, seller.behindSpendAccepted, seller.topUpPermanentFail, seller.topUpDeferred, seller.typeError, seller.crash], [1, 1, 1, 1, 1, 0]);
      const whole = await countPatterns([file, join(dir, 'missing.log')], {}, SELLER_PATTERNS);
      assert.equal(whole.rejectUnderfunded, 2);
      await writeFile(file, 'NeedAuth stale for x\nCooperative close of y\n');
      const buyer = await countPatterns([file], {}, BUYER_PATTERNS);
      assert.deepEqual([buyer.needAuthStale, buyer.closeCoop, buyer.overdraft], [1, 1, 0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the same patterns as the stress harness', () => {
    const harness = readFileSync(new URL('../../stress/harness.mjs', import.meta.url), 'utf8');
    const object = (name) => new Function(`return ${harness.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`))[1]}`)();
    const sources = (patterns) => Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, String(pattern)]));
    assert.deepEqual(sources(SELLER_PATTERNS), sources(object('SELLER_PATTERNS')));
    assert.deepEqual(sources(BUYER_PATTERNS), sources(object('BUYER_PATTERNS')));
    assert.equal(String(CRASH_PATTERN), String(object('SELLER_PATTERNS').crash));
  });

  it('picks the buyer log in both modes and scans every peer log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-logs-'));
    const names = (logs) => logs.all.map((file) => file.slice(dir.length + 1)).sort();
    try {
      for (const name of ['supervisor.log', 'seller-a.log', 'seller-b.log', 'anvil.log']) await writeFile(join(dir, name), '');
      const together = peerLogs(dir);
      assert.equal(together.buyer, join(dir, 'supervisor.log'));
      assert.deepEqual(names(together), ['seller-a.log', 'seller-b.log', 'supervisor.log']);
      await writeFile(join(dir, 'buyer.log'), 'old');
      const apart = peerLogs(dir);
      assert.equal(apart.buyer, join(dir, 'buyer.log'));
      assert.deepEqual(names(apart), ['buyer.log', 'seller-a.log', 'seller-b.log', 'supervisor.log']);
      assert.deepEqual(peerLogs(null), { all: [], buyer: null });
      // A buyer.log from an earlier `up` that this one has not written to is still scanned, but it is not the buyer's.
      const stale = peerLogs(dir, { [join(dir, 'buyer.log')]: 3 });
      assert.equal(stale.buyer, join(dir, 'supervisor.log'));
      assert.deepEqual(names(stale), names(apart));
      await appendFile(join(dir, 'buyer.log'), 'new');
      assert.equal(peerLogs(dir, { [join(dir, 'buyer.log')]: 3 }).buyer, join(dir, 'buyer.log'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const startedLogs = { 'seller-seller.log': STARTED, 'supervisor.log': STARTED };

  it('assertIsolated passes on loopback traffic, ignoring leaks from before the run and old sellers', async () => {
    const logs = { 'seller-seller.log': `http://10.0.0.1 before the run\n${STARTED}`, 'supervisor.log': STARTED, 'seller-old-topology.log': 'http://8.8.8.8\n' };
    await withTb({ logs }, async (tb, { append }) => {
      await append('seller-seller.log', 'rpc http://127.0.0.1:8545\n');
      await tb.assertIsolated();
      assert.deepEqual(tb.summary().checks.map((check) => [check.name, check.ok]), [
        ['no peer log names a non-loopback IPv4 URL', true],
        ['every peer started with exactly 1 bootstrap node', true],
      ]);
    });
  });

  it('assertIsolated finds a leak in a seller log, the supervisor log and a separate buyer log', async () => {
    await withTb({ logs: { ...startedLogs, 'buyer.log': STARTED } }, async (tb, { append }) => {
      await append('seller-seller.log', 'GET http://10.0.0.1:1\n');
      await append('supervisor.log', 'GET http://10.0.0.2:1\n');
      await append('buyer.log', 'GET https://10.0.0.3/\n');
      await assert.rejects(tb.assertIsolated(), /non-loopback IPv4 URL/);
      assert.deepEqual(tb.summary().checks[0].detail, { 'buyer.log': ['10.0.0.3'], 'seller-seller.log': ['10.0.0.1'], 'supervisor.log': ['10.0.0.2'] });
    });
  });

  it('assertIsolated fails on a missing line or another bootstrap count, also after a restart', async () => {
    await withTb({ logs: { 'seller-seller.log': 'started without debug\n', 'supervisor.log': STARTED } }, async (tb) => {
      await assert.rejects(tb.assertIsolated(), /exactly 1 bootstrap node/);
    });
    await withTb({ logs: startedLogs }, async (tb, { append }) => {
      await append('seller-seller.log', '[Node] Starting as seller with 3 bootstrap node(s)\n');
      await assert.rejects(tb.assertIsolated(), /exactly 1 bootstrap node/);
      assert.deepEqual(tb.summary().checks[1].detail['seller-seller.log'], [1, 3]);
    });
  });

  it('assertIsolated does not count a start line from an earlier `up`: logs/ survives one', async () => {
    const earlier = { 'seller-seller.log': STARTED, 'supervisor.log': STARTED };
    const upStart = { 'seller-seller.log': STARTED.length, 'supervisor.log': 0 };
    await withTb({ logs: earlier, upStart }, async (tb) => {
      await assert.rejects(tb.assertIsolated(), /exactly 1 bootstrap node/);
      assert.deepEqual(tb.summary().checks[1].detail, { 'seller-seller.log': [], 'supervisor.log': [1] });
    });
    await withTb({ logs: { ...earlier, 'seller-seller.log': `${STARTED}${STARTED}` }, upStart }, async (tb) => {
      await tb.assertIsolated();
    });
  });

  it('assertNoCrashes covers every peer, records all checks before it fails and counts patterns', async () => {
    const health = {
      ...CLEAN_HEALTH,
      unexpectedExits: [{ who: 'buyer', code: 1, signal: null, at: 't' }],
      forcedStops: [{ who: 'seller:seller', afterMs: 15000, at: 't' }, { who: 'buyer', afterMs: 15000, at: 't' }],
    };
    await withTb({ logs: startedLogs, health }, async (tb, { append }) => {
      await append('seller-seller.log', 'FATAL boom\nRejecting underfunded SpendingAuth\nGET http://10.0.0.1\n');
      await append('supervisor.log', 'NeedAuth stale\n');
      await assert.rejects(tb.assertNoCrashes(), (error) => /no peer exited unexpectedly/.test(error.message) && /non-loopback IPv4 URL/.test(error.message));
      const { checks, metrics } = tb.summary();
      assert.deepEqual(checks.map((check) => [check.name, check.ok]), [
        ['no crash lines in peer logs', false],
        ['no peer exited unexpectedly', false],
        ['no peer needed SIGKILL to stop', false],
        ['no unhandled rejections', true],
        ['no peer log names a non-loopback IPv4 URL', false],
        ['every peer started with exactly 1 bootstrap node', true],
      ]);
      assert.deepEqual(checks[1].detail, [{ id: 'buyer', code: 1, signal: null, at: 't' }]);
      assert.deepEqual(checks[2].detail.map((entry) => entry.id), ['seller:seller', 'buyer']);
      assert.equal(metrics.logPatterns.seller.rejectUnderfunded, 1);
      assert.equal(metrics.logPatterns.seller.crash, 1);
      assert.equal(metrics.logPatterns.buyer.needAuthStale, 1);
      assert.equal(metrics.logPatterns.buyer.crash, 0);
    });
  });

  it('assertNoCrashes passes on a clean run', async () => {
    await withTb({ logs: startedLogs }, async (tb) => {
      await tb.assertNoCrashes();
      assert.equal(tb.summary().checks.filter((check) => !check.ok).length, 0);
      assert.equal(tb.summary().checks.length, 6);
    });
  });
});

describe('budgets', () => {
  it('without --budgets records the value next to the budget and adds no check, even over it', async () => {
    await withTb({}, async (tb) => {
      tb.budget('p95Ms', 900, { max: 500 });
      tb.budget('rate', 2, { max: 5, unit: 'x' });
      const { checks, metrics } = tb.summary();
      assert.deepEqual(checks, []);
      assert.equal(metrics.p95Ms, 900);
      assert.deepEqual(metrics.budgets.p95Ms, { value: 900, max: 500, unit: 'ms', ok: false, enforced: false });
      assert.deepEqual(metrics.budgets.rate, { value: 2, max: 5, unit: 'x', ok: true, enforced: false });
    });
  });

  it('with --budgets adds a check, and over budget fails as an assertion', async () => {
    await withTb({ enforceBudgets: true }, async (tb) => {
      tb.budget('closeAllMs', 500, { max: 500 });
      const failure = await Promise.resolve().then(() => tb.budget('p95Ms', 900, { max: 500 })).catch((error) => error);
      assert.equal(classifyScenarioError(failure), 'failed');
      assert.match(failure.message, /budget: p95Ms <= 500 ms/);
      const { checks, metrics } = tb.summary();
      assert.deepEqual(checks.map((check) => [check.name, check.ok]), [['budget: closeAllMs <= 500 ms', true], ['budget: p95Ms <= 500 ms', false]]);
      assert.deepEqual(checks[1].detail, { value: 900, max: 500, unit: 'ms' });
      assert.equal(metrics.p95Ms, 900);
      assert.equal(metrics.budgets.p95Ms.enforced, true);
    });
  });

  it('tb.timings budgets declared keys, keeps the rest as metrics and reads recorded metrics', async () => {
    await withTb({ budgets: { p95Ms: 100, closeAllMs: 50 }, enforceBudgets: true }, async (tb) => {
      tb.metric('closeAllMs', 40);
      tb.timings({ p95Ms: 90, loadMs: 1000, settleOnDisconnectMs: null });
      const { checks, metrics } = tb.summary();
      assert.deepEqual(checks.map((check) => check.name), ['budget: p95Ms <= 100 ms', 'budget: closeAllMs <= 50 ms']);
      assert.equal(metrics.loadMs, 1000);
      assert.equal('loadMs' in metrics.budgets, false);
      assert.equal(tb.budgets.p95Ms, 100);
    });
  });

  it('tb.timings records every budget before it fails, and a declared key nothing measured is over', async () => {
    await withTb({ budgets: { p95Ms: 100, typoMs: 50 }, enforceBudgets: true }, async (tb) => {
      assert.throws(() => tb.timings({ p95Ms: 900 }), /budget: p95Ms <= 100 ms.*budget: typoMs <= 50 ms/);
      const { checks, metrics } = tb.summary();
      assert.deepEqual(checks.map((check) => check.ok), [false, false]);
      assert.equal(checks[1].detail.value, 'not measured');
      assert.deepEqual(metrics.budgets.typoMs, { value: null, max: 50, unit: 'ms', ok: false, enforced: true });
    });
    await withTb({ budgets: { p95Ms: 100 } }, async (tb) => {
      tb.timings({ p95Ms: 900 });
      assert.deepEqual(tb.summary().checks, []);
      assert.equal(tb.summary().metrics.budgets.p95Ms.ok, false);
    });
  });

  it('refuses a budget without a positive max', async () => {
    await withTb({}, async (tb) => {
      assert.throws(() => tb.budget('p95Ms', 1, {}), /positive max/);
      assert.throws(() => tb.budget('p95Ms', 1, { max: 0 }), /positive max/);
    });
  });

  it('stressTopology carries budgets past normalization, outside the network the fingerprint compares', () => {
    const topology = stressTopology({ budgets: { p95Ms: 6000 } });
    assert.deepEqual(topology.budgets, { p95Ms: 6000 });
    assert.equal('budgets' in stressTopology(), false);
    assert.equal(topologyFingerprint(normalizeTopology(topology, source)), topologyFingerprint(normalizeTopology(stressTopology(), source)));
  });

  it('scenario validation reads budgets and refuses bad ones', () => {
    const run = async () => {};
    assert.deepEqual(validateScenarioModule({ run, topology: { budgets: { p95Ms: 6000 } } }, 'a').budgets, { p95Ms: 6000 });
    assert.deepEqual(validateScenarioModule({ run }, 'a').budgets, {});
    assert.throws(() => validateScenarioModule({ run, topology: { budgets: { p95Ms: 'fast' } } }, 'a'), /topology.budgets.p95Ms/);
    assert.throws(() => validateScenarioModule({ run, topology: { budgets: { p95Ms: 0 } } }, 'a'), /topology.budgets.p95Ms/);
  });
});

describe('node env', () => {
  it('stress nodes run with ANTSEED_DEBUG, and overrides merge', () => {
    const topology = normalizeTopology(stressTopology({ seller: { env: { ANTSEED_LOG_FILTER: 'node' } }, buyer: { env: { ANTSEED_LOG_FILTER: 'proxy' } } }), source);
    assert.deepEqual(topology.sellers[0].env, { ANTSEED_DEBUG: '1', ANTSEED_LOG_FILTER: 'node' });
    assert.deepEqual(topology.buyer.env, { ANTSEED_DEBUG: '1', ANTSEED_LOG_FILTER: 'proxy' });
    assert.deepEqual(normalizeTopology(stressTopology(), source).sellers[0].env, { ANTSEED_DEBUG: '1' });
  });

  it('other topologies set none, and env cannot reach past AntSeed switches', () => {
    const topology = normalizeTopology({}, source);
    assert.equal('env' in topology.sellers[0], false);
    assert.equal('env' in topology.buyer, false);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', env: { HOME: '/tmp' } }] }, source), /seller a env/);
    assert.throws(() => normalizeTopology({ buyer: { env: { ANTSEED_IDENTITY_HEX: 'aa' } } }, source), /buyer env/);
    assert.throws(() => normalizeTopology({ buyer: { env: { ANTSEED_DEBUG: 1 } } }, source), /buyer env/);
  });
});

describe('tb.request', () => {
  const withMockTb = async (test) => {
    const mock = await startMock({ models: ['m'], pricing: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } });
    try {
      await withTb({ proxyUrl: mock.url }, (tb) => test(tb, mock));
    } finally {
      await mock.stop();
    }
  };

  it('GETs without a body and returns status, headers and parsed JSON', async () => {
    await withMockTb(async (tb) => {
      const reply = await tb.request('/v1/models');
      assert.equal(reply.status, 200);
      assert.match(reply.headers['content-type'], /json/);
      assert.deepEqual(reply.json.data.map((model) => model.id), ['m']);
      assert.equal(JSON.parse(reply.text).data.length, 1);
      assert.ok(reply.latencyMs >= 0);
    });
  });

  it('POSTs a JSON body, and hands back the raw SSE with stream', async () => {
    await withMockTb(async (tb) => {
      const messages = [{ role: 'user', content: 'hi' }];
      const plain = await tb.request('/v1/chat/completions', { body: { model: 'm', messages } });
      assert.equal(plain.status, 200);
      assert.ok(plain.json.choices[0].message.content.length > 0);
      const stream = await tb.request('/v1/chat/completions', { body: { model: 'm', messages, stream: true }, stream: true });
      assert.equal(stream.json, null);
      assert.match(stream.text, /^data: /m);
      assert.equal(parseSse(stream.text).done, true);
      const images = await tb.request('/v1/images/generations', { body: JSON.stringify({ model: 'm', prompt: 'an ant' }), headers: { 'content-type': 'application/json' } });
      assert.equal(images.json.data.length, 1);
    });
  });

  it('honors an explicit method and keeps a body that is not JSON', async () => {
    const seen = [];
    const server = createServer((request, response) => {
      seen.push([request.method, request.headers['x-test']]);
      request.resume();
      response.statusCode = 503;
      response.end('down');
    });
    await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
    try {
      await withTb({ proxyUrl: `http://127.0.0.1:${server.address().port}` }, async (tb) => {
        const reply = await tb.request('/x', { method: 'DELETE', headers: { 'x-test': 'yes' } });
        assert.deepEqual([reply.status, reply.json, reply.text], [503, null, 'down']);
        assert.deepEqual(seen, [['DELETE', 'yes']]);
      });
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });

  it('tb.chat goes through it for plain and streaming chats and still throws on an error', async () => {
    await withMockTb(async (tb, mock) => {
      const plain = await tb.chat({ model: 'm' });
      assert.ok(plain.content.length > 0);
      assert.ok(plain.usage.total_tokens > 0);
      const streamed = await tb.chat({ model: 'm', stream: true });
      assert.ok(streamed.content.length > 0);
      assert.ok(streamed.usage.total_tokens > 0);
      mock.setFaults({ fault500Rate: 1, disconnectRate: 0 });
      await assert.rejects(tb.chat({ model: 'm', prompt: '[req:bad] hi' }), /failed with 500/);
      assert.equal(tb.summary().metrics.requests, 3);
    });
  });
});
