import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkChannelPeers, checkRouterFees } from '../lib/invariants.mjs';
import { assignPhases, evaluateExpectations, normalizeDeclarative, normalizeFault, parseDuration, parseExpectation, runDeclarative, windowMetrics } from '../lib/scenario.mjs';
import { validateScenarioModule } from '../lib/topology.mjs';

const topology = { sellers: [{ id: 'a' }, { id: 'b' }], routers: [{ id: 'r', priceUsd: '0.001' }] };

describe('declarative scenario parsing', () => {
  it('parses durations and expectations', () => {
    assert.equal(parseDuration('500ms', 'd'), 500);
    assert.equal(parseDuration('30s', 'd'), 30_000);
    assert.equal(parseDuration('2m', 'd'), 120_000);
    assert.equal(parseDuration(1500, 'd'), 1500);
    assert.throws(() => parseDuration('30', 'd'), /duration like/);
    assert.throws(() => parseDuration('-1s', 'd'), /duration like/);
    assert.deepEqual(parseExpectation('>=0.99', 'e'), { op: '>=', value: 0.99 });
    assert.deepEqual(parseExpectation('< 2000', 'e'), { op: '<', value: 2000 });
    assert.deepEqual(parseExpectation(0, 'e'), { op: '==', value: 0 });
    assert.throws(() => parseExpectation('about 3', 'e'), /must look like/);
  });

  it('validates faults', () => {
    assert.deepEqual(normalizeFault({ stop: 'a', at: '2s' }, 'f'), { kind: 'stop', atMs: 2000, target: 'a' });
    assert.deepEqual(normalizeFault({ warp: '1m' }, 'f'), { kind: 'warp', atMs: 0, seconds: 60 });
    assert.equal(normalizeFault({ mock: { seller: 'a', patch: { latencyMs: 9 } } }, 'f').restore, true);
    assert.throws(() => normalizeFault({ stop: 'a', start: 'b' }, 'f'), /exactly one/);
    assert.throws(() => normalizeFault({ stop: 'a', when: 1 }, 'f'), /unknown key "when"/);
    assert.throws(() => normalizeFault({ mock: { seller: 'a' } }, 'f'), /seller, patch/);
  });

  it('normalizes phases back to back and checks seller references', () => {
    const plan = normalizeDeclarative({
      topology,
      workload: { via: 'router:r' },
      phases: [
        { name: 'one', duration: '10s', expect: { successRate: '>=0.9' } },
        { name: 'two', duration: '5s', faults: [{ stop: 'a', at: '1s' }], expect: { 'servedBy.a': '==0' }, known: { 'servedBy.b': { expect: '>=1', issue: 'x' } } },
      ],
      expect: { requests: '>=1' },
    }, 's');
    assert.deepEqual(plan.phases.map((phase) => [phase.name, phase.startMs, phase.endMs]), [['one', 0, 10_000], ['two', 10_000, 15_000]]);
    assert.equal(plan.durationMs, 15_000);
    assert.deepEqual(plan.workload.via, { router: 'r' });
    assert.equal(plan.phases[1].known['servedBy.b'].issue, 'x');
    const bad = (patch) => () => normalizeDeclarative({ topology, phases: [{ name: 'p', duration: '5s' }], ...patch }, 's');
    assert.throws(bad({ phases: [{ name: 'p', duration: '5s', faults: [{ stop: 'zz' }] }] }), /unknown seller "zz"/);
    assert.throws(bad({ phases: [{ name: 'p', duration: '5s', faults: [{ stop: 'a', at: '9s' }] }] }), /outside/);
    assert.throws(bad({ phases: [{ name: 'p', duration: '5s', expect: { 'servedBy.zz': '==0' } }] }), /unknown seller "zz"/);
    assert.throws(bad({ phases: [{ name: 'p', duration: '5s', expect: { servedBy: '==0' } }] }), /needs a seller/);
    assert.throws(bad({ phases: [{ name: 'p', duration: '5s' }, { name: 'p', duration: '5s' }] }), /unique/);
    assert.throws(bad({ workload: { via: 'router:nope' } }), /router:<id>/);
    assert.throws(bad({ extra: 1 }), /unknown key "extra"/);
    assert.equal(normalizeDeclarative({ topology, run() {} }, 's'), null);
  });

  it('module validation: declarative default export or imperative run', () => {
    const declarative = validateScenarioModule({ default: { topology, phases: [{ name: 'p', duration: '5s', faults: [{ stop: 'a' }] }] } }, 'd');
    assert.ok(declarative.declarative);
    assert.deepEqual(declarative.requires.sort(), ['mockControl', 'sellerControl']);
    assert.equal(typeof declarative.run, 'function');
    const imperative = validateScenarioModule({ topology, run: async () => {} }, 'i');
    assert.equal(imperative.declarative, null);
    assert.throws(() => validateScenarioModule({ topology }, 'x'), /must export/);
    assert.throws(() => validateScenarioModule({ default: { topology, phases: [{ name: 'p', duration: '5s' }], run() {} } }, 'x'), /unknown key "run"|setup\(sb\)/);
  });
});

