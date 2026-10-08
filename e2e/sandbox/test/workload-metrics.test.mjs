import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAllowedSellers, checkChannelSamples, checkDeliveredCost, checkRequestAccounting, checkSettlement, usageCostMicros } from '../lib/invariants.mjs';
import { aggregateRuns, flattenNumeric, gini, keyMetrics, meanCi, percentile, summarizeWorkload } from '../lib/metrics.mjs';
import { parseArgs } from '../lib/options.mjs';
import { createRng } from '../lib/random.mjs';
import { arrivalTimes, classifyFailure, executePlan, normalizePersona, normalizeWorkload, planWorkload, promptText } from '../lib/workload.mjs';

function virtualClock() {
  let now = 0;
  const timers = [];
  let draining = null;
  const clock = {
    now: () => now,
    sleep(ms, signal) {
      if (ms <= 0 || signal?.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = { at: now + ms, resolve };
        timers.push(timer);
        signal?.addEventListener('abort', () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); resolve(); }, { once: true });
      });
    },
    async run(promise) {
      let done = false;
      const result = promise.finally(() => { done = true; });
      while (!done) {
        await new Promise((resolve) => setImmediate(resolve));
        if (done) break;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (!next) continue;
        now = Math.max(now, next.at);
        next.resolve();
      }
      return result;
    },
  };
  void draining;
  return clock;
}

describe('personas and workloads', () => {
  it('ships valid personas and workloads', () => {
    for (const name of ['desktop-chat', 'coding-agent', 'api-batch']) {
      const persona = normalizePersona(name);
      assert.equal(persona.name, name);
      assert.ok(persona.abandonAfterMs > 0);
    }
    const mixed = normalizeWorkload('mixed');
    assert.deepEqual(mixed.personas.map((persona) => persona.name), ['desktop-chat', 'coding-agent', 'api-batch']);
    const total = mixed.personas.reduce((sum, persona) => sum + persona.sessionsPerMinute, 0);
    assert.ok(Math.abs(total - mixed.sessionsPerMinute) < 1e-9);
    assert.ok(normalizeWorkload('chat-only').personas.length === 1);
  });

  it('validates persona and workload fields', () => {
    assert.throws(() => normalizePersona({ name: 'x', bogus: 1 }), /Unknown persona x key "bogus"/);
    assert.throws(() => normalizePersona({ name: 'x', streamRatio: 2 }), /streamRatio/);
    assert.throws(() => normalizePersona({ name: 'x', arrival: { process: 'burst' } }), /poisson or uniform/);
    assert.throws(() => normalizePersona({ name: 'x', models: {} }), /zipf or weights/);
    assert.throws(() => normalizePersona('nope'), /No persona "nope"/);
    assert.throws(() => normalizePersona({ name: 'Bad Name' }), /valid name/);
    assert.throws(() => normalizeWorkload({ personas: [] }), /at least one persona/);
    assert.throws(() => normalizeWorkload({ personas: ['api-batch', 'api-batch'] }), /Duplicate persona/);
    assert.throws(() => normalizeWorkload({ personas: ['api-batch'], maxInFlight: 0 }), /maxInFlight/);
    assert.throws(() => normalizeWorkload({ personas: ['api-batch'], extra: 1 }), /Unknown workload key/);
    const inline = normalizeWorkload({ personas: [{ name: 'p', arrival: { perMinute: 12 } }] });
    assert.equal(inline.personas[0].sessionsPerMinute, 12);
  });

  it('poisson arrivals hit the configured rate; uniform arrivals are evenly spaced', () => {
    const times = arrivalTimes({ perMinute: 60, durationMs: 600_000, rng: createRng(3) });
    assert.ok(times.length > 540 && times.length < 660, `got ${times.length}`);
    assert.ok(times.every((time, index) => time < 600_000 && (index === 0 || time >= times[index - 1])));
    assert.deepEqual(arrivalTimes({ process: 'uniform', perMinute: 2, durationMs: 60_000 }), [15_000, 45_000]);
    assert.deepEqual(arrivalTimes({ perMinute: 0, durationMs: 1000, rng: createRng(1) }), []);
  });

  it('plans are deterministic per seed and scale with the rate multiplier', () => {
    const args = { workload: 'mixed', models: ['a', 'b', 'c'], durationMs: 300_000 };
    assert.deepEqual(planWorkload({ ...args, seed: 4 }), planWorkload({ ...args, seed: 4 }));
    assert.notDeepEqual(planWorkload({ ...args, seed: 4 }).sessions, planWorkload({ ...args, seed: 5 }).sessions);
    const base = planWorkload({ ...args, seed: 4 }).sessions.length;
    const doubled = planWorkload({ ...args, seed: 4, rateMultiplier: 2 }).sessions.length;
    assert.ok(doubled > base * 1.6 && doubled < base * 2.4, `${base} -> ${doubled}`);
    assert.equal(planWorkload({ ...args, seed: 4, rateMultiplier: 0 }).sessions.length, 0);
  });

  it('zipf model popularity favours the first model; context carries across chat turns', () => {
    const plan = planWorkload({ workload: { personas: [{ name: 'p', arrival: { perMinute: 600 }, models: { zipf: 1.5 } }] }, models: ['a', 'b', 'c'], durationMs: 60_000, seed: 1 });
    const counts = { a: 0, b: 0, c: 0 };
    for (const session of plan.sessions) counts[session.model] += 1;
    assert.ok(counts.a > counts.b && counts.b > counts.c, JSON.stringify(counts));
    const chat = planWorkload({ workload: { personas: [{ name: 'c', arrival: { perMinute: 60 }, turns: 4, systemTokens: 100, inputTokens: 10, outputTokens: 20, carryContext: true }] }, models: ['m'], durationMs: 2000, seed: 1 });
    assert.deepEqual(chat.sessions[0].turns.map((turn) => turn.inputTokens), [110, 140, 170, 200]);
  });

  it('prompt text is deterministic and capped', () => {
    assert.equal(promptText(10, 1000, 't').length, 40);
    assert.equal(promptText(1_000_000, 500, 't').length, 500);
    assert.equal(promptText(5, 100, 'abc'), promptText(5, 100, 'abc'));
  });
});

