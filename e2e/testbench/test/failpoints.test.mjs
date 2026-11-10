// Fail points: the registry (specs, hit counting, seeded triggers, the journal), the preload that installs the
// handler into a node, the proof that production code installs none, and the testbench plumbing around them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliNodeEnv } from '../lib/cli-node.mjs';
import { controlClient, newToken, startControlServer } from '../lib/control.mjs';
import { sanitizeConfig, DEFAULT_SOURCE_CONFIG } from '../lib/config.mjs';
import {
  closeCrashCandidates, countsInJournal, crashInJournal, crashSpec, createFailpointRegistry, drawCloseCrash, drawLoadCrash, FAILPOINT_HANDLER_KEY, FailpointError,
  failpointFileName, failpointJournalPath, FAILPOINTS_FILE_ENV, loadCrashCandidates, normalizeFailpointSpec, parseJournal, POINT_CATALOG, restartFromCrash,
  triggeredInJournal, triggersInJournal,
} from '../lib/failpoints.mjs';
import { createPrng } from '../lib/prng.mjs';
import { gateProblems, GATES, runLoad, stressRun, stressTopology } from '../lib/stress.mjs';
import { readRunOutput, sweepSummary } from '../lib/sweep.mjs';
import { createTestbenchApi } from '../lib/tb.mjs';
import { assertScenarioSupported, normalizeTopology, topologyFingerprint, validateScenarioModule } from '../lib/topology.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const source = sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned;
const failpointsSource = readFileSync(join(repo, 'packages/buyer-core/src/failpoints.ts'), 'utf8');
/** FAILPOINTS as the payment code declares it: `{ name, sync }` per entry of the const. */
const declared = [...failpointsSource.slice(failpointsSource.indexOf('export const FAILPOINTS')).matchAll(/^\s+'([a-z.-]+)',\s*\/\/\s*(\(sync\))?/gm)].map((match) => ({ name: match[1], sync: Boolean(match[2]) }));
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const STARTED = '[Node] Starting as seller with 1 bootstrap node(s)\n';

/** Source and built files under a workspace folder, without dependencies. */
function codeFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out' || entry.name === 'cache') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) codeFiles(path, out);
    else if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(entry.name) && statSync(path).size < 5_000_000) out.push(path);
  }
  return out;
}