describe('window metrics and expectations', () => {
  const records = [
    { startMs: 100, ok: true, stream: true, ttftMs: 50, latencyMs: 200, sellerId: 'a', model: 'antseed', servedModel: 'm1' },
    { startMs: 1500, ok: false, stream: false, latencyMs: 30, sellerId: 'b', model: 'antseed' },
    { startMs: 2500, ok: true, stream: false, latencyMs: 90, sellerId: 'b', model: 'antseed', servedModel: 'm2' },
    { startMs: 4000, ok: true, stream: true, ttftMs: 70, latencyMs: 120, sellerId: 'a', model: 'antseed', servedModel: 'm1' },
  ];

  it('computes per-window and per-seller metrics', () => {
    const all = windowMetrics(records, { sellers: ['a', 'b'] });
    assert.equal(all.requests, 4);
    assert.equal(all.successRate, 0.75);
    assert.equal(all['servedBy.a'], 2);
    assert.equal(all['failedOn.b'], 1);
    assert.equal(all.distinctSellers, 2);
    assert.equal(all.distinctModels, 2);
    const late = windowMetrics(records, { sellers: ['a', 'b'], fromMs: 1000, toMs: 5000, anchorMs: 2000 });
    assert.equal(late.requests, 3);
    assert.equal(late['recoveryMs.b'], 500);
    assert.equal(late['recoveryMs.a'], 2000);
    assert.equal(windowMetrics([], { sellers: ['a'] }).successRate, null);
  });

  it('evaluates expectations without throwing', () => {
    const metrics = windowMetrics(records, { sellers: ['a', 'b'] });
    const results = evaluateExpectations({ successRate: { raw: '>=0.9', op: '>=', value: 0.9 }, 'servedBy.a': { raw: 2, op: '==', value: 2 }, ttftP95Ms: { raw: '<10', op: '<', value: 10 } }, metrics, 'run');
    assert.deepEqual(results.map((entry) => [entry.name, entry.ok]), [['run: successRate >=0.9', false], ['run: servedBy.a == 2', true], ['run: ttftP95Ms <10', false]]);
    assert.equal(evaluateExpectations({ x: { raw: '>1', op: '>', value: 1 } }, {}, 'run')[0].ok, false);
  });
});

describe('phase assignment', () => {
  const phases = [{ name: 'a', startMs: 0, endMs: 1000 }, { name: 'b', startMs: 1000, endMs: 2000 }];
  it('assigns by start time, and moves requests that failed after the next fault into that phase', () => {
    const records = [
      { id: 1, startMs: 100, latencyMs: 200, ok: true },
      { id: 2, startMs: 900, latencyMs: 400, ok: false },
      { id: 3, startMs: 900, latencyMs: 50, ok: false },
      { id: 4, startMs: 1500, latencyMs: 10, ok: true },
      { id: 5, startMs: 2500, latencyMs: 10, ok: true },
      { id: 6, startMs: 950, latencyMs: 300, ok: true },
    ];
    const byPhase = assignPhases(records, phases, new Map([['b', 1100]]));
    assert.deepEqual(byPhase.get('a').map((r) => r.id), [1, 3, 6]);
    assert.deepEqual(byPhase.get('b').map((r) => r.id), [2, 4, 5]);
    const noFault = assignPhases(records, phases);
    assert.deepEqual(noFault.get('a').map((r) => r.id), [1, 2, 3, 6]);
  });
});

describe('declarative runner', () => {
  it('runs setup, one workload with timed faults, phase expectations and restores mock patches', async () => {
    const calls = [];
    const expectations = [];
    const known = [];
    const metrics = {};
    const sb = {
      sellers: [{ id: 'a' }, { id: 'b' }],
      useRouter: async (id) => calls.push(['router', id]),
      stopSeller: async (id) => calls.push(['stop', id]),
      setMockProfile: async (id, patch, options) => calls.push(['mock', id, patch, options ?? null]),
      mockProfileRaw: async () => ({ latencyMs: 1 }),
      expect: (name, ok, detail) => expectations.push({ name, ok, detail }),
      knownIssue: (name, ok, detail, issue) => known.push({ name, ok, issue }),
      metric: (name, value) => { metrics[name] = value; },
      async runWorkload({ timeline, durationMs, models }) {
        calls.push(['workload', durationMs, models]);
        const events = [];
        for (const entry of timeline.sort((x, y) => x.atMs - y.atMs)) {
          events.push({ name: entry.name, scheduledMs: entry.atMs, startMs: entry.atMs, endMs: entry.atMs + 5, ok: true, result: await entry.action() });
        }
        return { events, records: [
          { startMs: 100, ok: true, sellerId: 'a', latencyMs: 10 },
          { startMs: 6000, ok: true, sellerId: 'b', latencyMs: 10 },
          { startMs: 7000, ok: false, sellerId: 'b', latencyMs: 10 },
        ] };
      },
    };
    const plan = normalizeDeclarative({
      topology,
      workload: { via: 'router:r' },
      setup: async () => calls.push(['setup']),
      phases: [
        { name: 'base', duration: '5s', expect: { successRate: '>=1' } },
        { name: 'chaos', duration: '5s', faults: [{ stop: 'a' }, { mock: { seller: 'b', patch: { latencyMs: 500 } }, at: '1s' }], expect: { 'servedBy.a': '==0', successRate: '>=0.9' }, known: { 'servedBy.a': { expect: '>=1', issue: 'tracked' } } },
      ],
    }, 's');
    await runDeclarative(sb, plan);
    assert.deepEqual(calls.map((call) => call[0]), ['router', 'setup', 'workload', 'stop', 'mock', 'mock']);
    assert.deepEqual(calls[2], ['workload', 10_000, ['antseed']]);
    assert.deepEqual(calls.at(-1), ['mock', 'b', { latencyMs: 1 }, { replace: true }]);
    assert.deepEqual(expectations.map((entry) => [entry.name, entry.ok]), [
      ['phase base: successRate >=1', true],
      ['phase chaos: servedBy.a ==0', true],
      ['phase chaos: successRate >=0.9', false],
    ]);
    assert.deepEqual(known, [{ name: 'phase chaos: servedBy.a >=1', ok: false, issue: 'tracked' }]);
    assert.equal(metrics.phases.chaos.requests, 2);
    assert.equal(metrics.faults.length, 3);
  });
});