describe('open-loop executor', () => {
  const plan = (sessions, extra = {}) => ({ seed: 1, durationMs: 100_000, maxInFlight: 100, maxPromptChars: 100, sessions, ...extra });
  const session = (id, startMs, turns, abandonAfterMs = 60_000) => ({ id, persona: 'p', startMs, model: 'm', abandonAfterMs, turns: turns.map((thinkMs, turn) => ({ turn, inputTokens: 10, outputTokens: 5, stream: true, thinkMs })) });

  it('starts sessions on schedule regardless of slow responses (no coordinated omission)', async () => {
    const clock = virtualClock();
    const sends = [];
    const send = async (request) => {
      sends.push({ id: request.sessionId, at: clock.now() });
      await clock.sleep(10_000);
      return { ok: true, status: 200, ttftMs: 100, latencyMs: 10_000, sellerId: 's1', usage: { prompt_tokens: 10, completion_tokens: 5 } };
    };
    const sessions = [0, 1000, 2000, 3000].map((startMs, index) => session(`s${index}`, startMs, [0]));
    const result = await clock.run(executePlan(plan(sessions), { send, clock }));
    assert.deepEqual(sends.map((entry) => entry.at), [0, 1000, 2000, 3000]);
    assert.equal(result.peakInFlight, 4);
    assert.ok(result.records.every((record) => record.ok && record.schedulingLagMs === 0));
  });

  it('turns follow the previous answer plus think time; late turns are skipped', async () => {
    const clock = virtualClock();
    const starts = [];
    const send = async () => { starts.push(clock.now()); await clock.sleep(500); return { ok: true, status: 200, sellerId: 's1' }; };
    const result = await clock.run(executePlan(plan([session('a', 0, [0, 1000, 99_000_000])]), { send, clock }));
    assert.deepEqual(starts, [0, 1500]);
    assert.equal(result.skippedTurns, 1);
  });

  it('accounts for overload drops and ends the session', async () => {
    const clock = virtualClock();
    const send = async () => { await clock.sleep(5000); return { ok: true, status: 200, sellerId: 's1' }; };
    const sessions = [session('a', 0, [0, 0]), session('b', 10, [0]), session('c', 20, [0])];
    const result = await clock.run(executePlan(plan(sessions), { send, clock, maxInFlight: 2 }));
    const dropped = result.records.filter((record) => record.errorClass === 'overload');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].sessionId, 'c');
    assert.equal(result.records.length, 4);
  });

  it('abandons slow requests as timeouts and stops that session', async () => {
    const clock = virtualClock();
    const send = (request, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, status: 0, errorClass: 'buyer', error: 'aborted' })));
    const result = await clock.run(executePlan(plan([session('a', 0, [0, 0], 3000)]), { send, clock }));
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].errorClass, 'timeout');
    assert.equal(result.records[0].latencyMs, 3000);
  });

  it('runs timeline actions at their offsets and records failures', async () => {
    const clock = virtualClock();
    const send = async () => ({ ok: true, status: 200, sellerId: 's1' });
    const result = await clock.run(executePlan(plan([session('a', 0, [0])]), {
      send, clock,
      timeline: [{ atMs: 4000, name: 'stop', action: async () => ({ stopped: true }) }, { atMs: 5000, name: 'boom', action: async () => { throw new Error('nope'); } }],
    }));
    assert.deepEqual(result.events.map(({ name, startMs, ok }) => [name, startMs, ok]), [['stop', 4000, true], ['boom', 5000, false]]);
  });

  it('classifies failures', () => {
    assert.equal(classifyFailure({ status: 502, headers: { 'x-antseed-peer-id': 'a' } }), 'seller');
    assert.equal(classifyFailure({ status: 503, body: 'No peers available' }), 'seller');
    assert.equal(classifyFailure({ status: 502, headers: { 'x-antseed-peer-id': 'a', 'x-antseed-fault-attribution': 'buyer' } }), 'buyer');
    assert.equal(classifyFailure({ status: 499 }), 'timeout');
    assert.equal(classifyFailure({ status: 200, truncated: true }), 'network');
    assert.equal(classifyFailure({ status: 400 }), 'buyer');
    assert.equal(classifyFailure({ networkError: true }), 'buyer');
  });
});