describe('fail points are inert in production', () => {
  it('only failpoints.ts names the handler key, so nothing in packages/, apps/ or plugins/ can install a handler', () => {
    const mentions = [];
    for (const root of ['packages', 'apps', 'plugins']) {
      for (const file of codeFiles(join(repo, root))) {
        const text = readFileSync(file, 'utf8');
        if (text.includes(FAILPOINT_HANDLER_KEY) || text.includes(FAILPOINTS_FILE_ENV)) mentions.push(relative(repo, file));
      }
    }
    // The module itself (source, its build output) and the two unit tests that install a handler to prove the hook.
    const allowed = /^packages\/(buyer-core\/(src\/failpoints(\.test)?\.ts|dist\/failpoints\.js)|node\/tests\/failpoints\.test\.ts)$/;
    assert.deepEqual(mentions.filter((file) => !allowed.test(file)), []);
    assert.ok(mentions.includes('packages/buyer-core/src/failpoints.ts'), 'the scan must reach the module it guards');
  });

  it('failpoints.ts exports no way to install a handler and reads no environment', () => {
    const exported = [...failpointsSource.matchAll(/^export (?:const|function|type|class|async function) (\w+)/gm)].map((match) => match[1]);
    assert.deepEqual(exported.sort(), ['FAILPOINTS', 'FailpointName', 'hitFailpoint', 'hitFailpointSync']);
    assert.doesNotMatch(failpointsSource, /process\.|import\.meta|require\(|from 'node:/);
    // The key is only ever read.
    assert.doesNotMatch(failpointsSource, /\[HANDLER_KEY\]\s*=[^=]/);
  });

  it('the catalog lists exactly the points the payment code declares, with the same sync marks', () => {
    assert.ok(declared.length >= 30, `parsed ${declared.length} points from failpoints.ts`);
    assert.deepEqual(Object.keys(POINT_CATALOG), declared.map((point) => point.name));
    for (const { name, sync } of declared) assert.equal(Boolean(POINT_CATALOG[name].sync), sync, `${name} sync`);
  });

  it('every declared point is reached somewhere in the payment code', () => {
    const text = ['packages/buyer-core/src', 'packages/node/src'].flatMap((dir) => codeFiles(join(repo, dir))).filter((file) => !/failpoints(\.test)?\.ts$/.test(file) && !/\.test\.ts$/.test(file)).map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const { name } of declared) {
      const [area, ...rest] = name.split('.');
      // Chain and buyer send points are spelled with a template (`chain.${op}.before-send`); the rest literally.
      const literal = text.includes(`'${name}'`);
      const templated = (area === 'chain' && text.includes(`\`chain.\${failpointOp}.${rest.at(-1)}\``)) || (area === 'buyer' && text.includes(`\`buyer.\${kind}.${rest.at(-1)}\``));
      assert.ok(literal || templated, `${name} is declared but never reached`);
    }
  });
});

describe('fail point spec', () => {
  it('keeps the known settings and fills the seed', () => {
    const spec = normalizeFailpointSpec({ points: { 'store.before-write': { action: 'crash', nth: 3 }, 'chain.settle.after-send': { action: 'delay', ms: 500, p: 0.5, count: 2 } } });
    assert.deepEqual(spec, { seed: 0, points: { 'store.before-write': { action: 'crash', nth: 3 }, 'chain.settle.after-send': { action: 'delay', ms: 500, p: 0.5, count: 2 } } });
    assert.deepEqual(normalizeFailpointSpec({ seed: 7, id: 4, points: {} }), { id: '4', seed: 7, points: {} });
  });

  it('refuses unknown points, actions and settings', () => {
    const point = (rule) => () => normalizeFailpointSpec({ points: { 'store.before-write': rule } });
    assert.throws(() => normalizeFailpointSpec({ points: { 'store.nope': { action: 'crash' } } }), /Unknown fail point store.nope/);
    assert.throws(() => normalizeFailpointSpec(null), /spec is an object/);
    assert.throws(() => normalizeFailpointSpec({ seed: -1 }), /seed/);
    assert.throws(point({ action: 'hang' }), /action must be one of crash, error, delay/);
    assert.throws(point({ action: 'delay' }), /delay needs ms/);
    assert.throws(point({ action: 'crash', ms: 5 }), /only a delay takes ms/);
    assert.throws(point({ action: 'crash', nth: 0 }), /nth/);
    assert.throws(point({ action: 'error', p: 2 }), /p must be 0..1/);
    assert.throws(point({ action: 'error', count: 0 }), /count/);
    assert.throws(point({ action: 'error', probability: 1 }), /unknown settings: probability/);
    // A bad spec is the caller's mistake: the control API answers 400.
    assert.throws(point({ action: 'hang' }), (error) => error.statusCode === 400);
  });
});

describe('fail point registry', () => {
  const armed = (points, { seed = 1, id = 'a', journal = [] } = {}) => {
    const registry = createFailpointRegistry();
    registry.arm(normalizeFailpointSpec({ seed, id, points }), journal);
    return registry;
  };
  const triggers = (registry, name, hits, options) => Array.from({ length: hits }, () => registry.hit(name, options).trigger?.action ?? null);

  it('counts hits and reports the first hit of each point, armed or not', () => {
    const registry = createFailpointRegistry();
    assert.deepEqual(registry.hit('store.before-write'), { point: 'store.before-write', hit: 1, first: true, trigger: null });
    assert.deepEqual(registry.hit('store.before-write'), { point: 'store.before-write', hit: 2, first: false, trigger: null });
    assert.equal(registry.hit('store.after-write').first, true);
    assert.deepEqual(registry.totals(), { 'store.before-write': 2, 'store.after-write': 1 });
  });

  it('nth triggers on exactly that hit', () => {
    assert.deepEqual(triggers(armed({ 'store.before-write': { action: 'error', nth: 3 } }), 'store.before-write', 5), [null, null, 'error', null, null]);
  });

  it('without nth or p it triggers on every hit, up to count; a crash defaults to once', () => {
    assert.deepEqual(triggers(armed({ 'store.before-write': { action: 'error' } }), 'store.before-write', 3), ['error', 'error', 'error']);
    assert.deepEqual(triggers(armed({ 'store.before-write': { action: 'error', count: 2 } }), 'store.before-write', 4), ['error', 'error', null, null]);
    assert.deepEqual(triggers(armed({ 'store.before-write': { action: 'crash' } }), 'store.before-write', 3), ['crash', null, null]);
  });

  it('p is drawn from the seed and the point name: the same seed replays, another seed or point differs', () => {
    const pattern = (seed, name = 'store.before-write') => triggers(armed({ [name]: { action: 'error', p: 0.3 } }, { seed }), name, 200).map((action) => (action ? 1 : 0)).join('');
    assert.equal(pattern(5), pattern(5));
    assert.notEqual(pattern(5), pattern(6));
    assert.notEqual(pattern(5), pattern(5, 'store.after-write'));
    const share = [...pattern(5)].filter((bit) => bit === '1').length / 200;
    assert.ok(share > 0.15 && share < 0.45, `p 0.3 triggered ${share}`);
    assert.deepEqual(triggers(armed({ 'store.before-write': { action: 'error', p: 0 } }), 'store.before-write', 20).filter(Boolean), []);
  });

  it('a trigger the journal already holds for this spec counts, so a crash does not fire again after the restart', () => {
    const journal = [{ pid: 1, point: 'store.before-write', hit: 3, action: 'crash', spec: 'a' }];
    assert.deepEqual(triggers(armed({ 'store.before-write': { action: 'crash', nth: 3 } }, { journal }), 'store.before-write', 5), [null, null, null, null, null]);
    // Another arming's triggers, a reached line and a skipped delay do not count.
    const other = [{ pid: 1, point: 'store.before-write', hit: 3, action: 'crash', spec: 'earlier' }, { pid: 1, point: 'store.before-write', reached: true }, { pid: 1, point: 'store.before-write', hit: 1, action: 'delay', spec: 'a', skipped: 'sync point' }];
    assert.deepEqual(triggers(armed({ 'store.before-write': { action: 'crash', nth: 3 } }, { journal: other }), 'store.before-write', 4), [null, null, 'crash', null]);
    assert.deepEqual(triggersInJournal(journal, 'a'), { 'store.before-write': 1 });
  });

  it('arming again restarts the hit counts; disarming triggers nothing', () => {
    const registry = armed({ 'store.before-write': { action: 'error', nth: 2 } });
    assert.deepEqual(triggers(registry, 'store.before-write', 2), [null, 'error']);
    registry.arm(normalizeFailpointSpec({ id: 'b', points: { 'store.before-write': { action: 'error', nth: 2 } } }));
    assert.deepEqual(triggers(registry, 'store.before-write', 2), [null, 'error']);
    registry.arm(null);
    assert.deepEqual(triggers(registry, 'store.before-write', 3), [null, null, null]);
    assert.equal(registry.totals()['store.before-write'], 7);
  });

  it('a delay on a sync point is reported as skipped', () => {
    const registry = armed({ 'store.before-write': { action: 'delay', ms: 50, nth: 1 }, 'chain.close.before-send': { action: 'delay', ms: 50, nth: 1 } });
    assert.deepEqual(registry.hit('store.before-write', { sync: true }).trigger, { action: 'delay', ms: 50, skipped: 'sync point' });
    assert.deepEqual(registry.hit('chain.close.before-send').trigger, { action: 'delay', ms: 50 });
  });
});

describe('fail point journal', () => {
  it('parses lines and skips a torn last one', () => {
    assert.deepEqual(parseJournal('{"pid":1,"point":"a.b","reached":true}\n{"pid":1,"point":"a.b","hit":2,"action":"crash"}\n{"pid":1,"poi'), [{ pid: 1, point: 'a.b', reached: true }, { pid: 1, point: 'a.b', hit: 2, action: 'crash' }]);
    assert.deepEqual(parseJournal(''), []);
  });

  it('finds the crash of one process, the latest counts and whether a point triggered', () => {
    const entries = [
      { pid: 1, point: 'x.y', hit: 4, action: 'crash', at: 't1' },
      { pid: 2, point: 'x.y', reached: true },
      { pid: 2, counts: { 'x.y': 3 } },
      { pid: 2, point: 'x.z', hit: 1, action: 'error' },
      { pid: 2, counts: { 'x.y': 9 } },
    ];
    assert.equal(crashInJournal(entries, 1).hit, 4);
    assert.equal(crashInJournal(entries, 2), null);
    assert.deepEqual(countsInJournal(entries), { 'x.y': 9 });
    // A helper process that reached nothing leaves empty counts: not the node's.
    assert.deepEqual(countsInJournal([...entries, { pid: 3, counts: {} }]), { 'x.y': 9 });
    assert.equal(countsInJournal([]), null);
    assert.equal(triggeredInJournal(entries, 'x.y', 'crash'), true);
    assert.equal(triggeredInJournal(entries, 'x.z', 'crash'), false);
  });

  it('names a node\'s files and refuses anything that is not a node', () => {
    assert.equal(failpointFileName('buyer'), 'buyer.json');
    assert.equal(failpointFileName('seller:fast-1'), 'seller-fast-1.json');
    assert.throws(() => failpointFileName('seller:../x'), /buyer or seller:<id>/);
    assert.throws(() => failpointFileName('anvil'), /buyer or seller:<id>/);
    assert.equal(failpointJournalPath('/tb/failpoints/buyer.json'), '/tb/failpoints/buyer.journal.jsonl');
  });
});

describe('fail point plans', () => {
  it('a load crash is drawn from the points a load reaches, on the node that reaches them, within the measured hits', () => {
    const candidates = loadCrashCandidates();
    assert.ok(candidates.some((entry) => entry.who === 'buyer') && candidates.some((entry) => entry.who === 'seller'));
    assert.equal(candidates.some((entry) => /settle|close|withdraw/.test(entry.point)), false);
    const seen = new Set();
    for (let seed = 0; seed < 400; seed += 1) {
      const plan = drawLoadCrash(createPrng(seed));
      const entry = POINT_CATALOG[plan.point];
      assert.equal(entry.phase, 'load');
      assert.ok(entry.nodes.includes(plan.who), `${plan.point} is not reached by the ${plan.who}`);
      assert.ok(plan.nth >= 1 && plan.nth <= Math.max(1, entry.hits[plan.who] * 0.6), `${plan.point} nth ${plan.nth} of ${entry.hits[plan.who]}`);
      seen.add(`${plan.who} ${plan.point}`);
      assert.deepEqual(drawLoadCrash(createPrng(seed)), plan);
    }
    assert.equal(seen.size, candidates.length, 'every candidate is drawn by some seed');
    assert.deepEqual(crashSpec({ point: 'store.before-write', nth: 4 }), { points: { 'store.before-write': { action: 'crash', nth: 4 } } });
  });

  it('every point a load reaches has a measured hit count for each node that reaches it', () => {
    for (const [point, entry] of Object.entries(POINT_CATALOG)) {
      if (entry.phase !== 'load') { assert.equal(entry.hits, undefined, `${point} is not reached under load`); continue; }
      for (const who of entry.nodes) assert.ok(Number.isInteger(entry.hits?.[who]) && entry.hits[who] >= 1, `${point} needs hits.${who}`);
    }
  });

  it('a close crash is on the seller, at a settle or close step or a store write', () => {
    const points = closeCrashCandidates().map((entry) => entry.point);
    assert.deepEqual(points, ['chain.settle.before-send', 'chain.settle.after-send', 'chain.settle.after-receipt', 'chain.close.before-send', 'chain.close.after-send', 'chain.close.after-receipt', 'store.before-write', 'store.after-write']);
    const seen = new Set();
    for (let seed = 0; seed < 200; seed += 1) {
      const plan = drawCloseCrash(createPrng(seed));
      assert.deepEqual([plan.who, plan.nth], ['seller', 1]);
      seen.add(plan.point);
    }
    assert.equal(seen.size, points.length);
  });

  it('a crash record becomes the load\'s restart window', () => {
    const restart = restartFromCrash({ who: 'seller:seller', point: 'store.after-write', hit: 7, at: '2026-01-01T00:00:10.000Z', restartedAt: '2026-01-01T00:00:18.500Z' }, Date.parse('2026-01-01T00:00:00.000Z'));
    assert.deepEqual(restart, { who: 'seller', failpoint: 'store.after-write', hit: 7, crashed: true, stoppedAt: 10_000, downMs: 8500 });
  });
});

/** Runs `script` in a node process with the fail point preload; resolves with how it ended and what it printed. */
function runWithPreload(script, env) {
  const preload = pathToFileURL(join(here, '..', 'lib', 'failpoint-preload.mjs')).href;
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', preload, '--input-type=module', '-e', script], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr, pid: child.pid }));
  });
}

