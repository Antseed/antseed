import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createSlots, MOCK_USAGE, startMock } from '../lib/mock.mjs';
import { degradationActive, estimateInputTokens, listProfiles, normalizeProfile, planResponse, reportedUsage, requestTokens } from '../lib/profiles.mjs';
import { createRng, deriveSeed, normalizeDist, sampleDist, zipfWeights } from '../lib/random.mjs';
import { parseSse } from '../lib/sb.mjs';
import { normalizeTopology } from '../lib/topology.mjs';
import { sanitizeConfig, DEFAULT_SOURCE_CONFIG } from '../lib/config.mjs';

function fakeClock(start = 1_000_000) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    sleep(ms, signal) {
      if (ms <= 0 || signal?.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = { at: now + ms, resolve };
        timers.push(timer);
        signal?.addEventListener('abort', () => { timers.splice(timers.indexOf(timer), 1); resolve(); }, { once: true });
      });
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => timers.length,
  };
}

describe('seeded randomness', () => {
  it('is reproducible per seed and differs across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 5 }, () => a.next());
    assert.deepEqual(seqA, Array.from({ length: 5 }, () => b.next()));
    assert.notDeepEqual(seqA, Array.from({ length: 5 }, () => c.next()));
    assert.ok(seqA.every((value) => value >= 0 && value < 1));
    assert.equal(deriveSeed(1, 'x', 2), deriveSeed(1, 'x', 2));
    assert.notEqual(deriveSeed(1, 'x', 2), deriveSeed(1, 'x', 3));
  });

  it('lognormal hits its median and p99', () => {
    const dist = normalizeDist({ type: 'lognormal', median: 100, p99: 1000 }, 'd');
    const rng = createRng(7);
    const values = Array.from({ length: 20_000 }, () => sampleDist(dist, rng)).sort((x, y) => x - y);
    const median = values[10_000];
    const p99 = values[19_800];
    assert.ok(median > 93 && median < 107, `median ${median}`);
    assert.ok(p99 > 850 && p99 < 1170, `p99 ${p99}`);
  });

  it('uniform, fixed, integer and clamps', () => {
    const rng = createRng(1);
    const uniform = normalizeDist({ min: 10, max: 20 }, 'u', { integer: true });
    const values = Array.from({ length: 2000 }, () => sampleDist(uniform, rng));
    assert.ok(values.every((value) => Number.isInteger(value) && value >= 10 && value <= 20));
    assert.ok(new Set(values).size === 11);
    assert.equal(sampleDist(normalizeDist(5, 'f'), rng), 5);
    const clamped = normalizeDist({ median: 100, p99: 10_000, clampMax: 150 }, 'c');
    assert.ok(Array.from({ length: 500 }, () => sampleDist(clamped, rng)).every((value) => value <= 150));
  });

  it('rejects malformed distributions', () => {
    assert.throws(() => normalizeDist({ type: 'lognormal', median: 10, p99: 5 }, 'x'), /p99 >= median/);
    assert.throws(() => normalizeDist({ type: 'uniform', min: 5, max: 1 }, 'x'), /max must be >= min/);
    assert.throws(() => normalizeDist({ type: 'pareto' }, 'x'), /fixed, uniform or lognormal/);
    assert.throws(() => normalizeDist('3', 'x'), /number or a distribution/);
    assert.throws(() => normalizeDist(-1, 'x'), /number in/);
  });

  it('zipf weights decay by rank', () => {
    assert.deepEqual(zipfWeights(3, 1), [1, 0.5, 1 / 3]);
    assert.deepEqual(zipfWeights(3, 0), [1, 1, 1]);
  });
});