describe('metrics math', () => {
  it('nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 95);
    assert.equal(percentile(values, 99), 99);
    assert.equal(percentile(values, 100), 100);
    assert.equal(percentile([7], 99), 7);
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([3, null, 1, undefined, 2], 50), 2);
  });

  it('gini', () => {
    assert.equal(gini([5, 5, 5, 5]), 0);
    assert.equal(gini([0, 0, 0, 10]), 0.75);
    assert.equal(gini([]), 0);
    assert.equal(gini([0, 0]), 0);
    assert.ok(Math.abs(gini([1, 2, 3, 4]) - 0.25) < 1e-12);
  });

  it('mean and 95% CI', () => {
    const stats = meanCi([10, 12, 14]);
    assert.equal(stats.mean, 12);
    assert.ok(Math.abs(stats.ci95 - 4.303 * (2 / Math.sqrt(3))) < 1e-9);
    assert.deepEqual(meanCi([5]), { n: 1, mean: 5, ci95: null, min: 5, max: 5 });
    const aggregate = aggregateRuns([{ a: 1, b: 'x' }, { a: 3 }]);
    assert.equal(aggregate.a.mean, 2);
    assert.equal(aggregate.b, undefined);
    assert.deepEqual(flattenNumeric({ workload: { ttft: 1, nested: { x: 2 } }, settled: '54', name: 'x' }), { 'workload.ttft': 1, 'workload.nested.x': 2, settled: 54 });
  });

  it('summarizes records per persona and seller', () => {
    const ok = (persona, sellerId, ttftMs, latencyMs) => ({ persona, sellerId, ok: true, stream: true, ttftMs, latencyMs, usage: { prompt_tokens: 100, completion_tokens: 50 } });
    const records = [
      ok('chat', 'a', 100, 1100), ok('chat', 'a', 200, 1200), ok('agent', 'b', 300, 2300),
      { persona: 'chat', sellerId: 'b', ok: false, errorClass: 'seller' },
      { persona: 'agent', ok: false, errorClass: 'overload' },
    ];
    const summary = summarizeWorkload(records, { wallMs: 10_000, sellers: ['a', 'b', 'c'], signedDeltaBySeller: { a: 300n, b: 150n }, mockStats: { a: { utilisation: 0.5, peakQueue: 2, served: 2, rateLimited: 0 } } });
    assert.equal(summary.overall.requests, 5);
    assert.equal(summary.overall.succeeded, 3);
    assert.equal(summary.overall.successRate, 0.6);
    assert.deepEqual(summary.overall.errors, { seller: 1, overload: 1 });
    assert.equal(summary.overall.dropped, 1);
    assert.equal(summary.overall.outputTokensPerSec, 15);
    assert.equal(summary.overall.ttftMs.p50, 200);
    const mixed = summarizeWorkload([{ ...ok('x', 'a', 100, 900), stream: false, ttftMs: 900 }, ok('x', 'a', 50, 500)], { wallMs: 1000 });
    assert.equal(mixed.overall.ttftMs.p99, 50);
    assert.equal(mixed.overall.latencyMs.p99, 900);
    assert.equal(summary.overall.signedMicroUsdc, '450');
    assert.equal(summary.overall.costPerMillionTokensUsd, 1);
    assert.equal(summary.sellers.a.share, 0.6667);
    assert.equal(summary.sellers.c.served, 0);
    assert.equal(summary.sellers.a.utilisation, 0.5);
    assert.equal(summary.sellers.b.failed, 1);
    assert.equal(summary.personas.chat.requests, 3);
    assert.equal(summary.personas.agent.errors.overload, 1);
    assert.ok(summary.overall.loadSpreadGini > 0.3);
    assert.equal(keyMetrics(summary).successRate, 0.6);
  });
});