const HANDLER = `globalThis[Symbol.for('${FAILPOINT_HANDLER_KEY}')]`;

describe('fail point preload', () => {
  const withDir = async (test) => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-failpoints-'));
    try { await test(join(dir, 'seller-a.json'), join(dir, 'seller-a.journal.jsonl')); } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const journalOf = async (path) => parseJournal(await readFile(path, 'utf8').catch(() => ''));

  it('installs nothing without the spec file variable', async () => {
    const result = await runWithPreload(`console.log(typeof ${HANDLER});`, {});
    assert.deepEqual([result.code, result.stdout.trim()], [0, 'undefined']);
  });

  it('hooks the node itself only: a process it starts does not inherit the spec file', async () => {
    await withDir(async (specPath) => {
      const result = await runWithPreload(`console.log(typeof ${HANDLER}, process.env.${FAILPOINTS_FILE_ENV} ?? 'unset');`, { [FAILPOINTS_FILE_ENV]: specPath });
      assert.deepEqual([result.code, result.stdout.trim()], [0, 'object unset']);
    });
  });

  it('a crash is journaled, logged and kills the process with SIGKILL; the restarted process does not crash again', async () => {
    await withDir(async (specPath, journalPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'a', seed: 1, points: { 'store.before-write': { action: 'crash', nth: 2 } } }));
      const script = `process.on('exit', () => console.log('exit handler ran')); const h = ${HANDLER}; for (let i = 1; i <= 4; i += 1) { h.hitSync('store.before-write'); console.log('survived ' + i); }`;
      const first = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath });
      assert.deepEqual([first.code, first.signal, first.stdout], [null, 'SIGKILL', 'survived 1\n']);
      assert.match(first.stderr, /\[Failpoint\] store\.before-write hit=2 action=crash/);
      const entries = await journalOf(journalPath);
      assert.deepEqual(entries.map(({ at, ...entry }) => entry), [
        { pid: first.pid, point: 'store.before-write', reached: true },
        { pid: first.pid, point: 'store.before-write', hit: 2, action: 'crash', spec: 'a' },
      ]);
      assert.equal(crashInJournal(entries, first.pid).point, 'store.before-write');
      assert.ok(!Number.isNaN(Date.parse(entries[1].at)));

      const second = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath });
      assert.deepEqual([second.code, second.signal], [0, null]);
      assert.match(second.stdout, /survived 4\nexit handler ran/);
      assert.equal(crashInJournal(await journalOf(journalPath), second.pid), null);
      // A graceful exit leaves the hit counts.
      assert.deepEqual(countsInJournal(await journalOf(journalPath)), { 'store.before-write': 4 });
    });
  });

  it('an error throws FailpointError from the point, sync and async; a delay waits on an async point only', async () => {
    await withDir(async (specPath, journalPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'a', points: {
        'store.after-write': { action: 'error', nth: 1 }, 'chain.close.before-send': { action: 'error', nth: 1 },
        'chain.settle.after-send': { action: 'delay', ms: 300, nth: 1 }, 'seller.need-auth.before-send': { action: 'delay', ms: 300, nth: 1 },
      } }));
      const script = `
        const h = ${HANDLER};
        const out = {};
        try { h.hitSync('store.after-write'); out.sync = 'no error'; } catch (error) { out.sync = error.name + ':' + error.point; }
        h.hitSync('store.after-write');
        try { await h.hit('chain.close.before-send'); out.async = 'no error'; } catch (error) { out.async = error.name + ':' + error.point; }
        let started = Date.now();
        await h.hit('chain.settle.after-send');
        out.delayed = Date.now() - started >= 280;
        started = Date.now();
        h.hitSync('seller.need-auth.before-send');
        out.syncDelay = Date.now() - started < 200;
        out.untouched = (await h.hit('chain.reserve.before-send')) === undefined;
        console.log(JSON.stringify(out));`;
      const result = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { sync: 'FailpointError:store.after-write', async: 'FailpointError:chain.close.before-send', delayed: true, syncDelay: true, untouched: true });
      const skipped = (await journalOf(journalPath)).find((entry) => entry.skipped);
      assert.deepEqual([skipped.point, skipped.action, skipped.skipped], ['seller.need-auth.before-send', 'delay', 'sync point']);
      assert.match(result.stderr, /seller\.need-auth\.before-send hit=1 action=delay \(skipped: sync point\)/);
    });
  });

  it('picks up a spec written while the process runs, and journals the counts up to then', async () => {
    await withDir(async (specPath, journalPath) => {
      const script = `
        import { writeFileSync, renameSync } from 'node:fs';
        const h = ${HANDLER};
        h.hitSync('store.before-write');
        writeFileSync(process.env.SPEC + '.tmp', JSON.stringify({ id: 'late', points: { 'store.before-write': { action: 'error', nth: 2 } } }));
        renameSync(process.env.SPEC + '.tmp', process.env.SPEC);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const seen = [];
        for (let i = 0; i < 3; i += 1) { try { h.hitSync('store.before-write'); seen.push('ok'); } catch { seen.push('error'); } }
        console.log(seen.join(','));`;
      const result = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath, SPEC: specPath });
      assert.equal(result.code, 0, result.stderr);
      // Hits are counted from the arming: the hit before it does not move the nth.
      assert.equal(result.stdout.trim(), 'ok,error,ok');
      assert.match(result.stderr, /\[Failpoint\] armed store\.before-write=error@2/);
      assert.deepEqual((await journalOf(journalPath)).find((entry) => entry.counts).counts, { 'store.before-write': 1 });
    });
  });

  it('drives the payment code\'s own hook when buyer-core is built', async (t) => {
    const built = join(repo, 'packages/buyer-core/dist/failpoints.js');
    if (!existsSync(built)) return t.skip('packages/buyer-core is not built');
    await withDir(async (specPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'a', points: { 'chain.settle.before-send': { action: 'error', nth: 2 }, 'store.before-write': { action: 'error', nth: 1 } } }));
      const script = `
        const { hitFailpoint, hitFailpointSync, FAILPOINTS } = await import(${JSON.stringify(pathToFileURL(built).href)});
        const out = { points: FAILPOINTS.length };
        await hitFailpoint('chain.settle.before-send');
        out.second = await hitFailpoint('chain.settle.before-send').then(() => 'resolved', (error) => error.name);
        try { hitFailpointSync('store.before-write'); out.sync = 'returned'; } catch (error) { out.sync = error.name; }
        console.log(JSON.stringify(out));`;
      const armed = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath });
      assert.equal(armed.code, 0, armed.stderr);
      assert.deepEqual(JSON.parse(armed.stdout), { points: Object.keys(POINT_CATALOG).length, second: 'FailpointError', sync: 'FailpointError' });
      // The same code without the testbench's variable: no handler, so the points do nothing.
      const inert = await runWithPreload(script, {});
      assert.deepEqual(JSON.parse(inert.stdout), { points: Object.keys(POINT_CATALOG).length, second: 'resolved', sync: 'returned' });
    });
  });
});

