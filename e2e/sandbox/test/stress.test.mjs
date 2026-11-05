import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeConfig, DEFAULT_SOURCE_CONFIG } from '../lib/config.mjs';
import { startMock, summarizeDeliveries, usageCost } from '../lib/mock.mjs';
import { parseSse } from '../lib/sb.mjs';
import { classifyError, clientSummary, GATES, gateProblems, mergeDeliveries, runLoad, stressTopology } from '../lib/stress.mjs';
import { normalizeTopology, topologyFingerprint } from '../lib/topology.mjs';

const source = sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// Deterministic stand-in for Math.random: cycles through the given values.
const sequence = (...values) => { let index = 0; return () => values[index++ % values.length]; };

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
    assert.match(topologyFingerprint(topology), /~load#rpc=base$/);
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
});