describe('seller profiles', () => {
  it('defaults to the legacy fixed mock', () => {
    const profile = normalizeProfile({});
    assert.equal(profile.usage, 'fixed');
    assert.equal(profile.latencyMs, 0);
    assert.equal(profile.concurrency, 0);
    assert.deepEqual(requestTokens(profile, { body: {}, headers: {}, rng: createRng(1) }), { inputTokens: 10, outputTokens: 8 });
  });

  it('timing fields switch to modeled usage; every shipped profile is valid', () => {
    assert.equal(normalizeProfile({ decodeTokensPerSec: 50 }).usage, 'modeled');
    const names = listProfiles();
    assert.ok(names.includes('fast-premium') && names.includes('flaky') && names.includes('degrading'));
    for (const name of names) {
      const profile = normalizeProfile({ profile: name });
      assert.equal(profile.usage, 'modeled', name);
      assert.equal(profile.profile, name);
    }
  });

  it('named profiles merge with overrides', () => {
    const profile = normalizeProfile({ profile: 'flaky', concurrency: 2, errors: { http5xx: 0 } });
    assert.equal(profile.concurrency, 2);
    assert.equal(profile.errors.http5xx, 0);
    assert.equal(profile.errors.midStreamDrop, 0.02);
  });

  it('loads profiles from a custom dir and rejects bad input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-profiles-'));
    await writeFile(join(dir, 'tiny.json'), JSON.stringify({ decodeTokensPerSec: 10 }));
    await writeFile(join(dir, 'loop.json'), JSON.stringify({ profile: 'tiny' }));
    assert.equal(normalizeProfile({ profile: 'tiny' }, { dir }).decodeTokensPerSec.value, 10);
    assert.throws(() => normalizeProfile({ profile: 'loop' }, { dir }), /cannot reference another profile/);
    assert.throws(() => normalizeProfile({ profile: 'missing' }, { dir }), /No mock profile/);
    assert.throws(() => normalizeProfile({ profile: '../etc' }), /Invalid profile name/);
    assert.throws(() => normalizeProfile({ bogus: 1 }), /Unknown mock key "bogus"/);
    assert.throws(() => normalizeProfile({ errors: { nope: 1 } }), /Unknown mock.errors key/);
    assert.throws(() => normalizeProfile({ errors: { http5xx: 1.5 } }), /http5xx/);
    assert.throws(() => normalizeProfile({ errors: { http5xx: 0.6, timeout: 0.6 } }), /must be <= 1/);
    assert.throws(() => normalizeProfile({ degradation: { everyMs: 10, forMs: 20 } }), /forMs must be <= everyMs/);
    assert.throws(() => normalizeProfile({ adversarial: { inflateUsage: 0.5 } }), /inflateUsage/);
    assert.throws(() => normalizeProfile({ latencyMs: -1 }), /latencyMs/);
    assert.throws(() => normalizeProfile({ usage: 'random' }), /fixed or modeled/);
  });

  it('topology accepts profile names, objects and the legacy latency field', () => {
    const source = sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned;
    const topology = normalizeTopology({ sellers: [{ id: 'a', mock: 'flaky' }, { id: 'b', mock: { profile: 'cheap-slow', concurrency: 1 } }, { id: 'c', mock: { latencyMs: 30 } }] }, source);
    assert.deepEqual(topology.sellers[0].mock, { profile: 'flaky', latencyMs: 0 });
    assert.equal(topology.sellers[1].mock.concurrency, 1);
    assert.equal(topology.sellers[2].mock.latencyMs, 30);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { profile: 'nope' } }] }, source), /No mock profile/);
  });

  it('estimates input tokens deterministically and honours hints and max_tokens', () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(400) }, { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(40) }] }] };
    assert.equal(estimateInputTokens(body), 100 + 10 + 8);
    const profile = normalizeProfile({ decodeTokensPerSec: 10, outputTokens: 500 });
    assert.deepEqual(requestTokens(profile, { body, headers: {}, rng: createRng(1) }), { inputTokens: 118, outputTokens: 500 });
    assert.deepEqual(requestTokens(profile, { body: { ...body, max_tokens: 20 }, headers: { 'x-sandbox-input-tokens': '9000', 'x-sandbox-output-tokens': '77' }, rng: createRng(1) }), { inputTokens: 9000, outputTokens: 20 });
    assert.deepEqual(requestTokens(profile, { body, headers: { 'x-sandbox-input-tokens': 'lots' }, rng: createRng(1) }).inputTokens, 118);
  });

  it('plans TTFT = rtt + prefill + jitter and decode at the configured rate', () => {
    const profile = normalizeProfile({ rttMs: 50, prefillTokensPerSec: 1000, jitterMs: 10, decodeTokensPerSec: 20, chunkTokens: 5 });
    const plan = planResponse(profile, { inputTokens: 2000, outputTokens: 40, stream: true, rng: createRng(1) });
    assert.equal(plan.outcome, 'ok');
    assert.equal(plan.ttftMs, 50 + 2000 + 10);
    assert.equal(plan.chunks.length, 8);
    assert.equal(plan.chunks[0].atMs, plan.ttftMs);
    assert.equal(plan.chunks[1].atMs, plan.ttftMs + 250);
    assert.equal(plan.totalMs, plan.ttftMs + 2000);
    assert.equal(plan.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0), 40);
  });

  it('tail spikes, degradation windows and stalls stretch timing', () => {
    const spiky = normalizeProfile({ prefillTokensPerSec: 1000, decodeTokensPerSec: 10, tailSpike: { p: 1, multiplier: 4 } });
    const spiked = planResponse(spiky, { inputTokens: 1000, outputTokens: 10, rng: createRng(1) });
    assert.equal(spiked.ttftMs, 4000);
    assert.equal(spiked.totalMs, 4000 + 4000);
    const degrading = normalizeProfile({ decodeTokensPerSec: 100, degradation: { everyMs: 1000, forMs: 200, decodeMultiplier: 0.5 } });
    assert.equal(degradationActive(degrading.degradation, 100), false);
    assert.equal(degradationActive(degrading.degradation, 850), true);
    assert.equal(planResponse(degrading, { inputTokens: 1, outputTokens: 10, rng: createRng(1), elapsedMs: 900 }).decodeTokensPerSec, 50);
    assert.equal(planResponse(degrading, { inputTokens: 1, outputTokens: 10, rng: createRng(1), elapsedMs: 100 }).decodeTokensPerSec, 100);
    const stalling = normalizeProfile({ decodeTokensPerSec: 100, chunkTokens: 1, errors: { stall: 1, stallMs: 3000 } });
    const stalled = planResponse(stalling, { inputTokens: 1, outputTokens: 10, rng: createRng(1) });
    assert.ok(stalled.stallAtChunk >= 1);
    assert.equal(stalled.totalMs, 100 + 3000);
  });

  it('error injection matches configured rates over many seeded draws', () => {
    const profile = normalizeProfile({ decodeTokensPerSec: 100, errors: { http5xx: 0.1, timeout: 0.05, midStreamDrop: 0.2 } });
    const counts = { ok: 0, error: 0, timeout: 0, drop: 0 };
    const n = 20_000;
    for (let index = 0; index < n; index += 1) counts[planResponse(profile, { inputTokens: 10, outputTokens: 10, rng: createRng(deriveSeed(3, index)) }).outcome] += 1;
    assert.ok(Math.abs(counts.error / n - 0.1) < 0.01, JSON.stringify(counts));
    assert.ok(Math.abs(counts.timeout / n - 0.05) < 0.01, JSON.stringify(counts));
    assert.ok(Math.abs(counts.drop / n - 0.2) < 0.015, JSON.stringify(counts));
  });

  it('same seed gives the same plan', () => {
    const profile = normalizeProfile({ profile: 'flaky' });
    const a = planResponse(profile, { inputTokens: 500, outputTokens: 300, stream: true, rng: createRng(9) });
    const b = planResponse(profile, { inputTokens: 500, outputTokens: 300, stream: true, rng: createRng(9) });
    assert.deepEqual(a, b);
  });

  it('usage is exact unless inflation is on', () => {
    assert.deepEqual(reportedUsage(normalizeProfile({ decodeTokensPerSec: 1 }), 100, 37), { prompt_tokens: 100, completion_tokens: 37, total_tokens: 137 });
    assert.deepEqual(reportedUsage(normalizeProfile({ decodeTokensPerSec: 1, adversarial: { inflateUsage: 2 } }), 100, 37), { prompt_tokens: 200, completion_tokens: 74, total_tokens: 274 });
  });
});