describe('fail point plumbing', () => {
  it('a sweep shows the plan a fail point run printed', () => {
    const run = readRunOutput(4, 1, '[failpoint] plan: crash the seller at seller.top-up.after-verify hit 4\n[testbench] FAIL load gate\n[testbench] rerun: pnpm testbench run stress-failpoint-crash --seed 4\n');
    assert.equal(run.plan, 'crash the seller at seller.top-up.after-verify hit 4');
    assert.ok(sweepSummary('stress-failpoint-crash', [run]).some((line) => line.includes('seed 4: failed  [crash the seller at seller.top-up.after-verify hit 4]')));
  });

  it('a cli node gets the preload and its spec file only when it is handed one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-failpoints-env-'));
    try {
      const plain = cliNodeEnv({ PATH: '/bin', [FAILPOINTS_FILE_ENV]: '/stale.json' }, join(dir, 'home'));
      assert.equal(plain[FAILPOINTS_FILE_ENV], undefined);
      assert.doesNotMatch(plain.NODE_OPTIONS, /failpoint-preload/);
      const hooked = cliNodeEnv({ PATH: '/bin' }, join(dir, 'home'), { ANTSEED_DEBUG: '1' }, undefined, { failpointsFile: '/tb/failpoints/buyer.json' });
      assert.equal(hooked[FAILPOINTS_FILE_ENV], '/tb/failpoints/buyer.json');
      assert.match(hooked.NODE_OPTIONS, /--unhandled-rejections=warn --import file:.*isolate-preload\.mjs --import file:.*failpoint-preload\.mjs$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('topology.failpoints needs cli mode and is part of the fingerprint only when set', () => {
    const base = stressTopology();
    const on = stressTopology({ failpoints: true });
    assert.equal(normalizeTopology(on, source).failpoints, true);
    assert.equal('failpoints' in normalizeTopology(base, source), false);
    assert.notEqual(topologyFingerprint(normalizeTopology(on, source)), topologyFingerprint(normalizeTopology(base, source)));
    assert.throws(() => normalizeTopology({ ...on, mode: 'sdk' }, source), /topology.failpoints needs mode cli/);
    assert.throws(() => normalizeTopology(on, source, { mode: 'sdk' }), /topology.failpoints needs mode cli/);
    assert.throws(() => normalizeTopology({ ...base, failpoints: 'yes' }, source), /must be true or false/);
  });

  it('a scenario that requires failpoints is refused in sdk mode before anything starts', () => {
    const scenario = validateScenarioModule({ run() {}, meta: { targets: ['local', 'fork'], requires: ['failpoints'] } }, 'fp');
    assert.throws(() => assertScenarioSupported(scenario, 'local', 'sdk'), /Mode sdk lacks failpoints required by fp; run it with --mode cli/);
    assert.doesNotThrow(() => assertScenarioSupported(scenario, 'local', 'cli'));
    assert.doesNotThrow(() => assertScenarioSupported(scenario, 'fork', 'cli'));
    assert.throws(() => assertScenarioSupported(validateScenarioModule({ run() {}, meta: { targets: ['mainnet'], requires: ['failpoints'] } }, 'm'), 'mainnet', 'cli'), /lacks failpoints/);
  });

  it('the control API routes a node name with a colon, and the client arms, clears and reads', async () => {
    const token = newToken();
    const calls = [];
    const server = await startControlServer({
      token,
      routes: {
        'GET /failpoints/:who': ({ params }) => ({ journal: [{ who: params.who }] }),
        'POST /failpoints/:who': ({ params, body }) => { calls.push([params.who, body]); return { spec: body.spec ?? null }; },
        'POST /sellers/:id/stop': ({ params }) => ({ id: params.id }),
      },
    });
    try {
      const client = controlClient({ url: server.url, token });
      assert.deepEqual((await client.setFailpoints('seller:fast-1', { points: {} })).spec, { points: {} });
      await client.clearFailpoints('buyer');
      assert.deepEqual(calls, [['seller:fast-1', { spec: { points: {} } }], ['buyer', { clear: true }]]);
      assert.deepEqual((await client.failpoints('seller:fast-1')).journal, [{ who: 'seller:fast-1' }]);
      assert.deepEqual((await client.stopSeller('s-1')).id, 's-1');
      const bad = await fetch(`${server.url}/failpoints/a:b:c`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(bad.status, 404);
    } finally {
      await server.stop();
    }
  });
});

/** An OpenAI-shaped server that fails while `down()` says so. */
async function flakyServer(down) {
  let served = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    served += 1;
    response.setHeader('content-type', 'application/json');
    if (down()) { response.statusCode = 502; response.end(JSON.stringify({ error: 'upstream_error' })); return; }
    response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  return { url: `http://127.0.0.1:${server.address().port}`, served: () => served, stop: () => new Promise((closed) => server.close(closed)) };
}

/** A real tb over a temp testbench directory and a fake control client. */
async function withTb({ proxyUrl = 'http://127.0.0.1:1', control, seed = 0 }, test) {
  const dir = await mkdtemp(join(tmpdir(), 'tb-failpoints-tb-'));
  await mkdir(join(dir, 'logs'));
  for (const name of ['seller-seller.log', 'supervisor.log']) await writeFile(join(dir, 'logs', name), STARTED);
  const manifest = { dir, proxyUrl, rpcUrl: 'http://127.0.0.1:1', buyer: { address: ZERO_ADDRESS }, topology: { sellers: [] }, logStart: {}, sellers: [{ id: 'seller', peerId: 'a'.repeat(40), address: ZERO_ADDRESS, models: ['m'] }] };
  const chain = { depositsContractAddress: ZERO_ADDRESS, usdcContractAddress: ZERO_ADDRESS, channelsContractAddress: ZERO_ADDRESS };
  const tb = createTestbenchApi({ manifest, control, eventsPath: join(dir, 'events.jsonl'), chain, seed });
  try { await test(tb, dir); } finally { await tb.dispose(); await rm(dir, { recursive: true, force: true }); }
}

const CLEAN_HEALTH = { unexpectedExits: [], forcedStops: [], unhandledRejections: [], failpointCrashes: [] };

describe('fail points in the scenario API', () => {
  it('runLoad asks `hold` before every request and waits for what it returns', async () => {
    let down = false;
    const server = await flakyServer(() => down);
    try {
      const shape = { concurrency: 2, requests: 12, streamRatio: 0, minInTokens: 1, maxInTokens: 2 };
      const plain = await runLoad({ proxyUrl: server.url, model: 'm', load: shape, random: createPrng(3) });
      let holds = 0;
      let failuresSeen = 0;
      const held = await runLoad({
        proxyUrl: server.url, model: 'm', random: createPrng(3),
        load: { ...shape, hold: (last) => {
          if (!last?.error) { if (server.served() >= 16 && holds === 0) down = true; return null; }
          failuresSeen += 1;
          holds += 1;
          // The "restart": the node is back once the hold resolves.
          return new Promise((resolveHold) => setTimeout(() => { down = false; resolveHold(); }, 30));
        } },
      });
      assert.equal(held.results.length, 12);
      assert.ok(failuresSeen >= 1 && held.client.failed <= 2, `a worker stops sending once it is held (${held.client.failed} failed)`);
      // The hook does not change which requests a seed sends.
      assert.deepEqual(held.results.map((record) => record.tag).sort(), plain.results.map((record) => record.tag).sort());
    } finally {
      await server.stop();
    }
  });

  it('tb.faults arms with a seed derived from the run seed, clears, reads the journal and waits for the restart', async () => {
    const calls = [];
    const health = structuredClone(CLEAN_HEALTH);
    const control = {
      health: async () => health,
      setFailpoints: async (who, spec) => { calls.push(['arm', who, spec]); return { spec: { ...spec, id: '1' } }; },
      clearFailpoints: async (who) => { calls.push(['clear', who]); return {}; },
      failpoints: async (who) => ({ journal: [{ who, point: 'store.before-write', reached: true }] }),
    };
    await withTb({ control, seed: 9 }, async (tb, dir) => {
      const armed = await tb.faults.failpoints('seller:seller', { points: { 'store.before-write': { action: 'crash', nth: 2 } } });
      assert.equal(armed.id, '1');
      assert.ok(Number.isInteger(calls[0][2].seed) && calls[0][2].seed > 0);
      assert.deepEqual(calls[0][2].points, { 'store.before-write': { action: 'crash', nth: 2 } });
      // An explicit seed wins; another node gets another derived seed.
      await tb.faults.failpoints('buyer', { seed: 5, points: {} });
      assert.equal(calls[1][2].seed, 5);
      await tb.faults.failpoints('buyer', { points: {} });
      assert.notEqual(calls[2][2].seed, calls[0][2].seed);
      await tb.faults.clearFailpoints('buyer');
      assert.deepEqual(calls.at(-1), ['clear', 'buyer']);
      assert.deepEqual(await tb.faults.failpointJournal('buyer'), [{ who: 'buyer', point: 'store.before-write', reached: true }]);

      await assert.rejects(tb.faults.waitForFailpointRestart('seller:seller', { timeoutMs: 300 }), /Timed out .* seller:seller to be killed by a fail point and restarted/);
      const crash = { who: 'seller:seller', point: 'store.before-write', hit: 2, at: new Date().toISOString(), pid: 7 };
      health.failpointCrashes.push({ who: 'buyer', point: 'x.y', hit: 1, at: 't', restartedAt: 't' }, crash);
      setTimeout(() => { crash.restartedAt = new Date().toISOString(); }, 300);
      assert.equal((await tb.faults.waitForFailpointRestart('seller:seller', { timeoutMs: 5000 })).pid, 7);
      health.failpointCrashes.push({ who: 'seller:seller', point: 'store.before-write', hit: 2, at: 't', restartError: 'seller start timeout' });
      await assert.rejects(tb.faults.waitForFailpointRestart('seller:seller', { timeoutMs: 1000 }), /did not come back after fail point store.before-write: seller start timeout/);
      const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line).type);
      assert.deepEqual([...new Set(events)], ['fault-failpoints', 'fault-failpoints-clear', 'failpoint-restart']);
    });
  });

  it('tb.load({ failpointCrash }) holds the load while the killed node is down and returns the restart it saw', async () => {
    let down = false;
    let served = 0;
    const health = structuredClone(CLEAN_HEALTH);
    // A crash from before this load is not this load's.
    health.failpointCrashes.push({ who: 'buyer', point: 'store.after-write', hit: 1, at: '2020-01-01T00:00:00.000Z', restartedAt: '2020-01-01T00:00:05.000Z' });
    // The node dies on the 7th request, and is back 400 ms later.
    const server = await flakyServer(() => {
      served += 1;
      if (served === 7) {
        down = true;
        const crash = { who: 'buyer', point: 'buyer.spending-auth.after-sign', hit: 3, at: new Date().toISOString(), pid: 9 };
        health.failpointCrashes.push(crash);
        setTimeout(() => { down = false; crash.restartedAt = new Date().toISOString(); }, 400);
      }
      return down;
    });
    const control = { health: async () => health };
    try {
      await withTb({ proxyUrl: server.url, control }, async (tb) => {
        const run = await tb.load({ concurrency: 4, requests: 40, streamRatio: 0, minInTokens: 1, maxInTokens: 2, gate: GATES['failpoint-crash'], failpointCrash: { who: 'buyer' } });
        assert.deepEqual([run.restart.who, run.restart.failpoint, run.restart.hit, run.restart.crashed], ['buyer', 'buyer.spending-auth.after-sign', 3, true]);
        assert.ok(run.restart.downMs >= 350 && run.restart.stoppedAt >= 0, JSON.stringify(run.restart));
        // Held workers did not burn the load on the dead node, and what failed is inside the restart window.
        assert.ok(run.client.failed >= 1 && run.client.failed <= 8, `${run.client.failed} failed`);
        assert.equal(run.client.failedOutsideRestartWindow, 0);
        assert.deepEqual(run.gateProblems, []);
        assert.deepEqual(tb.summary().metrics.load[0].restart, run.restart);
        await assert.rejects(tb.load({ requests: 1, restart: { who: 'buyer', atFraction: 0.5 }, failpointCrash: { who: 'buyer' } }), /not both/);
        // No crash during a load: no restart record.
        const calm = await tb.load({ concurrency: 2, requests: 4, streamRatio: 0, minInTokens: 1, maxInTokens: 2, failpointCrash: { who: 'seller:seller' } });
        assert.equal(calm.restart, null);
      });
    } finally {
      await server.stop();
    }
  });

  it('tb.withFailpointRestart judges a load against a crash that came after it', async () => {
    const server = await flakyServer(() => false);
    try {
      await withTb({ proxyUrl: server.url, control: { health: async () => CLEAN_HEALTH } }, async (tb) => {
        const run = await tb.load({ concurrency: 2, requests: 4, streamRatio: 0, minInTokens: 1, maxInTokens: 2, gate: GATES['failpoint-crash'] });
        const at = new Date(run.startedAt + run.loadMs + 2000).toISOString();
        const judged = tb.withFailpointRestart(run, { who: 'seller:seller', point: 'seller.need-auth.after-send', hit: 4, at, restartedAt: new Date(Date.parse(at) + 6000).toISOString() });
        assert.deepEqual([judged.restart.who, judged.restart.failpoint, judged.restart.downMs], ['seller', 'seller.need-auth.after-send', 6000]);
        assert.equal(judged.client.failedOutsideRestartWindow, 0);
        assert.deepEqual(judged.gateProblems, []);
        assert.deepEqual(tb.summary().metrics.load.at(-1).restart, judged.restart);
        // A failure long before the crash is outside its window, and the gate says so.
        const failed = { ...run, results: [...run.results, { i: 9, start: run.startedAt, ms: 5, error: '502:upstream_error' }] };
        assert.deepEqual(tb.withFailpointRestart(failed, { who: 'buyer', point: 'store.after-write', hit: 1, at: new Date(run.startedAt + 600_000).toISOString(), restartedAt: new Date(run.startedAt + 601_000).toISOString() }).gateProblems, ['1 failures outside the restart window']);
      });
    } finally {
      await server.stop();
    }
  });

  it('assertNoCrashes does not count a fail point crash as an unexpected exit, but fails when the node did not come back', async () => {
    const crash = { who: 'seller:seller', point: 'store.before-write', hit: 2, at: 't', pid: 7, restartedAt: 't2' };
    await withTb({ control: { health: async () => ({ ...CLEAN_HEALTH, failpointCrashes: [crash] }) } }, async (tb) => {
      await tb.assertNoCrashes();
      const checks = tb.summary().checks;
      assert.equal(checks.every((check) => check.ok), true);
      assert.deepEqual(checks.find((check) => check.name === 'every node a fail point killed was started again').detail, [{ id: 'seller:seller', point: 'store.before-write', hit: 2, at: 't', pid: 7, restartedAt: 't2' }]);
    });
    await withTb({ control: { health: async () => ({ ...CLEAN_HEALTH, failpointCrashes: [{ ...crash, restartedAt: undefined, restartError: 'seller start timeout' }] }) } }, async (tb) => {
      await assert.rejects(tb.assertNoCrashes(), /every node a fail point killed was started again/);
    });
    // A real exit next to a fail point crash still fails.
    await withTb({ control: { health: async () => ({ ...CLEAN_HEALTH, failpointCrashes: [crash], unexpectedExits: [{ who: 'buyer', code: 1, signal: null, at: 't' }] }) } }, async (tb) => {
      await assert.rejects(tb.assertNoCrashes(), /no peer exited unexpectedly/);
    });
  });

  it('stressRun judges the run `afterLoad` returns and tells the oracle about a restart the load observed', async () => {
    const seen = {};
    const restart = { who: 'seller', failpoint: 'store.after-write', crashed: true, stoppedAt: 1, downMs: 2 };
    const client = { total: 1, ok: 1, clientAborted: 0, failed: 0, failures: {}, streamed: { ttfb: {} }, nonStreamed: {} };
    const tb = {
      paymentSnapshot: async () => ({ deliveredTags: [] }),
      chat: async () => ({}),
      waitFor: async (predicate) => predicate(),
      prng: () => Math.random,
      load: async (options) => { seen.load = options; return { results: [{ tag: 'a' }], client, restart: null, gate: options.gate, gateProblems: [] }; },
      assertDeliveredWorkPaid: async ({ injected }) => { seen.injected = injected; },
      assertNoCrashes: async () => {},
      deliveries: async () => ({ byTag: {} }),
      summary: () => ({ metrics: {} }),
      check: (name, ok) => { (seen.checks ??= []).push([name, ok]); },
      checkGate: (run) => { seen.gated = run.restart; },
      timings: () => {},
    };
    const run = await stressRun(tb, {
      load: { concurrency: 1, requests: 1, failpointCrash: { who: 'seller:seller' } },
      gate: GATES['failpoint-crash'],
      afterLoad: async (loaded) => ({ ...loaded, restart }),
      evidence: ({ run: judged }) => [{ name: 'fault path ran: x', ok: judged.restart === restart }],
    });
    assert.deepEqual(seen.load.failpointCrash, { who: 'seller:seller' });
    assert.equal(seen.injected.restart, restart);
    assert.equal(seen.gated, restart);
    assert.deepEqual(seen.checks, [['fault path ran: x', true]]);
    assert.equal(run.restart, restart);
    assert.deepEqual(gateProblems({ ...client, failedOutsideRestartWindow: 1 }, GATES['failpoint-crash']), ['1 failures outside the restart window']);
  });
});