describe('global invariants for routers and channel peers', () => {
  const routers = [{ id: 'r', priceUsd: '0.001' }];

  it('router fee equals rankings x price; one extra ranking is the known close defect', () => {
    assert.equal(checkRouterFees({ routers, signedBySeller: { r: 5000n }, rankedByRouter: { r: 5 } }).ok, true);
    const extra = checkRouterFees({ routers, signedBySeller: { r: 6000n }, rankedByRouter: { r: 5 } });
    assert.equal(extra.ok, false);
    assert.equal(extra.known, true);
    const wrong = checkRouterFees({ routers, signedBySeller: { r: 9000n }, rankedByRouter: { r: 5 } });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.known, undefined);
    assert.equal(checkRouterFees({ routers, signedBySeller: { r: 0n }, rankedByRouter: { r: 0 } }).ok, true);
    assert.equal(checkRouterFees({ routers, signedBySeller: { r: 1000n }, rankedByRouter: { r: 0 } }).known, undefined);
  });

  it('buyer channels are only with sandbox peers', () => {
    assert.equal(checkChannelPeers([{ channelId: 'c', peerId: 'p1' }], ['p1', 'p2']).ok, true);
    const bad = checkChannelPeers([{ channelId: 'c', peerId: 'p1' }, { channelId: 'd', peerId: 'evil' }], ['p1']);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.detail.foreign, [{ channelId: 'd', peerId: 'evil' }]);
  });
});

describe('seeded mock draws', async () => {
  const { startMock } = await import('../lib/mock.mjs');

  it('keys draws on the workload draw key, not arrival order, and resets per run', async () => {
    const profile = { outputTokens: { type: 'uniform', min: 1, max: 5000 } };
    const mock = await startMock({ models: ['m'], profile });
    const ask = async (drawKey) => {
      const response = await fetch(`${mock.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sandbox-draw-key': drawKey, 'x-sandbox-request-id': `${Date.now()}-${drawKey}` },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      });
      return (await response.json()).usage.completion_tokens;
    };
    try {
      const first = [await ask('k1'), await ask('k2')];
      mock.resetDraws();
      const reversed = [await ask('k2'), await ask('k1')];
      assert.deepEqual(first, [reversed[1], reversed[0]]);
      const retry = await ask('k1');
      assert.equal(typeof retry, 'number');
      mock.setProfile({ seed: 99 });
      const otherSeed = [await ask('k1'), await ask('k2')];
      assert.notDeepEqual(otherSeed, first);
      assert.deepEqual(mock.rawProfile(), { ...profile, seed: 99 });
    } finally {
      await mock.stop();
    }
  });
});

describe('scenario api soft checks', async () => {
  const { createSandboxApi } = await import('../lib/sb.mjs');
  const manifest = {
    proxyUrl: 'http://127.0.0.1:9', rpcUrl: 'http://127.0.0.1:9', buyer: { address: '0x0' },
    sellers: [{ id: 's', peerId: 'a'.repeat(40), address: '0x1', models: ['m'] }],
    topology: { sellers: [{ id: 's', providers: {} }] },
  };
  const chain = { depositsContractAddress: '0x' + '1'.repeat(40), usdcContractAddress: '0x' + '2'.repeat(40), channelsContractAddress: '0x' + '3'.repeat(40) };

  it('expect records failures without throwing; failures() lists hard and soft failures', () => {
    const sb = createSandboxApi({ manifest, control: {}, eventsPath: '/dev/null', chain });
    try {
      assert.equal(sb.expect('soft ok', true), true);
      assert.equal(sb.expect('soft bad', false, { n: 1 }), false);
      assert.throws(() => sb.check('hard bad', false));
      assert.deepEqual(sb.failures(), ['soft bad', 'hard bad']);
      assert.equal(sb.summary().checks.find((entry) => entry.name === 'soft bad').soft, true);
    } finally {
      sb.dispose();
    }
  });
});