describe('slots', () => {
  it('queues FIFO beyond the limit and tracks busy time', async () => {
    const clock = fakeClock();
    const slots = createSlots(clock);
    slots.setLimit(1);
    const order = [];
    await slots.acquire();
    const second = slots.acquire().then(() => order.push('second'));
    const third = slots.acquire().then(() => order.push('third'));
    assert.equal(slots.queued, 2);
    assert.equal(slots.peakQueue, 2);
    slots.release(100);
    await second;
    slots.release(50);
    await third;
    assert.deepEqual(order, ['second', 'third']);
    assert.equal(slots.busyMs, 150);
    const aborted = new AbortController();
    const waiting = slots.acquire(aborted.signal);
    aborted.abort();
    await assert.rejects(waiting, /aborted while queued/);
    assert.equal(slots.queued, 0);
  });
});

describe('timed mock upstream', () => {
  const post = (url, body, headers = {}) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('keeps the legacy fixed behaviour by default', async () => {
    const mock = await startMock({ models: ['m'] });
    try {
      const body = await (await post(mock.url, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })).json();
      assert.deepEqual(body.usage, MOCK_USAGE);
      const streamed = parseSse(await (await post(mock.url, { model: 'm', stream: true, messages: [] })).text());
      assert.deepEqual(streamed.usage, MOCK_USAGE);
      assert.equal(mock.stats().ok, 2);
    } finally {
      await mock.stop();
    }
  });

  it('streams at the decode rate on an injected clock and reports exact usage', async () => {
    const clock = fakeClock();
    const mock = await startMock({ models: ['m'], clock, profile: { rttMs: 100, prefillTokensPerSec: 1000, decodeTokensPerSec: 10, chunkTokens: 5 } });
    try {
      const pending = post(mock.url, { model: 'm', stream: true, messages: [] }, { 'x-sandbox-input-tokens': '400', 'x-sandbox-output-tokens': '20', 'x-sandbox-request-id': 'r1' });
      while (clock.pending() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      await clock.advance(499);
      assert.equal(mock.state.requests[0].ttftMs, undefined);
      await clock.advance(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(mock.state.requests[0].ttftMs, 500);
      await clock.advance(2000);
      const text = await (await pending).text();
      const parsed = parseSse(text);
      assert.equal(parsed.done, true);
      assert.deepEqual(parsed.usage, { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 });
      assert.equal((parsed.content.match(/token/g) ?? []).length, 20);
      const entry = mock.state.requests[0];
      assert.equal(entry.requestTag, 'r1');
      assert.equal(entry.outcome, 'ok');
      assert.equal(entry.heldMs, 500 + 1500);
    } finally {
      await mock.stop();
    }
  });

  it('queues beyond concurrency and answers 429 with retry-after when the queue is full', async () => {
    const clock = fakeClock();
    const mock = await startMock({ models: ['m'], clock, profile: { decodeTokensPerSec: 10, outputTokens: 10, concurrency: 1, errors: { rateLimitQueue: 1, retryAfterSec: 7 } } });
    try {
      const first = post(mock.url, { model: 'm', messages: [] });
      while (clock.pending() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      const second = post(mock.url, { model: 'm', messages: [] });
      while (mock.stats().queued === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      const third = await post(mock.url, { model: 'm', messages: [] });
      assert.equal(third.status, 429);
      assert.equal(third.headers.get('retry-after'), '7');
      await clock.advance(1000);
      assert.equal((await first).status, 200);
      while (clock.pending() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      await clock.advance(1000);
      assert.equal((await second).status, 200);
      const [a, b] = mock.state.requests;
      assert.equal(a.queueMs, 0);
      assert.equal(b.queueMs, 1000);
      const stats = mock.stats();
      assert.equal(stats.rateLimited, 1);
      assert.equal(stats.peakQueue, 1);
      assert.equal(stats.ok, 2);
    } finally {
      await mock.stop();
    }
  });

  it('injects 5xx and mid-stream drops; drops report no usage', async () => {
    const mock = await startMock({ models: ['m'], profile: { decodeTokensPerSec: 100000, outputTokens: 40, chunkTokens: 4, errors: { http5xx: 1, status5xx: 502 } } });
    try {
      const failed = await post(mock.url, { model: 'm', messages: [] });
      assert.equal(failed.status, 502);
      mock.setProfile({ errors: { http5xx: 0, midStreamDrop: 1 } });
      const dropped = await post(mock.url, { model: 'm', stream: true, messages: [] });
      assert.equal(dropped.status, 200);
      await assert.rejects(dropped.text());
      for (let waited = 0; !mock.state.requests[1]?.outcome && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(mock.state.requests[1].outcome, 'drop');
      assert.equal(mock.stats().error5xx, 1);
      assert.equal(mock.stats().drop, 1);
      assert.throws(() => mock.setProfile({ errors: { http5xx: 2 } }), /http5xx/);
      assert.equal(mock.profile().errors.midStreamDrop, 1);
    } finally {
      await mock.stop();
    }
  });

  it('runtime patches and seeds are reproducible', async () => {
    const run = async (seed) => {
      const mock = await startMock({ models: ['m'], profile: { decodeTokensPerSec: 1e6, outputTokens: { type: 'uniform', min: 1, max: 1000 }, seed } });
      try {
        const out = [];
        for (let index = 0; index < 5; index += 1) out.push((await (await post(mock.url, { model: 'm', messages: [] })).json()).usage.completion_tokens);
        return out;
      } finally {
        await mock.stop();
      }
    };
    assert.deepEqual(await run(5), await run(5));
    assert.notDeepEqual(await run(5), await run(6));
  });
});