describe('invariants', () => {
  it('channel samples: monotonic and within reserve', () => {
    const good = [
      { atMs: 0, channels: [{ channelId: 'c1', cumulativeSigned: '10', reserveCeiling: '100' }] },
      { atMs: 1, channels: [{ channelId: 'c1', cumulativeSigned: '20', reserveCeiling: null }] },
    ];
    assert.ok(checkChannelSamples(good).every((entry) => entry.ok));
    const bad = [...good, { atMs: 2, channels: [{ channelId: 'c1', cumulativeSigned: '15', reserveCeiling: '12' }] }];
    const [monotonic, reserve] = checkChannelSamples(bad);
    assert.equal(monotonic.ok, false);
    assert.deepEqual(monotonic.detail.regressions[0], { channelId: 'c1', atMs: 2, from: '20', to: '15' });
    assert.equal(reserve.ok, false);
  });

  it('allowed sellers', () => {
    assert.equal(checkAllowedSellers([{ ok: true, sellerId: 'a' }, { ok: false, sellerId: null }], ['a']).ok, true);
    assert.equal(checkAllowedSellers([{ ok: true, sellerId: 'unknown:ff' }], ['a']).ok, false);
    assert.equal(checkAllowedSellers([{ ok: true, sellerId: null }], ['a']).ok, false);
  });

  it('request accounting matches per request tag', () => {
    const records = [
      { requestId: 'r1', ok: true, sellerId: 'a' },
      { requestId: 'r2', ok: false, sellerId: 'b', errorClass: 'network' },
      { requestId: 'r3', ok: true, sellerId: 'b' },
    ];
    const mock = {
      a: [{ path: '/v1/chat/completions', requestTag: 'r1', outcome: 'ok' }, { path: '/v1/chat/completions', outcome: 'ok' }],
      b: [{ path: '/v1/chat/completions', requestTag: 'r2', outcome: 'ok' }, { path: '/v1/chat/completions', requestTag: 'r3', outcome: 'ok' }, { path: '/v1/chat/completions', requestTag: 'old', outcome: 'ok' }],
    };
    const okResult = checkRequestAccounting(records, mock);
    assert.equal(okResult.ok, true, JSON.stringify(okResult.detail));
    assert.equal(okResult.detail.surplusMockCompletions, 1);
    const missing = checkRequestAccounting([...records, { requestId: 'r4', ok: true, sellerId: 'a' }], mock);
    assert.equal(missing.ok, false);
    assert.equal(missing.detail.unmatchedBuyerSuccesses[0].requestId, 'r4');
    const tooMany = checkRequestAccounting([{ requestId: 'r1', ok: true, sellerId: 'a' }], { a: [{ path: '/v1/chat/completions', requestTag: 'r1', outcome: 'ok' }, { path: '/v1/chat/completions', requestTag: 'r1', outcome: 'ok' }] });
    assert.equal(tooMany.ok, false);
  });

  it('settlement and delivered cost', () => {
    const [settled, reserves] = checkSettlement({ signedBySeller: { a: 10n, b: 0n }, settledBySeller: { a: 10n }, reservedMicroUsdc: 0n });
    assert.equal(settled.ok, true);
    assert.equal(reserves.ok, true);
    assert.equal(checkSettlement({ signedBySeller: { a: 10n }, settledBySeller: { a: 9n }, reservedMicroUsdc: 1n }).every((entry) => !entry.ok), true);
    const delivered = checkDeliveredCost({ settledBySeller: { a: 54n }, deliveredBySeller: { a: 36n } });
    assert.equal(delivered.ok, false);
    assert.equal(delivered.known, true);
    assert.equal(delivered.detail.perSeller.a.diff, '18');
    assert.equal(usageCostMicros({ prompt_tokens: 10, completion_tokens: 8 }, { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }), 18n);
    assert.equal(usageCostMicros({ prompt_tokens: 10, completion_tokens: 8 }, { inputUsdPerMillion: 100, outputUsdPerMillion: 200 }), 2600n);
  });
});

describe('run options', () => {
  it('parses --seed and --repeat', () => {
    const options = parseArgs(['run', 'load-mixed', '--seed', '7', '--repeat', '3']);
    assert.equal(options.seed, 7);
    assert.equal(options.repeat, 3);
    assert.equal(parseArgs(['run', 'chat-basic']).seed, undefined);
    assert.throws(() => parseArgs(['run', 'x', '--seed', '-1']), /--seed needs a value|--seed must/);
    assert.throws(() => parseArgs(['run', 'x', '--seed', 'abc']), /--seed must/);
    assert.throws(() => parseArgs(['run', 'x', '--repeat', '0']), /--repeat must/);
    assert.throws(() => parseArgs(['run', 'x', '--repeat', '101']), /--repeat must/);
  });
});
