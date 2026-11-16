import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startMock } from '../lib/mock.mjs';
import { createPrng, derive } from '../lib/prng.mjs';
import { runLoad } from '../lib/stress.mjs';

const TAGS = Array.from({ length: 40 }, (_, index) => `tag-${index}`);
const mockOptions = (seed) => ({
  models: ['m'], usage: 'load', latencyRangeMs: [0, 8], outTokens: [100, 4000], fault500Rate: 0.2, disconnectRate: 0.2,
  pricing: { m: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } }, random: createPrng(derive(seed, 'mock:seller')),
});

async function send(mock, tag) {
  const stream = Number(tag.split('-')[1]) % 2 === 0;
  const body = JSON.stringify({ model: 'm', stream, messages: [{ role: 'user', content: `[req:${tag}] hello` }] });
  try {
    await (await fetch(`${mock.url}/v1/chat/completions`, { method: 'POST', body })).text();
  } catch { /* an injected disconnect */ }
}

/** What the seed decides per request: drawn latency, tokens, cost and the fault that hit it. */
function decisions(ledger) {
  const picked = {};
  for (const tag of Object.keys(ledger.byTag).sort()) {
    const { latencyMs, prompt, completion, cost, status } = ledger.byTag[tag];
    picked[tag] = { latencyMs, prompt, completion, cost, status };
  }
  return picked;
}

async function ledgerOf(seed, deliver) {
  const mock = await startMock(mockOptions(seed));
  try {
    await deliver(mock);
    return decisions(mock.deliveries());
  } finally {
    await mock.stop();
  }
}

const oneByOne = (tags) => async (mock) => { for (const tag of tags) await send(mock, tag); };

describe('mock determinism', () => {
  it('gives identical latencies, tokens and fault decisions for the same seed', async () => {
    const first = await ledgerOf(7, oneByOne(TAGS));
    const second = await ledgerOf(7, oneByOne(TAGS));
    assert.deepEqual(second, first);
    const statuses = new Set(Object.values(first).map((entry) => entry.status));
    assert.ok(statuses.has('ok') && statuses.has('500') && statuses.has('disconnect'), `the seed must exercise each outcome: ${[...statuses]}`);
  });

  it('differs for a different seed', async () => {
    const first = await ledgerOf(7, oneByOne(TAGS));
    const other = await ledgerOf(8, oneByOne(TAGS));
    for (const key of ['latencyMs', 'completion', 'status']) {
      assert.notDeepEqual(Object.values(other).map((entry) => entry[key]), Object.values(first).map((entry) => entry[key]), key);
    }
  });

  it('does not depend on the order requests arrive in', async () => {
    const inOrder = await ledgerOf(7, oneByOne(TAGS));
    const reversed = await ledgerOf(7, oneByOne([...TAGS].reverse()));
    const concurrent = await ledgerOf(7, (mock) => Promise.all(TAGS.map((tag) => send(mock, tag))));
    assert.deepEqual(reversed, inOrder);
    assert.deepEqual(concurrent, inOrder);
  });

  it('gives an upstream retry of a tag its own draws', async () => {
    const mock = await startMock({ ...mockOptions(7), fault500Rate: 0, disconnectRate: 0 });
    try {
      await send(mock, 'tag-1');
      const first = mock.deliveries().byTag['tag-1'];
      await send(mock, 'tag-1');
      const retry = mock.deliveries().byTag['tag-1'];
      assert.equal(retry.attempts, 2);
      assert.notEqual(retry.completion, first.completion);
    } finally {
      await mock.stop();
    }
  });
});

describe('load determinism', () => {
  const load = { concurrency: 4, requests: 24, streamRatio: 0.5, abortRatio: 0.2, minInTokens: 1, maxInTokens: 50 };

  async function loadRun(seed) {
    const mock = await startMock({ ...mockOptions(seed), fault500Rate: 0, disconnectRate: 0 });
    try {
      const run = await runLoad({ proxyUrl: mock.url, model: 'm', load, random: createPrng(derive(seed, 'load')) });
      const plan = [...run.results].sort((a, b) => a.i - b.i).map(({ i, tag, stream, abort }) => ({ i, tag, stream, abort }));
      return { plan, ledger: mock.deliveries().byTag };
    } finally {
      await mock.stop();
    }
  }

  it('sends the same tagged requests for the same seed, whichever worker gets each one', async () => {
    const [first, second] = [await loadRun(7), await loadRun(7)];
    assert.deepEqual(second.plan, first.plan);
    for (const { tag, abort } of first.plan) {
      if (abort) continue; // How far an abandoned response got is wall-clock timing.
      assert.equal(second.ledger[tag].prompt, first.ledger[tag].prompt, tag);
      assert.equal(second.ledger[tag].completion, first.ledger[tag].completion, tag);
      assert.equal(second.ledger[tag].cost, first.ledger[tag].cost, tag);
    }
  });

  it('sends other requests for another seed', async () => {
    assert.notDeepEqual((await loadRun(8)).plan.map((entry) => entry.tag), (await loadRun(7)).plan.map((entry) => entry.tag));
  });

  it('never reuses a tag across the loads of one run', async () => {
    const mock = await startMock({ models: ['m'], usage: 'load', latencyRangeMs: [0, 0], outTokens: [1, 2] });
    try {
      const random = createPrng(derive(7, 'load'));
      const shape = { concurrency: 2, requests: 10, minInTokens: 1, maxInTokens: 2 };
      const runs = [await runLoad({ proxyUrl: mock.url, model: 'm', load: shape, random }), await runLoad({ proxyUrl: mock.url, model: 'm', load: shape, random })];
      assert.equal(new Set(runs.flatMap((run) => run.results.map((record) => record.tag))).size, 20);
    } finally {
      await mock.stop();
    }
  });
});
