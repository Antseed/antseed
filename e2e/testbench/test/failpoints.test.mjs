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
  allPointsSpec, armedSpec, drawExitCrashes, keyedDecision, CATALOG_LOAD_REQUESTS, closeCrashCandidates, correlatedCrashSpecs, countsInJournal, crashBlocked, crashesAndDelaysSpec, crashesInJournal, crashesOfArming, crashInJournal, crashSpec,
  crashStateAfterKill, crashStateAfterRestart, createFailpointRegistry, delaysInJournal, downWindowsOverlap, drawCloseCrash, drawCorrelatedCrash, drawCrashesAndDelaysPlan, drawLoadCrash, emptyCrashState,
  FAILPOINT_HANDLER_KEY, failpointCrashOfExit, FailpointError, failpointFileName, failpointJournalPath, FAILPOINTS_FILE_ENV, failpointSharedStatePath, graceFor, loadCrashCandidates, MAX_RARE_POINT_P,
  normalizeFailpointSpec, parseJournal, POINT_CATALOG, pointsOfNode, restartDelayFor, restartFromCrash, triggeredInJournal, triggersInJournal,
} from '../lib/failpoints.mjs';
import { closePhaseSpec, CRASHES_AND_DELAYS_LOAD, crashesAndDelaysPlan, crashesEvidence, crashesFiredLine, crashesPlanLine, drawClosePhasePlan, failpointCoverage } from '../lib/crashes-and-delays.mjs';
import { createPrng, derive } from '../lib/prng.mjs';
import { clientSummary, closeWhenReachable, CRASHES_GATE_SLACK, crashesDuringLoad, crashesGate, gateProblems, GATES, runLoad, stressRun, stressTopology } from '../lib/stress.mjs';
import { scenarioFiles, failpointPlanText } from '../lib/scenarios.mjs';
import { coverageSummary, readRunOutput, sweepCoverage, sweepSlotArgs, sweepSlotProblem, sweepSummary } from '../lib/sweep.mjs';
import { cliFailpointOutcome, createCliRunner } from '../lib/cli-run.mjs';
import { parseArgs } from '../lib/options.mjs';
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

  it('takes a list of rules for a point, and a delay range', () => {
    const points = { 'chain.top-up.after-send': [{ action: 'delay', ms: [200, 900], p: 0.2 }, { action: 'crash', p: 0.05 }], 'store.before-write': { action: 'crash', p: 0.001 } };
    assert.deepEqual(normalizeFailpointSpec({ seed: 3, points }), { seed: 3, points });
    const point = (rule) => () => normalizeFailpointSpec({ points: { 'chain.top-up.after-send': rule } });
    assert.throws(point([]), /at least one rule/);
    assert.throws(point([{ action: 'delay', ms: 5 }, { action: 'hang' }]), /action must be one of/);
    assert.throws(point([{ action: 'delay', ms: 5 }, null]), /needs \{ action \}/);
    assert.throws(point({ action: 'delay', ms: [900, 200] }), /delay needs ms/);
    assert.throws(point({ action: 'delay', ms: [1, 2, 3] }), /delay needs ms/);
    assert.throws(point({ action: 'delay', ms: [0, 120_001] }), /delay needs ms/);
    assert.throws(point({ action: 'crash', ms: [1, 2] }), /only a delay takes ms/);
  });

  it('keeps and checks the spec-level settings: maxCrashes, graceMs, restartDelayMs, ignoreOthers', () => {
    const spec = { seed: 1, maxCrashes: 3, graceMs: 9000, restartDelayMs: [1500, 8000], points: { 'store.before-write': { action: 'crash', p: 0.01 } } };
    assert.deepEqual(normalizeFailpointSpec(spec), spec);
    assert.deepEqual(normalizeFailpointSpec({ ...spec, id: 'x', graceMs: 0, restartDelayMs: [0, 0] }), { id: 'x', ...spec, graceMs: 0, restartDelayMs: [0, 0] });
    // The grace window is a number or a range drawn per crash; a spec can opt out of the shared rule.
    assert.deepEqual(normalizeFailpointSpec({ ...spec, graceMs: [5000, 20_000], ignoreOthers: true }), { seed: 1, maxCrashes: 3, graceMs: [5000, 20_000], restartDelayMs: [1500, 8000], ignoreOthers: true, points: spec.points });
    assert.equal('ignoreOthers' in normalizeFailpointSpec({ ...spec, ignoreOthers: false }), false);
    const withSetting = (setting) => () => normalizeFailpointSpec({ points: {}, ...setting });
    assert.throws(withSetting({ maxCrashes: 0 }), /maxCrashes must be a positive integer/);
    assert.throws(withSetting({ maxCrashes: 1.5 }), /maxCrashes/);
    assert.throws(withSetting({ graceMs: -1 }), /graceMs must be a non-negative integer/);
    assert.throws(withSetting({ graceMs: [9000, 5000] }), /graceMs/);
    assert.throws(withSetting({ graceMs: [0, 120_001] }), /graceMs/);
    assert.throws(withSetting({ ignoreOthers: 'yes' }), /ignoreOthers must be true or false/);
    assert.throws(withSetting({ restartDelayMs: 1000 }), /restartDelayMs must be \[min, max\]/);
    assert.throws(withSetting({ restartDelayMs: [5000, 1000] }), /restartDelayMs/);
    assert.throws(withSetting({ restartDelayMs: [0, 120_001] }), /restartDelayMs/);
    assert.throws(withSetting({ maxCrashs: 2 }), /unknown settings: maxCrashs/);
    assert.throws(withSetting({ graceMs: -1 }), (error) => error.statusCode === 400);
  });

  it('a crash rule may wait for another node to be down; nothing else takes whenDown', () => {
    const points = { 'store.before-write': { action: 'crash', whenDown: 'buyer', count: 1 }, 'store.after-write': { action: 'crash', whenDown: 'seller:fast-1' } };
    assert.deepEqual(normalizeFailpointSpec({ points }).points, points);
    const point = (rule) => () => normalizeFailpointSpec({ points: { 'store.before-write': rule } });
    assert.throws(point({ action: 'error', whenDown: 'buyer' }), /whenDown names the node/);
    assert.throws(point({ action: 'crash', whenDown: 'anvil' }), /whenDown names the node/);
    assert.throws(point({ action: 'crash', whenDown: true }), /whenDown/);
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

  it('a list of rules is tried in order and the first that triggers wins', () => {
    const registry = armed({ 'chain.top-up.after-send': [{ action: 'delay', ms: 40, nth: 2 }, { action: 'error', count: 2 }] });
    const seen = Array.from({ length: 4 }, () => registry.hit('chain.top-up.after-send').trigger);
    assert.deepEqual(seen, [{ action: 'error', rule: 1 }, { action: 'delay', ms: 40, rule: 0 }, { action: 'error', rule: 1 }, null]);
    // A single rule carries no rule index: the journal line stays what it was.
    assert.deepEqual(armed({ 'store.before-write': { action: 'error' } }).hit('store.before-write').trigger, { action: 'error' });
  });

  it('a delay range is drawn per trigger, from the seed', () => {
    const drawn = (seed) => { const registry = armed({ 'chain.top-up.after-send': { action: 'delay', ms: [200, 900] } }, { seed }); return Array.from({ length: 30 }, () => registry.hit('chain.top-up.after-send').trigger.ms); };
    assert.ok(drawn(4).every((ms) => Number.isInteger(ms) && ms >= 200 && ms <= 900));
    assert.ok(new Set(drawn(4)).size > 10);
    assert.deepEqual(drawn(4), drawn(4));
    assert.notDeepEqual(drawn(4), drawn(5));
  });

  it('only the first delay of a point in an arming is loud; the registry counts them all', () => {
    const registry = armed({ 'chain.top-up.after-send': { action: 'delay', ms: 10 }, 'store.before-write': { action: 'delay', ms: 10 } });
    assert.deepEqual(Array.from({ length: 3 }, () => registry.hit('chain.top-up.after-send').trigger.quiet ?? false), [false, true, true]);
    // A skipped delay did not wait: it is not counted, and stays a journal line each time.
    assert.deepEqual(Array.from({ length: 2 }, () => registry.hit('store.before-write', { sync: true }).trigger), [{ action: 'delay', ms: 10, skipped: 'sync point' }, { action: 'delay', ms: 10, skipped: 'sync point' }]);
    assert.deepEqual(registry.delays(), { 'chain.top-up.after-send': 3 });
    registry.arm(normalizeFailpointSpec({ id: 'b', points: { 'chain.top-up.after-send': { action: 'delay', ms: 10 } } }));
    assert.deepEqual(registry.delays(), {});
    assert.equal(registry.hit('chain.top-up.after-send').trigger.quiet, undefined);
  });

  it('a delay count holds across lives through the journal\'s delay totals', () => {
    const journal = [{ pid: 1, point: 'chain.top-up.after-send', hit: 1, action: 'delay', ms: 10, spec: 'a' }, { pid: 1, delays: { 'chain.top-up.after-send': 2 }, spec: 'a' }, { pid: 0, delays: { 'chain.top-up.after-send': 9 }, spec: 'earlier' }];
    assert.deepEqual(triggers(armed({ 'chain.top-up.after-send': { action: 'delay', ms: 10, count: 3 } }, { journal }), 'chain.top-up.after-send', 3), ['delay', null, null]);
    assert.deepEqual(delaysInJournal(journal, 'a'), { 'chain.top-up.after-send': 2 });
    assert.deepEqual(delaysInJournal([...journal, { pid: 2, delays: { 'chain.top-up.after-send': 1, 'chain.reserve.after-send': 4 }, spec: 'a' }], 'a'), { 'chain.top-up.after-send': 3, 'chain.reserve.after-send': 4 });
  });

  it('maxCrashes caps the crashes of an arming over all points and lives, and lifts the per-point default of one', () => {
    const points = { 'store.before-write': { action: 'crash' }, 'store.after-write': { action: 'crash' } };
    const crash = (point, pid) => ({ pid, point, hit: 1, action: 'crash', spec: 'a' });
    const life = (journal, maxCrashes = 3) => {
      const registry = createFailpointRegistry();
      registry.arm(normalizeFailpointSpec({ seed: 1, id: 'a', maxCrashes, points }), journal);
      return registry;
    };
    // Second life: the same point may crash again (no per-point cap of one), the journal's crash counts.
    assert.equal(life([crash('store.before-write', 1)]).hit('store.before-write').trigger.action, 'crash');
    assert.equal(life([crash('store.before-write', 1), crash('store.before-write', 2)]).hit('store.after-write').trigger.action, 'crash');
    // The cap is reached: nothing crashes any more, at any point.
    const spent = life([crash('store.before-write', 1), crash('store.before-write', 2), crash('store.after-write', 3)]);
    assert.deepEqual([spent.hit('store.before-write').trigger, spent.hit('store.after-write').trigger], [null, null]);
    // Another arming's crashes and a torn spec id do not count.
    assert.equal(life([{ ...crash('store.before-write', 1), spec: 'earlier' }], 1).hit('store.before-write').trigger.action, 'crash');
    // Without maxCrashes a crash rule still fires once per point, as before.
    assert.deepEqual(triggers(armed(points, { journal: [crash('store.before-write', 1)] }), 'store.before-write', 3), [null, null, null]);
    // An explicit count still applies under maxCrashes.
    const counted = createFailpointRegistry();
    counted.arm(normalizeFailpointSpec({ id: 'a', maxCrashes: 3, points: { 'store.before-write': { action: 'crash', count: 1 } } }), [crash('store.before-write', 1)]);
    assert.equal(counted.hit('store.before-write').trigger, null);
    assert.deepEqual(crashesInJournal([crash('store.before-write', 1), { ...crash('store.after-write', 2), spec: 'b' }, { pid: 3, point: 'x', action: 'error', spec: 'a' }], 'a').map((entry) => entry.pid), [1]);
  });

  it('the shared crash state holds a crash back while a node is down or a grace window runs, and nothing else', () => {
    const registry = createFailpointRegistry();
    registry.arm(normalizeFailpointSpec({ id: 'a', maxCrashes: 2, graceMs: 8000, points: { 'store.before-write': { action: 'crash' }, 'chain.top-up.after-send': [{ action: 'delay', ms: 5 }, { action: 'crash' }] } }));
    let asked = 0;
    const blocked = () => { asked += 1; return { blocked: true, down: ['buyer'] }; };
    const free = () => ({ blocked: false, down: [] });
    assert.equal(registry.hit('store.before-write', { others: blocked }).trigger, null);
    // A delay is not held back, and does not even ask.
    asked = 0;
    assert.equal(registry.hit('chain.top-up.after-send', { others: blocked }).trigger.action, 'delay');
    assert.equal(asked, 0);
    assert.equal(registry.hit('store.before-write', { others: free }).trigger.action, 'crash');
    // A node that was never killed has no grace: a crash on the very first hit fires, with a grace setting or not.
    const fresh = createFailpointRegistry();
    fresh.arm(normalizeFailpointSpec({ id: 'a', graceMs: [8000, 9000], points: { 'store.before-write': { action: 'crash' } } }));
    assert.equal(fresh.hit('store.before-write', { others: free }).trigger.action, 'crash');
    // A caller that passes no shared state (an older preload) is never held back.
    const old = createFailpointRegistry();
    old.arm(normalizeFailpointSpec({ id: 'a', graceMs: 8000, points: { 'store.before-write': { action: 'crash' } } }));
    assert.equal(old.hit('store.before-write').trigger.action, 'crash');
    // The state is asked only when a crash would otherwise fire: not on a hit its nth or its chance rules out.
    const lazy = createFailpointRegistry();
    lazy.arm(normalizeFailpointSpec({ id: 'a', points: { 'store.before-write': { action: 'crash', nth: 3 }, 'store.after-write': { action: 'crash', p: 0 } } }));
    asked = 0;
    for (let i = 0; i < 2; i += 1) { lazy.hit('store.before-write', { others: blocked }); lazy.hit('store.after-write', { others: blocked }); }
    assert.equal(asked, 0);
    assert.equal(lazy.hit('store.before-write', { others: blocked }).trigger, null);
    assert.equal(asked, 1);
    // A held-back crash is not used up: the nth hit has passed, but a `p` rule fires on a later hit.
    const later = createFailpointRegistry();
    later.arm(normalizeFailpointSpec({ id: 'a', points: { 'store.before-write': { action: 'crash', p: 1 } } }));
    assert.deepEqual([later.hit('store.before-write', { others: blocked }).trigger, later.hit('store.before-write', { others: free }).trigger?.action], [null, 'crash']);
  });

  it('ignoreOthers and whenDown take a crash out of the one-node-down rule', () => {
    const blocked = () => ({ blocked: true, down: ['buyer'] });
    const graceOnly = () => ({ blocked: true, down: [] });
    const free = () => ({ blocked: false, down: [] });
    const ignoring = createFailpointRegistry();
    ignoring.arm(normalizeFailpointSpec({ id: 'a', ignoreOthers: true, points: { 'store.before-write': { action: 'crash' } } }));
    assert.equal(ignoring.hit('store.before-write', { others: blocked }).trigger.action, 'crash');
    // whenDown: only while that very node is down, whatever else the state says.
    const follower = () => { const registry = createFailpointRegistry(); registry.arm(normalizeFailpointSpec({ id: 'a', maxCrashes: 1, points: { 'store.before-write': { action: 'crash', whenDown: 'buyer', count: 1 }, 'store.after-write': { action: 'crash', whenDown: 'buyer', count: 1 } } })); return registry; };
    assert.equal(follower().hit('store.before-write', { others: free }).trigger, null);
    assert.equal(follower().hit('store.before-write', { others: graceOnly }).trigger, null);
    assert.equal(follower().hit('store.before-write', { others: () => ({ blocked: true, down: ['seller:other'] }) }).trigger, null);
    const both = follower();
    assert.equal(both.hit('store.after-write', { others: free }).trigger, null);
    assert.equal(both.hit('store.after-write', { others: blocked }).trigger.action, 'crash');
    // Once per arming: the restarted follower (its crash is in the journal) does not die again while the other is still down.
    const again = createFailpointRegistry();
    again.arm(normalizeFailpointSpec({ id: 'a', maxCrashes: 1, points: { 'store.before-write': { action: 'crash', whenDown: 'buyer', count: 1 } } }), [{ pid: 1, point: 'store.after-write', hit: 2, action: 'crash', spec: 'a' }]);
    assert.equal(again.hit('store.before-write', { others: blocked }).trigger, null);
  });

  it('a p crash rule has no cap of its own: it can kill every life of the node, another draw each', () => {
    const points = { 'store.before-write': { action: 'crash', p: 1 } };
    const crash = (pid) => ({ pid, point: 'store.before-write', hit: 1, action: 'crash', spec: 'a' });
    for (const journal of [[], [crash(1)], [crash(1), crash(2), crash(3)]]) {
      const registry = createFailpointRegistry();
      registry.arm(normalizeFailpointSpec({ seed: 1, id: 'a', points }), journal);
      assert.equal(registry.hit('store.before-write').trigger.action, 'crash', `${journal.length} earlier crashes`);
    }
    // An explicit count still caps it.
    const counted = createFailpointRegistry();
    counted.arm(normalizeFailpointSpec({ id: 'a', points: { 'store.before-write': { action: 'crash', p: 1, count: 1 } } }), [crash(1)]);
    assert.equal(counted.hit('store.before-write').trigger, null);
  });

  it('a p rule draws another stream in each life of the node, per rule', () => {
    const pattern = (journal, index = 1) => {
      const registry = createFailpointRegistry();
      registry.arm(normalizeFailpointSpec({ seed: 5, id: 'a', maxCrashes: 99, points: { 'chain.top-up.after-send': [{ action: 'error', p: 0.3 }, { action: 'crash', p: 0.3 }] } }), journal);
      // Blocked: the crash rule draws but is held back by the shared state, so the pattern of the error rule is visible on every hit.
      return Array.from({ length: 200 }, () => (registry.hit('chain.top-up.after-send', { others: () => ({ blocked: index === 1, down: [] }) }).trigger?.action ?? '-')[0]).join('');
    };
    const crash = (pid) => ({ pid, point: 'store.before-write', hit: 9, action: 'crash', spec: 'a' });
    assert.equal(pattern([]), pattern([]));
    // After one crash, and after two, the draws differ; a crash of another arming changes nothing.
    assert.notEqual(pattern([]), pattern([crash(1)]));
    assert.notEqual(pattern([crash(1)]), pattern([crash(1), crash(2)]));
    assert.equal(pattern([]), pattern([{ ...crash(1), spec: 'earlier' }]));
    // The two rules of one point draw from different streams: unblocked, the crash rule fires where the error rule did not.
    const both = pattern([], 2);
    assert.ok(both.includes('e') && both.includes('c'), both);
  });

  it('a keyed rule decides by the key: the same seed and key give the same decision in any order, once per key', () => {
    const keys = Array.from({ length: 400 }, (_, index) => `0xchannel:${1000 + index * 37}`);
    const fired = (order, { seed = 9, point = 'seller.spending-auth.after-verify', group, journal = [] } = {}) => {
      const registry = createFailpointRegistry();
      registry.arm(normalizeFailpointSpec({ seed, id: 'k', points: { [point]: { action: 'error', p: 0.1, keyed: true, ...(group ? { group } : {}) } } }), journal);
      return order.filter((key) => registry.hit(point, { sync: true, key }).trigger).sort();
    };
    const picked = fired(keys);
    assert.ok(picked.length >= 20 && picked.length <= 65, `${picked.length} of 400 keys at p 0.1`);
    // Any order, interleaved with other hits, in another process: the same keys.
    assert.deepEqual(fired([...keys].reverse()), picked);
    assert.deepEqual(fired(keys.filter((_, index) => index % 2).concat(keys.filter((_, index) => index % 2 === 0))), picked);
    assert.deepEqual(picked, keys.filter((key) => keyedDecision(9, 'seller.spending-auth.after-verify', key, 0.1)).sort());
    // Another seed, or another point, picks other keys; two points with one group pick the same.
    assert.notDeepEqual(fired(keys, { seed: 10 }), picked);
    assert.notDeepEqual(fired(keys, { point: 'buyer.spending-auth.after-send' }), picked);
    assert.deepEqual(fired(keys, { point: 'buyer.spending-auth.after-send', group: 'spending-auth' }), fired(keys, { group: 'spending-auth' }));
    // Once per key: a key seen again does not trigger again, in this life or (through the journal) the next.
    const registry = createFailpointRegistry();
    registry.arm(normalizeFailpointSpec({ seed: 9, id: 'k', points: { 'seller.spending-auth.after-verify': { action: 'error', p: 1, keyed: true } } }));
    const hit = (key) => registry.hit('seller.spending-auth.after-verify', { sync: true, ...(key === undefined ? {} : { key }) }).trigger;
    assert.deepEqual([hit('a'), hit('a'), hit('b'), hit('a')], [{ action: 'error', key: 'a' }, null, { action: 'error', key: 'b' }, null]);
    assert.deepEqual(fired([picked[0], picked[1]], { journal: [{ pid: 1, point: 'seller.spending-auth.after-verify', hit: 4, action: 'error', key: picked[0], spec: 'k' }, { pid: 1, point: 'seller.spending-auth.after-verify', hit: 5, action: 'error', key: picked[1], spec: 'other' }] }), [picked[1]]);
    // A hit without a key never triggers a keyed rule, whatever its p; an unkeyed rule ignores the key.
    assert.deepEqual([hit(undefined), hit(undefined)], [null, null]);
    const plain = createFailpointRegistry();
    plain.arm(normalizeFailpointSpec({ id: 'k', points: { 'store.before-write': { action: 'error', nth: 2 } } }));
    assert.deepEqual([plain.hit('store.before-write', { key: 'a' }).trigger, plain.hit('store.before-write', { key: 'a' }).trigger], [null, { action: 'error' }]);
  });

  it('a keyed crash carries its key and its delay to the kill, is held back by the shared state, and can then fire on another key', () => {
    const registry = createFailpointRegistry();
    registry.arm(normalizeFailpointSpec({ seed: 1, id: 'k', maxCrashes: 2, points: { 'buyer.spending-auth.after-send': { action: 'crash', p: 1, keyed: true, group: 'spending-auth', killAfterMs: 100 } } }));
    assert.equal(registry.hit('buyer.spending-auth.after-send', { key: 'a', others: () => ({ blocked: true, down: ['seller:seller'] }) }).trigger, null);
    assert.deepEqual(registry.hit('buyer.spending-auth.after-send', { key: 'b' }).trigger, { action: 'crash', key: 'b', killAfterMs: 100 });
    const rule = (extra) => () => normalizeFailpointSpec({ points: { 'buyer.spending-auth.after-send': { action: 'crash', ...extra } } });
    assert.throws(rule({ keyed: true }), /a keyed rule decides per key with p/);
    assert.throws(rule({ keyed: true, p: 0.1, nth: 3 }), /takes no nth/);
    assert.throws(rule({ keyed: 'yes', p: 0.1 }), /keyed must be true or false/);
    assert.throws(rule({ p: 0.1, group: 'spending-auth' }), /group names what a keyed rule hashes/);
    assert.throws(rule({ p: 0.1, keyed: true, group: 'Not A Group' }), /group/);
    assert.throws(rule({ killAfterMs: 1001 }), /killAfterMs is for a crash: 0\.\.1000/);
    assert.throws(() => normalizeFailpointSpec({ points: { 'store.before-write': { action: 'error', killAfterMs: 5 } } }), /killAfterMs is for a crash/);
    assert.deepEqual(normalizeFailpointSpec({ points: { 'store.before-write': { action: 'crash', p: 0.5, keyed: true, group: 'g', killAfterMs: 50 } } }).points['store.before-write'], { action: 'crash', p: 0.5, keyed: true, group: 'g', killAfterMs: 50 });
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

  it('a trigger counts as evidence only for the arming asked about', () => {
    const entries = [{ pid: 1, point: 'x.y', hit: 4, action: 'crash', spec: 'run-1' }, { pid: 2, point: 'x.z', hit: 1, action: 'delay', spec: 'run-2', skipped: 'sync point' }];
    // The journal of a reused testbench: an earlier arming crashed at the same point.
    assert.equal(triggeredInJournal(entries, 'x.y', 'crash', 'run-1'), true);
    assert.equal(triggeredInJournal(entries, 'x.y', 'crash', 'run-2'), false);
    assert.equal(triggeredInJournal(entries, 'x.z', 'delay', 'run-2'), false);
    assert.equal(triggeredInJournal([...entries, { pid: 3, point: 'x.y', hit: 2, action: 'crash', spec: 'run-2' }], 'x.y', 'crash', 'run-2'), true);
  });

  it('an exit is a fail point crash only when it was SIGKILL and its journal entry is not already used', () => {
    const entries = [
      { pid: 7, point: 'x.y', hit: 4, action: 'crash', at: 't1', spec: 'a' },
      { pid: 8, point: 'x.z', hit: 1, action: 'delay', at: 't2', spec: 'a' },
      { pid: 9, point: 'x.y', hit: 2, action: 'crash', at: 't3', spec: 'a', skipped: 'sync point' },
    ];
    assert.equal(failpointCrashOfExit(entries, { pid: 7, signal: 'SIGKILL' }).at, 't1');
    // The node logged the trigger but died another way (a real crash, an exit code): not the fail point's doing.
    assert.equal(failpointCrashOfExit(entries, { pid: 7, signal: 'SIGSEGV' }), null);
    assert.equal(failpointCrashOfExit(entries, { pid: 7, signal: null }), null);
    assert.equal(failpointCrashOfExit(entries, { pid: 8, signal: 'SIGKILL' }), null);
    assert.equal(failpointCrashOfExit(entries, { pid: 9, signal: 'SIGKILL' }), null);
    // The pid comes round again: the entry an earlier record stands for does not explain the new process's death.
    const records = [{ who: 'seller:seller', pid: 7, point: 'x.y', hit: 4, at: 't1' }];
    assert.equal(failpointCrashOfExit(entries, { pid: 7, signal: 'SIGKILL' }, records), null);
    // Unless that new process was killed at a fail point too.
    const again = [...entries, { pid: 7, point: 'x.q', hit: 1, action: 'crash', at: 't9', spec: 'b' }];
    assert.deepEqual([failpointCrashOfExit(again, { pid: 7, signal: 'SIGKILL' }, records).at, failpointCrashOfExit(again, { pid: 7, signal: 'SIGKILL' }, records).spec], ['t9', 'b']);
  });

  it('the supervisor\'s crash records are filtered by arming and node, oldest first', () => {
    const records = [
      { who: 'buyer', spec: 'run-1', at: '2026-01-01T00:00:01.000Z' },
      { who: 'seller:seller', spec: 'run-2s', at: '2026-01-01T00:00:09.000Z' },
      { who: 'buyer', spec: 'run-2b', at: '2026-01-01T00:00:05.000Z' },
      { who: 'seller:seller', spec: 'run-2s', at: '2026-01-01T00:00:03.000Z' },
    ];
    assert.deepEqual(crashesOfArming(records, { specIds: ['run-2s', 'run-2b'] }).map((record) => record.at.slice(17, 19)), ['03', '05', '09']);
    assert.deepEqual(crashesOfArming(records, { specIds: ['run-2s', 'run-2b'], who: 'buyer' }).map((record) => record.spec), ['run-2b']);
    assert.deepEqual(crashesOfArming(records, { who: ['buyer', 'seller:seller'] }).length, 4);
    assert.deepEqual(crashesOfArming(records, { specIds: ['run-3'] }), []);
    assert.deepEqual(crashesOfArming(undefined, { specIds: ['run-3'] }), []);
  });

  it('the time a killed node stays down is drawn from the armed spec, per node and crash number', () => {
    const spec = { id: 'a', seed: 77, restartDelayMs: [1000, 9000], points: {} };
    const delay = (overrides = {}) => restartDelayFor(spec, { who: 'seller:seller', crashNumber: 1, specId: 'a', fallbackMs: 1000, ...overrides });
    assert.ok(Number.isInteger(delay()) && delay() >= 1000 && delay() <= 9000);
    assert.equal(delay(), delay());
    const drawn = new Set([delay(), delay({ crashNumber: 2 }), delay({ crashNumber: 3 }), delay({ who: 'buyer' }), restartDelayFor({ ...spec, seed: 78 }, { who: 'seller:seller', crashNumber: 1, fallbackMs: 1000 })]);
    assert.ok(drawn.size >= 4, [...drawn].join(','));
    assert.equal(restartDelayFor({ ...spec, restartDelayMs: [2500, 2500] }, { who: 'buyer', crashNumber: 1, fallbackMs: 1000 }), 2500);
    // No range, no spec, or a spec armed after the one that killed: the fixed delay.
    assert.equal(restartDelayFor({ id: 'a', seed: 1, points: {} }, { who: 'buyer', crashNumber: 1, fallbackMs: 1000 }), 1000);
    assert.equal(restartDelayFor(null, { who: 'buyer', crashNumber: 1, fallbackMs: 1000 }), 1000);
    assert.equal(delay({ specId: 'earlier' }), 1000);
  });

  it('the grace window after a restart is the spec\'s, or drawn from its range per node and crash number', () => {
    const spec = { id: 'a', seed: 77, graceMs: [5000, 20_000], points: {} };
    const grace = (overrides = {}) => graceFor(spec, { who: 'seller:seller', crashNumber: 1, specId: 'a', ...overrides });
    assert.ok(Number.isInteger(grace()) && grace() >= 5000 && grace() <= 20_000);
    assert.equal(grace(), grace());
    const drawn = new Set([grace(), grace({ crashNumber: 2 }), grace({ crashNumber: 3 }), grace({ who: 'buyer' }), graceFor({ ...spec, seed: 78 }, { who: 'seller:seller', crashNumber: 1 })]);
    assert.ok(drawn.size >= 4, [...drawn].join(','));
    // Not the same draw as the time down of that crash.
    assert.notEqual(grace() - 5000, restartDelayFor({ ...spec, restartDelayMs: [5000, 20_000] }, { who: 'seller:seller', crashNumber: 1, specId: 'a', fallbackMs: 1 }) - 5000);
    assert.equal(graceFor({ ...spec, graceMs: 7000 }, { who: 'buyer', crashNumber: 4 }), 7000);
    // No grace setting, no spec, or a spec armed after the one that killed: none.
    assert.equal(graceFor({ id: 'a', seed: 1, points: {} }, { who: 'buyer', crashNumber: 1 }), 0);
    assert.equal(graceFor(null, { who: 'buyer', crashNumber: 1 }), 0);
    assert.equal(grace({ specId: 'earlier' }), 0);
  });

  it('the shared crash state: a killed node is down until it is back, then the grace window runs, for every node', () => {
    const t0 = Date.parse('2026-01-01T00:01:00.000Z');
    // Nothing killed yet, or no state file at all: nothing is held back.
    assert.deepEqual(crashBlocked(emptyCrashState(), t0), { down: [], blocked: false });
    assert.deepEqual(crashBlocked(null, t0), { down: [], blocked: false });
    assert.deepEqual(crashBlocked({ down: 'garbage', graceUntil: 'soon' }, t0), { down: [], blocked: false });
    // The seller dies: every node is blocked, however long the restart takes.
    const killed = crashStateAfterKill(emptyCrashState(), 'seller:seller', '2026-01-01T00:01:00.000Z');
    assert.deepEqual(killed, { down: { 'seller:seller': '2026-01-01T00:01:00.000Z' }, graceUntil: null });
    assert.deepEqual(crashBlocked(killed, t0 + 60_000), { down: ['seller:seller'], blocked: true });
    // Back after 9 s with a 7 s grace: blocked until 16 s, free from then on.
    const back = crashStateAfterRestart(killed, 'seller:seller', t0 + 9000, 7000);
    assert.deepEqual(back, { down: {}, graceUntil: '2026-01-01T00:01:16.000Z' });
    assert.equal(crashBlocked(back, t0 + 15_999).blocked, true);
    assert.deepEqual(crashBlocked(back, t0 + 16_000), { down: [], blocked: false });
    // Two nodes down (a race, or on purpose): blocked until both are back; a shorter grace does not cut a longer one.
    const two = crashStateAfterKill(crashStateAfterKill(back, 'buyer', 'b'), 'seller:seller', 's');
    assert.deepEqual(crashBlocked(two, t0 + 99_000).down, ['buyer', 'seller:seller']);
    const one = crashStateAfterRestart(two, 'buyer', t0 + 20_000, 30_000);
    assert.deepEqual(crashBlocked(one, t0 + 99_000), { down: ['seller:seller'], blocked: true });
    const none = crashStateAfterRestart(one, 'seller:seller', t0 + 25_000, 1000);
    assert.deepEqual(none, { down: {}, graceUntil: '2026-01-01T00:01:50.000Z' });
    // A restart without a grace leaves no window, and the functions never change their argument.
    assert.deepEqual(crashStateAfterRestart(killed, 'seller:seller', t0 + 9000), emptyCrashState());
    assert.deepEqual(killed.down, { 'seller:seller': '2026-01-01T00:01:00.000Z' });
    assert.equal(failpointSharedStatePath('/tb/failpoints/seller-a.json'), '/tb/failpoints/crash-state.json');
    assert.equal(failpointSharedStatePath('/tb/failpoints/buyer.json'), '/tb/failpoints/crash-state.json');
  });

  it('down windows overlap when each node died before the other was back', () => {
    const crash = (at, restartedAt) => ({ at: `2026-01-01T00:00:${at}.000Z`, ...(restartedAt ? { restartedAt: `2026-01-01T00:00:${restartedAt}.000Z` } : {}) });
    assert.equal(downWindowsOverlap(crash('10', '40'), crash('12', '20')), true);
    assert.equal(downWindowsOverlap(crash('12', '20'), crash('10', '40')), true);
    assert.equal(downWindowsOverlap(crash('10', '20'), crash('20', '30')), false);
    assert.equal(downWindowsOverlap(crash('10', '20'), crash('25', '30')), false);
    // A node that never came back is down for good.
    assert.equal(downWindowsOverlap(crash('10'), crash('50', '55')), true);
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

  it('the all-points spec arms every load-phase point of the node, each expected to crash equally often', () => {
    for (const node of ['seller', 'buyer']) {
      const { points } = allPointsSpec({ node, crashesPerPoint: 0.25, delay: { p: 0.1, ms: [200, 900] } });
      const expected = Object.entries(POINT_CATALOG).filter(([, entry]) => entry.phase === 'load' && entry.nodes.includes(node));
      assert.deepEqual(Object.keys(points), expected.map(([point]) => point));
      assert.ok(expected.length >= 7, `${node} reaches ${expected.length} load-phase points`);
      for (const [point, entry] of expected) {
        const rules = [points[point]].flat();
        const crash = rules.at(-1);
        assert.deepEqual(Object.keys(crash), ['action', 'p']);
        assert.equal(crash.action, 'crash');
        assert.equal(crash.p, Math.min(1, 0.25 / entry.hits[node]), point);
        // Expected crashes at this point over the measured hits: the same everywhere.
        assert.ok(Math.abs(crash.p * entry.hits[node] - 0.25) < 1e-9, point);
        // A sync point cannot wait: no delay rule there. Every other point delays first.
        assert.deepEqual(rules.slice(0, -1), entry.sync ? [] : [{ action: 'delay', ms: [200, 900], p: 0.1 }], point);
      }
      // The spec is one the registry accepts.
      assert.doesNotThrow(() => normalizeFailpointSpec({ points }));
    }
    // No close or exit point is among them.
    assert.equal(Object.keys(allPointsSpec({ node: 'seller', crashesPerPoint: 1 }).points).some((point) => /settle|close|withdraw/.test(point)), false);
    // The probability is capped at 1, and without `delay` there are only crash rules.
    const plain = allPointsSpec({ node: 'seller', crashesPerPoint: 5 }).points;
    assert.deepEqual(plain['chain.reserve.before-send'], { action: 'crash', p: 1 });
    assert.deepEqual(plain['chain.top-up.before-send'], { action: 'crash', p: 5 / 8 });
    // A longer load reaches every point more often: the chance per hit shrinks with it, and a rare point's is capped.
    const long = allPointsSpec({ node: 'seller', crashesPerPoint: 1.5, hitsScale: 3, maxP: 0.25 }).points;
    assert.deepEqual(long['chain.reserve.before-send'], { action: 'crash', p: 0.25 });
    assert.deepEqual(long['chain.top-up.before-send'], { action: 'crash', p: 1.5 / 24 });
    assert.deepEqual(long['store.before-write'], { action: 'crash', p: 1.5 / 825 });
    assert.throws(() => allPointsSpec({ node: 'seller', crashesPerPoint: 1, hitsScale: 0 }), /hitsScale > 0/);
    assert.throws(() => allPointsSpec({ node: 'seller', crashesPerPoint: 1, maxP: 2 }), /maxP/);
    assert.throws(() => allPointsSpec({ node: 'seller', crashesPerPoint: 0 }), /crashesPerPoint > 0/);
    assert.throws(() => allPointsSpec({ node: 'anvil', crashesPerPoint: 1 }), /No load-phase fail point is reached by anvil/);
    assert.deepEqual(pointsOfNode('buyer', { phase: 'exit' }).map((entry) => entry.point).slice(0, 2), ['chain.request-close.before-send', 'chain.request-close.after-send']);
  });

  it('a crashes-and-delays plan is drawn within its ranges, per node, without a crash cap, and replays for a seed', () => {
    const seen = { seller: new Set() };
    for (let seed = 0; seed < 300; seed += 1) {
      const plan = drawCrashesAndDelaysPlan(createPrng(seed), { nodes: ['seller', 'buyer'] });
      assert.deepEqual(Object.keys(plan), ['seller', 'buyer']);
      for (const [node, entry] of Object.entries(plan)) {
        assert.deepEqual(Object.keys(entry), ['expectedCrashes', 'crashesPerPoint', 'graceMs', 'restartDelayMs', 'delay']);
        assert.ok(entry.expectedCrashes >= 6 && entry.expectedCrashes <= 9, `expectedCrashes ${entry.expectedCrashes}`);
        assert.ok(Math.abs(entry.crashesPerPoint * pointsOfNode(node).length - entry.expectedCrashes) < 1e-9);
        const [graceMin, graceMax] = entry.graceMs;
        assert.ok(Number.isInteger(graceMin) && graceMin >= 5000 && graceMin <= 8000 && graceMax >= 10_000 && graceMax <= 20_000, `graceMs ${entry.graceMs}`);
        const [min, max] = entry.restartDelayMs;
        assert.ok(min >= 2000 && min <= 4000 && max >= 6000 && max <= 10_000, `restartDelayMs ${entry.restartDelayMs}`);
        assert.ok(entry.delay.p >= 0.05 && entry.delay.p <= 0.3, `delay p ${entry.delay.p}`);
        const [low, high] = entry.delay.msRange;
        assert.ok(low >= 200 && low <= high && high <= 3000, `delay ms ${entry.delay.msRange}`);
        // The plan's spec passes the registry's checks, carries the shared settings and no cap.
        const spec = normalizeFailpointSpec(crashesAndDelaysSpec(node, entry, { requests: 480 }));
        assert.deepEqual([spec.maxCrashes, spec.graceMs, spec.restartDelayMs, spec.ignoreOthers], [undefined, entry.graceMs, entry.restartDelayMs, undefined]);
        assert.deepEqual(Object.keys(spec.points), pointsOfNode(node).map((point) => point.point));
        for (const { point, hits } of pointsOfNode(node)) {
          const crash = [spec.points[point]].flat().at(-1);
          assert.deepEqual(Object.keys(crash), ['action', 'p'], `${point}: no count, no nth`);
          assert.equal(crash.p, Math.min(MAX_RARE_POINT_P, entry.crashesPerPoint / (hits * (480 / CATALOG_LOAD_REQUESTS))), point);
        }
      }
      seen.seller.add(JSON.stringify(plan.seller));
      assert.deepEqual(drawCrashesAndDelaysPlan(createPrng(seed), { nodes: ['seller', 'buyer'] }), plan);
      // The seller's plan is the same whether or not the buyer is armed too.
      assert.deepEqual(drawCrashesAndDelaysPlan(createPrng(seed), { nodes: ['seller'] }), { seller: plan.seller });
    }
    assert.ok(seen.seller.size > 290);
    assert.throws(() => drawCrashesAndDelaysPlan(createPrng(1), { nodes: ['anvil'] }), /No load-phase fail point/);
  });

  it('crashes and delays in the registry: no cap, never while a node is down or in the grace window, one node at a time', () => {
    // Seller and buyer under one shared state, on a clock: each life replays the catalog's hits of a 480-request load
    // spread over 120 s of traffic; a killed node is down for its drawn time, then the drawn grace runs for both.
    const plan = drawCrashesAndDelaysPlan(createPrng(11), { nodes: ['seller', 'buyer'] });
    const specs = Object.fromEntries(['seller', 'buyer'].map((node) => [node, normalizeFailpointSpec({ seed: 11, id: node, ...crashesAndDelaysSpec(node, { ...plan[node], crashesPerPoint: 2 }, { requests: 480 }) })]));
    const schedule = ['seller', 'buyer'].flatMap((node) => pointsOfNode(node).flatMap(({ point, sync, hits }) => Array.from({ length: hits * 3 }, (_, index) => ({ node, point, sync, at: ((index + 0.5) / (hits * 3)) * 120_000 })))).sort((a, b) => a.at - b.at);
    const journals = { seller: [], buyer: [] };
    const registries = {};
    const arm = (node) => { registries[node] = createFailpointRegistry(); registries[node].arm(specs[node], journals[node]); };
    arm('seller');
    arm('buyer');
    let state = emptyCrashState();
    const downUntil = {};
    const kills = [];
    for (const { node, point, sync, at } of schedule) {
      for (const [other, until] of Object.entries(downUntil)) {
        if (at < until) continue;
        const crashNumber = journals[other].length;
        state = crashStateAfterRestart(state, other, until, graceFor(specs[other], { who: other, crashNumber }));
        delete downUntil[other];
        arm(other);
      }
      // A node that is down reaches nothing.
      if (downUntil[node] !== undefined) continue;
      const before = crashBlocked(state, at);
      const { hit, trigger } = registries[node].hit(point, { sync, others: () => crashBlocked(state, at) });
      if (trigger?.action !== 'crash') continue;
      assert.equal(before.blocked, false, `${node} killed at ${at} while ${JSON.stringify(state)}`);
      journals[node].push({ pid: kills.length, point, hit, action: 'crash', spec: node });
      state = crashStateAfterKill(state, node, new Date(at).toISOString());
      downUntil[node] = at + restartDelayFor(specs[node], { who: node, crashNumber: journals[node].length, fallbackMs: 1000 });
      kills.push({ node, point, at, backAt: downUntil[node], graceMs: graceFor(specs[node], { who: node, crashNumber: journals[node].length }) });
    }
    // Several crashes on both nodes (no cap of 2 or 3), and the same point may kill more than once.
    assert.ok(kills.length >= 5, `${kills.length} crashes`);
    assert.ok(kills.some((kill) => kill.node === 'seller') && kills.some((kill) => kill.node === 'buyer'));
    // Each kill came after the previous node was back and its grace over: one node down at a time.
    for (const [index, kill] of kills.entries()) {
      if (index === 0) continue;
      const previous = kills[index - 1];
      assert.ok(kill.at >= previous.backAt + previous.graceMs, `kill ${index} at ${kill.at}, previous back at ${previous.backAt} with ${previous.graceMs} ms grace`);
    }
    // The first kill needed no grace to pass: a node that was never killed can die on its first hits.
    assert.ok(kills[0].at < 20_000, `first kill at ${kills[0].at}`);
  });

  it('the close phase arms every settle, close and store point of the seller with a small drawn chance', () => {
    const seen = new Set();
    for (let seed = 0; seed < 100; seed += 1) {
      const close = drawClosePhasePlan(createPrng(seed));
      assert.ok(close.p >= 0.04 && close.p <= 0.1, `p ${close.p}`);
      seen.add(close.p);
      assert.deepEqual(drawClosePhasePlan(createPrng(seed)), close);
    }
    assert.equal(seen.size, 7);
    const sellerPlan = drawCrashesAndDelaysPlan(createPrng(3)).seller;
    const spec = normalizeFailpointSpec(closePhaseSpec({ p: 0.06 }, sellerPlan));
    assert.deepEqual(Object.keys(spec.points), closeCrashCandidates().map((entry) => entry.point));
    assert.deepEqual([spec.graceMs, spec.restartDelayMs, spec.maxCrashes], [sellerPlan.graceMs, sellerPlan.restartDelayMs, undefined]);
    const delay = { action: 'delay', ms: sellerPlan.delay.msRange, p: sellerPlan.delay.p };
    assert.deepEqual(spec.points['chain.settle.after-send'], [delay, { action: 'crash', p: 0.06 }]);
    assert.deepEqual(spec.points['chain.close.after-receipt'], [delay, { action: 'crash', p: 0.06 }]);
    // A store write cannot wait.
    assert.deepEqual(spec.points['store.after-write'], { action: 'crash', p: 0.06 });
  });

  it('a correlated crash arms both nodes with one seed and a keyed rule on the same payment step', () => {
    const plan = drawCorrelatedCrash(5);
    assert.deepEqual(plan, { seed: derive(5, 'crashes-correlated'), group: 'spending-auth', p: 0.06, buyerPoint: 'buyer.spending-auth.after-send', sellerPoint: 'seller.spending-auth.after-verify' });
    assert.deepEqual(drawCorrelatedCrash(5), plan);
    assert.notEqual(drawCorrelatedCrash(6).seed, plan.seed);
    // Both points carry the SpendingAuth's key in the payment code.
    assert.ok(POINT_CATALOG[plan.buyerPoint].keyed && POINT_CATALOG[plan.sellerPoint].keyed);
    const specs = correlatedCrashSpecs(plan, { seller: 'seller:seller', buyer: 'buyer' });
    const buyer = normalizeFailpointSpec(specs.buyer);
    const seller = normalizeFailpointSpec(specs.seller);
    assert.deepEqual([buyer.seed, seller.seed], [plan.seed, plan.seed]);
    assert.deepEqual([buyer.maxCrashes, buyer.ignoreOthers, seller.maxCrashes, seller.ignoreOthers], [1, true, 1, true]);
    // The buyer dies within a moment of the seller, and each stays down for seconds: the windows overlap.
    assert.ok(buyer.restartDelayMs[0] >= 3000 && seller.restartDelayMs[0] >= 6000);
    assert.deepEqual(buyer.points, { 'buyer.spending-auth.after-send': { action: 'crash', p: 0.06, keyed: true, group: 'spending-auth', killWhenDown: 'seller:seller' } });
    assert.deepEqual(seller.points, { 'seller.spending-auth.after-verify': { action: 'crash', p: 0.06, keyed: true, group: 'spending-auth' } });

    // In two registries, with the SpendingAuths arriving in different orders: both pick the same key, and only such keys.
    const keys = Array.from({ length: 300 }, (_, index) => `0xchannel:${5000 + index * 211}`);
    const dies = (spec, point, order) => {
      const registry = createFailpointRegistry();
      registry.arm({ ...spec, id: 'c' });
      for (const key of order) { const { trigger } = registry.hit(point, { sync: true, key, others: () => crashBlocked(emptyCrashState(), 0) }); if (trigger) return trigger; }
      return null;
    };
    const buyerDies = dies(buyer, plan.buyerPoint, keys);
    const sellerDies = dies(seller, plan.sellerPoint, keys);
    assert.deepEqual(buyerDies, { action: 'crash', key: buyerDies.key, killWhenDown: 'seller:seller' });
    assert.deepEqual(sellerDies, { action: 'crash', key: buyerDies.key });
    assert.equal(buyerDies.key, keys.find((key) => keyedDecision(plan.seed, 'spending-auth', key, 0.06)));
    // A seller that sees the SpendingAuths in another order still dies at one both pick, never at one the buyer would pass.
    assert.ok(keyedDecision(plan.seed, 'spending-auth', dies(seller, plan.sellerPoint, [...keys].reverse()).key, 0.06));
    // One crash per node: the restarted seller does not die again at the next picked key.
    const restarted = createFailpointRegistry();
    restarted.arm({ ...seller, id: 'c' }, [{ pid: 1, point: plan.sellerPoint, hit: 9, action: 'crash', key: sellerDies.key, spec: 'c' }]);
    assert.equal(keys.every((key) => restarted.hit(plan.sellerPoint, { sync: true, key }).trigger === null), true);
    const rule = (extra) => () => normalizeFailpointSpec({ points: { 'store.before-write': { action: 'crash', ...extra } } });
    assert.throws(rule({ killWhenDown: 'anvil' }), /killWhenDown names the node/);
    assert.throws(rule({ killWhenDown: 'buyer', killAfterMs: 5 }), /goes with neither killAfterMs nor whenDown/);
    assert.throws(() => normalizeFailpointSpec({ points: { 'store.before-write': { action: 'error', killWhenDown: 'buyer' } } }), /killWhenDown/);
  });

  it('the catalog marks as keyed exactly the points whose call site passes a key, and the plan can decide by it', () => {
    const text = ['packages/buyer-core/src', 'packages/node/src'].flatMap((dir) => codeFiles(join(repo, dir))).filter((file) => !/\.test\.ts$/.test(file) && !/failpoints\.ts$/.test(file)).map((file) => readFileSync(file, 'utf8')).join('\n');
    const calls = [...text.matchAll(/hitFailpoint(?:Sync)?\((['`])([^'`]+)\1(,\s*`[^`]+`)?\)/g)].map((match) => ({ name: match[2], keyed: Boolean(match[3]), key: match[3] ?? '' }));
    assert.ok(calls.length >= 14, `found ${calls.length} call sites`);
    for (const call of calls) {
      const points = call.name.includes('${') ? Object.keys(POINT_CATALOG).filter((point) => new RegExp(`^${call.name.replace(/[.]/g, '\\.').replace(/\$\{[^}]+\}/g, '[a-z-]+')}$`).test(point)) : [call.name];
      assert.ok(points.length >= 1, call.name);
      for (const point of points) assert.equal(Boolean(POINT_CATALOG[point].keyed), call.keyed, `${point} keyed`);
      // A key is a template of two values the call site already holds: no call, no await, nothing else built.
      if (call.keyed) assert.match(call.key, /^,\s*`\$\{[\w.]+\}:\$\{[\w.]+\}`$/, call.name);
    }
    assert.equal(Object.entries(POINT_CATALOG).filter(([, entry]) => entry.keyed).every(([point]) => !/^(chain|store)\./.test(point)), true);
    // Offered in the crashes-and-delays plan: with `keyed`, the keyed points decide per payment step, the others per hit.
    const sellerPlan = drawCrashesAndDelaysPlan(createPrng(3)).seller;
    const byHit = crashesAndDelaysSpec('seller', sellerPlan, { requests: 480 }).points;
    const byStep = normalizeFailpointSpec(crashesAndDelaysSpec('seller', sellerPlan, { requests: 480, keyed: true })).points;
    for (const { point, keyed } of pointsOfNode('seller')) {
      const [hitRule, stepRule] = [[byHit[point]].flat().at(-1), [byStep[point]].flat().at(-1)];
      assert.deepEqual(stepRule, keyed ? { ...hitRule, keyed: true } : hitRule, point);
    }
    assert.equal(Object.values(byHit).flat().some((rule) => rule.keyed), false);
    assert.deepEqual(crashesAndDelaysPlan(4, { nodes: ['seller'], keyed: true }).specs['seller:seller'].points['seller.spending-auth.after-verify'].keyed, true);
  });

  it('the run\'s lines and evidence say what was armed and what fired', () => {
    const { plan } = crashesAndDelaysPlan(2, { nodes: ['seller', 'buyer'] });
    const line = crashesPlanLine(plan);
    assert.match(line, /^seller: 14 points, about [\d.]+ crashes drawn, no cap, grace \d+-\d+ ms, down \d+-\d+ ms, delays p=[\d.]+ \d+-\d+ ms; buyer: 7 points, .*; close: p=0\.\d+$/);
    const crashes = [
      { who: 'seller:seller', point: 'store.after-write', hit: 31, at: '2026-01-01T00:00:10.000Z', restartDelayMs: 2000, restartedAt: '2026-01-01T00:00:14.200Z', spec: 'a' },
      { who: 'buyer', point: 'buyer.spending-auth.after-sign', hit: 7, at: '2026-01-01T00:00:30.000Z', restartDelayMs: 1000, spec: 'b' },
    ];
    const closeCrash = { who: 'seller:seller', point: 'chain.close.after-send', hit: 1, at: '2026-01-01T00:02:00.000Z', restartedAt: '2026-01-01T00:02:09.000Z', spec: 'c', overlapped: true };
    assert.equal(crashesFiredLine(crashes, { seller: { 'chain.top-up.after-send': 2 }, buyer: { 'buyer.spending-auth.after-sign': 3 } }), '2 crashes: seller store.after-write@31 (down 4200 ms), buyer buyer.spending-auth.after-sign@7 (not restarted); 0 in the close; 0 overlapped; 5 delays');
    assert.equal(crashesFiredLine(crashes.slice(0, 1), {}, [closeCrash]), '2 crashes: seller store.after-write@31 (down 4200 ms), seller chain.close.after-send@1 (down 9000 ms, overlapped); 1 in the close; 1 overlapped; 0 delays');
    assert.equal(crashesFiredLine([], { seller: {} }), '0 crashes; 0 in the close; 0 overlapped; 0 delays');
    // The sweep reads the last plan line and cuts its JSON tail.
    const output = `[failpoint] plan: crashes and delays on ${line} ${JSON.stringify(plan)}\n[failpoint] plan: crashes and delays on ${line} -> ${crashesFiredLine(crashes.slice(0, 1), {})} ${JSON.stringify({ plan })}\n`;
    assert.ok(sweepSummary('stress-crashes-and-delays', [readRunOutput(3, 0, output)]).some((entry) => entry.endsWith('-> 1 crash: seller store.after-write@31 (down 4200 ms); 0 in the close; 0 overlapped; 0 delays]')));

    const ok = (evidence) => evidence.map((entry) => entry.ok);
    assert.deepEqual(ok(crashesEvidence({ crashes: [crashes[0]], journalCrashes: 1 })), [true, true]);
    assert.ok(crashesEvidence({ crashes: [], journalCrashes: 0 }).every((entry) => entry.name.startsWith('fault path ran: ')));
    // No crash at all fails the run; so does a crash without a restart, and a journal crash the supervisor did not record.
    assert.deepEqual(ok(crashesEvidence({ crashes: [], journalCrashes: 0 })), [false, true]);
    assert.deepEqual(ok(crashesEvidence({ crashes, journalCrashes: 2 })), [true, false]);
    assert.deepEqual(ok(crashesEvidence({ crashes: [crashes[0]], journalCrashes: 2 })), [true, false]);
    // An overlap is reported on the crash, not hidden.
    assert.equal(crashesEvidence({ crashes: [closeCrash], journalCrashes: 1 })[0].detail.crashes[0].overlapped, true);
    assert.deepEqual(failpointCoverage({ seller: ['store.after-write'] }, [crashes[0], closeCrash]), { armed: { seller: ['store.after-write'] }, crashes: [{ node: 'seller', point: 'store.after-write' }, { node: 'seller', point: 'chain.close.after-send' }] });
  });

  it('the gate of a run with crashes is sized by the crashes that fired during the load', () => {
    const shape = { concurrency: 16, requests: 480 };
    assert.equal(CRASHES_GATE_SLACK, 8);
    // No crash: only the slack. Each crash allows the requests in flight, no more.
    assert.deepEqual(crashesGate({ crashes: 0, ...shape }), { minOk: 1 - 8 / 480, restart: true, crashes: 0 });
    assert.deepEqual(crashesGate({ crashes: 4, ...shape }), { minOk: 1 - (4 * 16 + 8) / 480, restart: true, crashes: 4 });
    assert.equal(crashesGate({ crashes: 2, concurrency: 16, requests: 160, slack: 0 }).minOk, 0.8);
    // Never below zero, however many crashes.
    assert.equal(crashesGate({ crashes: 40, ...shape }).minOk, 0);
    assert.throws(() => crashesGate({ crashes: 1.5, ...shape }), /whole numbers/);
    assert.throws(() => crashesGate({ crashes: 1, concurrency: 16, requests: 0 }), /whole numbers/);
    const client = (failed, outside = 0) => ({ total: 480, ok: 480 - failed, clientAborted: 0, failed, failures: {}, failedOutsideRestartWindow: outside });
    // 3 crashes: 56 may fail (3 x 16 + 8), 57 may not; a failure outside a restart window fails whatever the share.
    assert.deepEqual(gateProblems(client(56), crashesGate({ crashes: 3, ...shape })), []);
    assert.deepEqual(gateProblems(client(57), crashesGate({ crashes: 3, ...shape })), ['423/480 ok, below the 88% floor']);
    assert.deepEqual(gateProblems(client(3, 1), crashesGate({ crashes: 3, ...shape })), ['1 failures outside the restart window']);
    // The same failures with one crash fewer do not pass: the floor follows what fired, it is not a fixed loose one.
    assert.equal(gateProblems(client(56), crashesGate({ crashes: 2, ...shape })).length, 1);
    // Only crashes while the load ran count.
    const run = { startedAt: Date.parse('2026-01-01T00:01:00.000Z'), loadMs: 60_000 };
    const at = (time) => ({ at: `2026-01-01T00:${time}.000Z` });
    assert.deepEqual(crashesDuringLoad([at('00:50'), at('01:00'), at('01:30'), at('02:00'), at('02:01')], run).map((crash) => crash.at.slice(14, 19)), ['01:00', '01:30', '02:00']);
    assert.equal(CRASHES_AND_DELAYS_LOAD.concurrency, 16);
  });

  it('closeWhenReachable repeats the close until the buyer reaches the seller, and reports when it never does', async () => {
    let calls = 0;
    const tb = (failures) => ({
      closeAll: async () => { calls += 1; if (calls <= failures) throw new Error(`close ${calls}: seller-offline`); return {}; },
      waitFor: async (predicate, label, { timeoutMs, intervalMs }) => {
        for (let waited = 0; waited < timeoutMs; waited += intervalMs) { const value = await predicate(); if (value) return value; }
        throw new Error(`Timed out waiting for ${label}`);
      },
    });
    assert.deepEqual(await closeWhenReachable(tb(0)), { closed: true, attempts: 1, lastError: null });
    calls = 0;
    assert.deepEqual(await closeWhenReachable(tb(2)), { closed: true, attempts: 3, lastError: 'close 2: seller-offline' });
    calls = 0;
    assert.deepEqual(await closeWhenReachable(tb(99), { timeoutMs: 15_000, intervalMs: 5000 }), { closed: false, attempts: 3, lastError: 'close 3: seller-offline' });
  });

  it('a crash record becomes the load\'s restart window', () => {
    const restart = restartFromCrash({ who: 'seller:seller', point: 'store.after-write', hit: 7, at: '2026-01-01T00:00:10.000Z', restartedAt: '2026-01-01T00:00:18.500Z' }, Date.parse('2026-01-01T00:00:00.000Z'));
    assert.deepEqual(restart, { who: 'seller', failpoint: 'store.after-write', hit: 7, crashed: true, stoppedAt: 10_000, downMs: 8500 });
  });
});

describe('fail point plans are fixed by the seed', () => {
  const planned = [];
  it('loads every scenario that arms a seeded fail point plan', async () => {
    for (const { name, file } of scenarioFiles()) {
      const scenario = validateScenarioModule(await import(pathToFileURL(file).href), name);
      if (scenario.failpointPlan) planned.push(scenario);
    }
    assert.deepEqual(planned.map((scenario) => scenario.name), ['stress-crashes-and-delays', 'stress-crashes-and-delays-both', 'stress-crashes-correlated', 'stress-failpoint-close', 'stress-failpoint-crash', 'stress-failpoint-exit']);
  });

  it('the plan and every armed spec of a scenario are identical for one seed, print after print, and differ between seeds', () => {
    for (const scenario of planned) {
      const texts = new Set();
      for (let seed = 0; seed < 40; seed += 1) {
        const text = failpointPlanText(scenario, seed);
        assert.equal(failpointPlanText(scenario, seed), text, `${scenario.name} seed ${seed}`);
        const printed = JSON.parse(text);
        assert.deepEqual([printed.scenario, printed.seed], [scenario.name, seed]);
        // Every spec carries its seed (so its `p` draws, delays, time down and grace are fixed too) and passes the registry's checks.
        const specs = [...Object.values(printed.specs), ...(printed.closeSpec ? [printed.closeSpec] : [])];
        assert.ok(specs.length >= 1);
        for (const spec of specs) {
          assert.ok(Number.isInteger(spec.seed) && spec.seed > 0, `${scenario.name}: a spec without a seed`);
          assert.deepEqual(normalizeFailpointSpec(spec), spec);
        }
        texts.add(JSON.stringify({ plan: printed.plan, specs: printed.specs }));
      }
      assert.ok(texts.size >= 3, `${scenario.name} drew ${texts.size} plans over 40 seeds`);
    }
  });

  it('a printed spec is the one a run arms: tb.faults.failpoints() adds the same seed, and what a spec then decides replays', async () => {
    const seen = [];
    const control = { setFailpoints: async (who, spec) => { seen.push([who, spec]); return { spec: { ...spec, id: '1' } }; } };
    await withTb({ control, seed: 7 }, async (tb) => {
      assert.equal(tb.seed, 7);
      const { specs, closeSpec } = crashesAndDelaysPlan(tb.seed, { nodes: ['seller', 'buyer'] });
      for (const [who, spec] of Object.entries(specs)) {
        const { seed, ...unseeded } = spec;
        await tb.faults.failpoints(who, unseeded);
        assert.deepEqual(seen.at(-1), [who, spec]);
        assert.deepEqual(armedSpec(7, who, unseeded), spec);
      }
      // The close phase draws from a seed of its own, not the load phase's.
      assert.equal(closeSpec.seed, derive(7, 'failpoints:seller:seller:close'));
      assert.notEqual(closeSpec.seed, specs['seller:seller'].seed);
    });
    // Two registries armed with one printed spec decide the same on the same hits, and the supervisor draws the same times.
    const { specs } = crashesAndDelaysPlan(7, { nodes: ['seller'] });
    const spec = { ...specs['seller:seller'], id: 'x' };
    const decisions = () => {
      const registry = createFailpointRegistry();
      registry.arm(normalizeFailpointSpec(spec));
      return Array.from({ length: 3000 }, (_, index) => { const point = ['store.before-write', 'chain.top-up.after-send', 'seller.need-auth.before-send'][index % 3]; const { trigger } = registry.hit(point, { others: () => ({ blocked: true, down: [] }) }); return trigger ? `${trigger.action}:${trigger.ms}` : ''; }).join(',');
    };
    assert.equal(decisions(), decisions());
    assert.ok(decisions().includes('delay:'));
    const times = () => [1, 2, 3].map((crashNumber) => [restartDelayFor(spec, { who: 'seller:seller', crashNumber, specId: 'x', fallbackMs: 1 }), graceFor(spec, { who: 'seller:seller', crashNumber, specId: 'x' })]);
    assert.deepEqual(times(), times());
  });

  it('pnpm testbench plan takes a scenario and a seed, and refuses a scenario without a plan', () => {
    assert.deepEqual([parseArgs(['plan', 'stress-crashes-and-delays', '--seed', '5']).scenario, parseArgs(['plan', 'stress-crashes-and-delays', '--seed', '5']).seed], ['stress-crashes-and-delays', 5]);
    assert.throws(() => parseArgs(['plan', 'stress-crashes-and-delays']), /Usage: pnpm testbench plan <scenario> --seed N/);
    assert.throws(() => parseArgs(['plan', '--seed', '5']), /Usage: pnpm testbench plan/);
    assert.throws(() => failpointPlanText({ name: 'chat-basic' }, 1), /arms no seeded fail point plan/);
    assert.throws(() => validateScenarioModule({ run() {}, failpointPlan: {} }, 'x'), /failpointPlan must be a function/);
  });

  it('an exit plan kills each of the two commands at one of its three points', () => {
    const seen = new Set();
    for (let seed = 0; seed < 200; seed += 1) {
      const plan = drawExitCrashes(createPrng(seed));
      assert.match(plan.requestClose, /^chain\.request-close\.(before-send|after-send|after-receipt)$/);
      assert.match(plan.withdraw, /^chain\.withdraw\.(before-send|after-send|after-receipt)$/);
      seen.add(plan.requestClose).add(plan.withdraw);
      assert.deepEqual(drawExitCrashes(createPrng(seed)), plan);
    }
    // All six exit points of the catalog are drawn by some seed.
    assert.deepEqual([...seen].sort(), pointsOfNode('buyer', { phase: 'exit' }).map((entry) => entry.point).sort());
  });
});

describe('fail point coverage of a sweep', () => {
  const run = (armed, crashes) => ({ armed, crashes: crashes.map(([node, point]) => ({ node, point })) });

  it('counts per node and point the seeds that crashed there, and lists the armed points that never did', () => {
    const coverage = sweepCoverage([
      run({ seller: ['store.before-write', 'chain.top-up.after-send', 'chain.close.after-send'] }, [['seller', 'store.before-write'], ['seller', 'store.before-write'], ['seller', 'chain.top-up.after-send']]),
      null,
      run({ seller: ['store.before-write', 'chain.top-up.after-send', 'chain.close.after-send'], buyer: ['store.before-write'] }, [['seller', 'store.before-write']]),
      run({ seller: ['store.before-write'], buyer: ['store.before-write'] }, []),
    ]);
    assert.equal(coverage.seeds, 3);
    assert.deepEqual(coverage.points, [
      { node: 'seller', point: 'store.before-write', armedSeeds: 3, crashedSeeds: 2, crashes: 3 },
      { node: 'seller', point: 'chain.top-up.after-send', armedSeeds: 2, crashedSeeds: 1, crashes: 1 },
      { node: 'buyer', point: 'store.before-write', armedSeeds: 2, crashedSeeds: 0, crashes: 0 },
      { node: 'seller', point: 'chain.close.after-send', armedSeeds: 2, crashedSeeds: 0, crashes: 0 },
    ]);
    // The same point name on another node is another point.
    assert.deepEqual(coverage.neverTriggered, [{ node: 'buyer', point: 'store.before-write' }, { node: 'seller', point: 'chain.close.after-send' }]);
    assert.deepEqual(coverageSummary(coverage), [
      'Fail point coverage over 3 seeds: a crash fired at 2 of 4 armed points',
      '  seller store.before-write: 2 seeds, 3 crashes',
      '  seller chain.top-up.after-send: 1 seed',
      '  never triggered (2): buyer store.before-write, seller chain.close.after-send',
    ]);
  });

  it('is absent when no run carried a fail point plan, and survives a crash at a point outside the armed list', () => {
    assert.equal(sweepCoverage([null, undefined, {}]), null);
    assert.deepEqual(coverageSummary(null), []);
    const stray = sweepCoverage([run({ seller: ['store.before-write'] }, [['seller', 'store.after-write']])]);
    assert.deepEqual(stray.neverTriggered, [{ node: 'seller', point: 'store.before-write' }]);
    assert.ok(coverageSummary(stray).includes('  seller store.after-write: 1 seed (not in the armed list)'));
    assert.deepEqual(coverageSummary(sweepCoverage([run({ seller: ['store.before-write'] }, [['seller', 'store.before-write']])])), ['Fail point coverage over 1 seed: a crash fired at 1 of 1 armed points', '  seller store.before-write: 1 seed']);
  });
});

describe('fail points in a one-shot CLI command', () => {
  it('tb.cli({ failpoints }) arms the command with a journal of its own and tells a fail point kill from a failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-failpoints-cli-'));
    try {
      const entry = join(dir, 'fake-cli.mjs');
      // Stands in for the CLI: reaches the three points of a transaction, then reports; FAKE_MODE=fail exits 1 first.
      await writeFile(entry, `
const h = globalThis[Symbol.for('${FAILPOINT_HANDLER_KEY}')];
if (process.env.FAKE_MODE === 'fail') { console.error('nope'); process.exit(1); }
if (process.env.FAKE_MODE === 'hang') setInterval(() => {}, 1000);
else {
  for (const step of ['before-send', 'after-send', 'after-receipt']) { await h?.hit('chain.withdraw.' + step); console.log(step); }
  console.log(typeof h);
}
`);
      const manifest = { dir, home: join(dir, 'home'), buyerDir: join(dir, 'buyer'), buyerConfig: join(dir, 'buyer', 'config.json'), sellers: [] };
      const events = [];
      const runner = createCliRunner({ repo: dir, manifest, entry, event: async (type, data) => events.push(data), baseEnv: { PATH: process.env.PATH }, seed: 3 });
      const spec = crashSpec({ point: 'chain.withdraw.after-send', nth: 1 });
      const killed = await runner.cli(['buyer', 'channels', 'withdraw'], { failpoints: spec });
      assert.deepEqual([killed.code, killed.signal, killed.stdout], [null, 'SIGKILL', 'before-send\n']);
      assert.deepEqual([killed.failpoint.crash.point, killed.failpoint.crash.hit, killed.failpoint.crash.pid, killed.failpoint.crash.spec], ['chain.withdraw.after-send', 1, killed.pid, killed.failpoint.specId]);
      assert.deepEqual(events[0].failpointCrash.point, 'chain.withdraw.after-send');
      // Run again unarmed: no handler at all, as in production.
      const plain = await runner.cli(['buyer', 'channels', 'withdraw']);
      assert.deepEqual([plain.code, plain.stdout.trim().split('\n').at(-1), 'failpoint' in plain], [0, 'undefined', false]);
      // Armed at a point the command passes without a trigger: it ends normally, and its journal is its own.
      const calm = await runner.cli(['x'], { failpoints: crashSpec({ point: 'chain.withdraw.after-send', nth: 2 }) });
      assert.deepEqual([calm.code, calm.failpoint.crash, calm.stdout.trim().split('\n').at(-1)], [0, null, 'object']);
      assert.ok(calm.failpoint.journal.every((line) => line.pid === calm.pid) && calm.failpoint.journal.some((line) => line.reached));
      assert.notEqual(calm.failpoint.specId, killed.failpoint.specId);
      // A command that fails on its own, and one the timeout kills (SIGKILL too), were not killed by a fail point.
      const failed = await runner.cli(['x'], { failpoints: spec, env: { FAKE_MODE: 'fail' } });
      assert.deepEqual([failed.code, failed.failpoint.crash], [1, null]);
      const hung = await runner.cli(['x'], { failpoints: spec, env: { FAKE_MODE: 'hang' }, timeoutMs: 400 });
      assert.deepEqual([hung.signal, hung.timedOut, hung.failpoint.crash], ['SIGKILL', true, null]);
      // The spec files live in a folder of their own, so the nodes' shared crash state never holds a command back.
      assert.deepEqual(readdirSync(join(dir, 'failpoints')), ['cli']);
      await assert.rejects(runner.cli(['x'], { failpoints: { points: { 'chain.nope': { action: 'crash' } } } }), /Unknown fail point chain.nope/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a kill counts as a fail point crash only with SIGKILL, no timeout, and this command\'s own trigger', () => {
    const journal = [{ pid: 5, point: 'chain.withdraw.after-send', hit: 1, action: 'crash', at: 't', spec: 'cli-1' }];
    const ended = (overrides) => cliFailpointOutcome(journal, { pid: 5, signal: 'SIGKILL', timedOut: false, ...overrides }, 'cli-1').crash;
    assert.equal(ended({}).point, 'chain.withdraw.after-send');
    assert.equal(ended({ signal: null }), null);
    assert.equal(ended({ signal: 'SIGTERM' }), null);
    assert.equal(ended({ timedOut: true }), null);
    assert.equal(ended({ pid: 6 }), null);
    assert.equal(cliFailpointOutcome(journal, { pid: 5, signal: 'SIGKILL', timedOut: false }, 'cli-2').crash, null);
    assert.equal(cliFailpointOutcome([], { pid: 5, signal: 'SIGKILL', timedOut: false }, 'cli-1').crash, null);
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

  it('an all-points spec: delays are counted rather than listed, no crash while the shared state blocks, and each life draws anew', async () => {
    await withDir(async (specPath, journalPath) => {
      const spec = { id: 's', seed: 3, maxCrashes: 2, graceMs: 400, points: { 'chain.top-up.after-send': [{ action: 'delay', ms: [5, 15] }, { action: 'crash' }], 'store.before-write': { action: 'crash' } } };
      await writeFile(specPath, JSON.stringify(spec));
      // Another node is down for the first 400 ms of each life (the script plays the supervisor and then notes it back).
      // Five delayed hits, then store writes until the state lets the process be killed.
      const script = `
        import { writeFileSync } from 'node:fs';
        const h = ${HANDLER};
        writeFileSync(process.env.STATE, JSON.stringify({ down: { buyer: new Date().toISOString() }, graceUntil: null }));
        setTimeout(() => writeFileSync(process.env.STATE, JSON.stringify({ down: {}, graceUntil: null })), 400);
        const started = Date.now();
        for (let i = 0; i < 5; i += 1) await h.hit('chain.top-up.after-send');
        console.log('delayed');
        for (;;) { h.hitSync('store.before-write'); process.stderr.write('alive ' + (Date.now() - started) + '\\n'); await new Promise((resolve) => setTimeout(resolve, 20)); }`;
      const lives = [];
      for (let life = 0; life < 2; life += 1) lives.push(await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath, STATE: failpointSharedStatePath(specPath) }));
      for (const life of lives) assert.deepEqual([life.signal, life.stdout], ['SIGKILL', 'delayed\n'], life.stderr);
      assert.match(lives[0].stderr, /\[Failpoint\] armed chain\.top-up\.after-send=delay\+crash store\.before-write=crash/);
      const entries = await journalOf(journalPath);
      // One delay line per life, the rest in the totals written before the crash.
      const delayLines = entries.filter((entry) => entry.action === 'delay');
      assert.deepEqual(delayLines.map(({ pid, hit, rule, spec: id }) => [pid, hit, rule, id]), lives.map((life) => [life.pid, 1, 0, 's']));
      assert.ok(delayLines.every((entry) => entry.ms >= 5 && entry.ms <= 15));
      assert.deepEqual(delaysInJournal(entries, 's'), { 'chain.top-up.after-send': 10 });
      const crashes = crashesInJournal(entries, 's');
      assert.deepEqual(crashes.map((entry) => [entry.pid, entry.point]), lives.map((life) => [life.pid, 'store.before-write']));
      // While the other node was down the store writes did not kill: each life outlived the 400 ms.
      for (const life of lives) {
        const survived = Number(life.stderr.match(/alive (\d+)\n(?![\s\S]*alive)/)?.[1]);
        assert.ok(survived >= 300, `last store write survived at ${survived} ms`);
        assert.equal(failpointCrashOfExit(entries, life).point, 'store.before-write');
      }

      // The cap is reached: a third life is not killed.
      const third = await runWithPreload(`const h = ${HANDLER}; await new Promise((resolve) => setTimeout(resolve, 450)); h.hitSync('store.before-write'); console.log('alive');`, { [FAILPOINTS_FILE_ENV]: specPath });
      assert.deepEqual([third.code, third.stdout], [0, 'alive\n']);
    });
  });

  it('a node is not killed while the shared state says it is itself being restarted, nor in the grace window after', async () => {
    await withDir(async (specPath, journalPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'g', seed: 1, maxCrashes: 2, graceMs: 300, points: { 'store.before-write': { action: 'crash' } } }));
      // The supervisor's state: this node (seller:a) was killed and is still being restarted. The script plays the
      // supervisor and notes it back at 600 ms, with a grace window of 300 ms.
      await writeFile(failpointSharedStatePath(specPath), JSON.stringify({ down: { 'seller:a': new Date().toISOString() }, graceUntil: null }));
      const script = `
        import { writeFileSync } from 'node:fs';
        const h = ${HANDLER};
        const started = Date.now();
        setTimeout(() => writeFileSync(process.env.STATE, JSON.stringify({ down: {}, graceUntil: new Date(Date.now() + 300).toISOString() })), 600);
        for (;;) { h.hitSync('store.before-write'); console.log(Date.now() - started); await new Promise((resolve) => setTimeout(resolve, 20)); }`;
      const result = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath, STATE: failpointSharedStatePath(specPath) });
      assert.equal(result.signal, 'SIGKILL', result.stderr);
      const survivedUntil = Number(result.stdout.trim().split('\n').at(-1));
      // Not killed while the restart was under way, nor in the 300 ms after it.
      assert.ok(survivedUntil >= 850, `last store write survived at ${survivedUntil} ms`);
      assert.equal(crashesInJournal(await journalOf(journalPath), 'g').length, 1);
    });
  });

  it('a node that was never killed has no grace: without a shared state a crash fires on the first hit', async () => {
    await withDir(async (specPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'n', seed: 1, graceMs: [5000, 9000], points: { 'store.before-write': { action: 'crash', p: 1 } } }));
      const result = await runWithPreload(`${HANDLER}.hitSync('store.before-write'); console.log('survived');`, { [FAILPOINTS_FILE_ENV]: specPath });
      assert.deepEqual([result.signal, result.stdout], ['SIGKILL', '']);
    });
  });

  it('a whenDown crash fires only once the shared state names that node down', async () => {
    await withDir(async (specPath, journalPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'w', seed: 1, maxCrashes: 1, points: { 'store.before-write': { action: 'crash', whenDown: 'buyer', count: 1 } } }));
      const script = `
        import { writeFileSync } from 'node:fs';
        const h = ${HANDLER};
        const started = Date.now();
        setTimeout(() => writeFileSync(process.env.STATE, JSON.stringify({ down: { buyer: new Date().toISOString() }, graceUntil: null })), 400);
        for (;;) { h.hitSync('store.before-write'); console.log(Date.now() - started); await new Promise((resolve) => setTimeout(resolve, 20)); }`;
      const result = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath, STATE: failpointSharedStatePath(specPath) });
      assert.equal(result.signal, 'SIGKILL', result.stderr);
      const survivedUntil = Number(result.stdout.trim().split('\n').at(-1));
      // Alive while the buyer was up; dead within a few hits of the state change (it is re-read every 50 ms).
      assert.ok(survivedUntil >= 350 && survivedUntil <= 700, `last store write survived at ${survivedUntil} ms`);
      assert.match(result.stderr, /armed store\.before-write=crash\(when buyer is down\)/);
      assert.equal(crashesInJournal(await journalOf(journalPath), 'w').length, 1);
    });
  });

  it('the handler passes the key of a hit on: a keyed crash is journaled with its key, and an unkeyed hit never fires it', async () => {
    await withDir(async (specPath, journalPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'k', seed: 4, points: { 'seller.spending-auth.after-verify': { action: 'crash', p: 1, keyed: true, killAfterMs: 150 }, 'buyer.spending-auth.after-sign': { action: 'error', p: 1, keyed: true } } }));
      const script = `
        const h = ${HANDLER};
        h.hitSync('seller.spending-auth.after-verify');
        console.log('unkeyed survived');
        console.log(await Promise.resolve().then(() => h.hit('buyer.spending-auth.after-sign', '0xc:5')).then(() => 'resolved', (error) => error.name));
        process.stdout.write('before ' + Date.now() + '\\n');
        h.hitSync('seller.spending-auth.after-verify', '0xc:7');
        console.log('ran on');
        // A process that is about to die fires nothing more: this keyed error rule would throw.
        console.log(await Promise.resolve().then(() => h.hit('buyer.spending-auth.after-sign', '0xc:9')).then(() => 'resolved', (error) => error.name));
        await new Promise((resolve) => setTimeout(resolve, 5000));
        console.log('outlived the kill');`;
      const started = Date.now();
      const result = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath });
      const lines = result.stdout.trim().split('\n');
      assert.deepEqual([result.signal, lines.slice(0, 2), lines.slice(3)], ['SIGKILL', ['unkeyed survived', 'FailpointError'], ['ran on', 'resolved']], result.stderr);
      assert.match(result.stderr, /armed seller\.spending-auth\.after-verify=crash~1\(keyed\)/);
      assert.match(result.stderr, /seller\.spending-auth\.after-verify hit=2 action=crash key=0xc:7/);
      const crash = crashesInJournal(await journalOf(journalPath), 'k')[0];
      assert.deepEqual([crash.point, crash.key, crash.hit], ['seller.spending-auth.after-verify', '0xc:7', 2]);
      // The kill came 150 ms after the point, not at it and not much later.
      const outlived = Date.now() - Number(lines[2].split(' ')[1]);
      assert.ok(Date.now() - started >= 150 && outlived >= 140 && outlived < 3000, `${outlived} ms`);
      assert.equal((await journalOf(journalPath)).filter((entry) => entry.action).length, 2);
    });
  });

  it('a killWhenDown crash marks the step at its point and kills once the shared state names the other node down', async () => {
    await withDir(async (specPath, journalPath) => {
      await writeFile(specPath, JSON.stringify({ id: 'w', seed: 4, maxCrashes: 1, ignoreOthers: true, points: { 'buyer.spending-auth.after-send': { action: 'crash', p: 1, keyed: true, killWhenDown: 'seller:seller' } } }));
      const script = `
        import { writeFileSync } from 'node:fs';
        const h = ${HANDLER};
        const started = Date.now();
        h.hitSync('buyer.spending-auth.after-send', '0xc:7');
        console.log('marked');
        setTimeout(() => writeFileSync(process.env.STATE, JSON.stringify({ down: { 'seller:seller': new Date().toISOString() }, graceUntil: null })), 400);
        setInterval(() => console.log(Date.now() - started), 20);`;
      const result = await runWithPreload(script, { [FAILPOINTS_FILE_ENV]: specPath, STATE: failpointSharedStatePath(specPath) });
      const lines = result.stdout.trim().split('\n');
      assert.deepEqual([result.signal, lines[0]], ['SIGKILL', 'marked'], result.stderr);
      // Alive until the seller was noted down, dead within a few polls of it.
      const survivedUntil = Number(lines.at(-1));
      assert.ok(survivedUntil >= 350 && survivedUntil <= 700, `alive until ${survivedUntil} ms`);
      assert.match(result.stderr, /buyer\.spending-auth\.after-send hit=1 action=crash key=0xc:7 \(kill once seller:seller is down\)/);
      const [crash] = crashesInJournal(await journalOf(journalPath), 'w');
      assert.deepEqual([crash.key, crash.pid], ['0xc:7', result.pid]);
      // The line is written at the kill, with the time of the point beside it.
      assert.ok(Date.parse(crash.at) - Date.parse(crash.triggeredAt) >= 300, `${crash.triggeredAt} -> ${crash.at}`);
      assert.equal(failpointCrashOfExit(await journalOf(journalPath), result).point, 'buyer.spending-auth.after-send');
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
      health.failpointCrashes.push({ who: 'seller:seller', point: 'store.before-write', hit: 2, at: new Date(Date.now() + 1000).toISOString(), restartError: 'seller start timeout' });
      await assert.rejects(tb.faults.waitForFailpointRestart('seller:seller', { timeoutMs: 1000 }), /did not come back after fail point store.before-write: seller start timeout/);
      const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line).type);
      assert.deepEqual([...new Set(events)], ['fault-failpoints', 'fault-failpoints-clear', 'failpoint-restart']);
    });
  });

  it('a crash of an earlier arming never stands in for this one: waitForFailpointRestart and the crash list are scoped by spec id', async () => {
    const health = structuredClone(CLEAN_HEALTH);
    // What a reused testbench still holds: an earlier run's crash of the same node at the same point, restarted long ago.
    health.failpointCrashes.push({ who: 'seller:seller', point: 'chain.close.after-send', hit: 1, at: '2026-01-01T00:00:00.000Z', pid: 3, spec: 'earlier', restartedAt: '2026-01-01T00:00:05.000Z' });
    await withTb({ control: { health: async () => health } }, async (tb) => {
      // Unscoped, the stale record answers at once; scoped to this arming it does not.
      assert.equal((await tb.faults.waitForFailpointRestart('seller:seller', { timeoutMs: 500 })).spec, 'earlier');
      await assert.rejects(tb.faults.waitForFailpointRestart('seller:seller', { specId: 'now', timeoutMs: 400 }), /Timed out/);
      assert.deepEqual(await tb.faults.failpointCrashes({ specIds: ['now'] }), []);
      assert.deepEqual(await tb.faults.waitForFailpointRestarts({ specIds: ['now'], timeoutMs: 400 }), []);
      const crash = { who: 'seller:seller', point: 'chain.close.after-send', hit: 1, at: new Date().toISOString(), pid: 8, spec: 'now' };
      health.failpointCrashes.push(crash);
      setTimeout(() => { crash.restartedAt = new Date().toISOString(); }, 300);
      assert.equal((await tb.faults.waitForFailpointRestart('seller:seller', { specId: 'now', timeoutMs: 5000 })).pid, 8);
      assert.deepEqual((await tb.faults.waitForFailpointRestarts({ specIds: ['now'] })).map((record) => record.pid), [8]);
      // A second crash of this arming is waited for too; one that does not come back throws.
      const second = { who: 'buyer', point: 'store.after-write', hit: 2, at: new Date().toISOString(), pid: 9, spec: 'now' };
      health.failpointCrashes.push(second);
      await assert.rejects(tb.faults.waitForFailpointRestarts({ specIds: ['now'], timeoutMs: 400 }), /Timed out/);
      assert.deepEqual((await tb.faults.waitForFailpointRestarts({ specIds: ['now'], who: 'seller:seller' })).map((record) => record.pid), [8]);
      second.restartError = 'buyer start timeout';
      await assert.rejects(tb.faults.waitForFailpointRestarts({ specIds: ['now'] }), /buyer did not come back after fail point store.after-write: buyer start timeout/);
    });
  });

  it('tb.load({ failpointCrash }) waits out every crash of the watched nodes and returns a restart window for each', async () => {
    let down = false;
    let served = 0;
    const health = structuredClone(CLEAN_HEALTH);
    const crashAt = { 9: { who: 'seller:seller', point: 'store.after-write', hit: 3, pid: 11, spec: 'storm-s' }, 40: { who: 'buyer', point: 'buyer.spending-auth.after-sign', hit: 5, pid: 12, spec: 'storm-b' } };
    const server = await flakyServer(() => {
      served += 1;
      if (crashAt[served]) {
        down = true;
        const crash = { ...crashAt[served], at: new Date().toISOString() };
        health.failpointCrashes.push(crash);
        // Another arming's crash in the middle of the load (a reused testbench cannot produce one, but the filter must hold).
        if (served === 9) health.failpointCrashes.push({ who: 'buyer', point: 'store.before-write', hit: 1, pid: 99, spec: 'other', at: new Date().toISOString(), restartedAt: new Date().toISOString() });
        setTimeout(() => { down = false; crash.restartedAt = new Date().toISOString(); }, 350);
      }
      return down;
    });
    try {
      await withTb({ proxyUrl: server.url, control: { health: async () => health } }, async (tb) => {
        const run = await tb.load({ concurrency: 4, requests: 80, streamRatio: 0, minInTokens: 1, maxInTokens: 2, gate: crashesGate({ crashes: 2, concurrency: 4, requests: 80 }), failpointCrash: { who: ['seller:seller', 'buyer'], specIds: ['storm-s', 'storm-b'] } });
        assert.deepEqual(run.restarts.map((restart) => [restart.who, restart.failpoint, restart.hit, restart.crashed]), [['seller', 'store.after-write', 3, true], ['buyer', 'buyer.spending-auth.after-sign', 5, true]]);
        assert.deepEqual(run.restart, run.restarts[0]);
        assert.ok(run.restarts.every((restart) => restart.downMs >= 300), JSON.stringify(run.restarts));
        assert.ok(run.restarts[1].stoppedAt > run.restarts[0].stoppedAt + run.restarts[0].downMs);
        // The load went on after the first restart, was held again by the second, and every failure is in a window.
        assert.equal(run.results.length, 80);
        assert.ok(run.client.failed >= 2 && run.client.failed <= 16, `${run.client.failed} failed`);
        assert.equal(run.client.failedOutsideRestartWindow, 0);
        assert.equal(run.client.failedInRestartWindow, run.client.failed);
        assert.deepEqual(run.gateProblems, []);
        assert.deepEqual(tb.summary().metrics.load[0].restarts, run.restarts);
        // Watching only the seller: the buyer's crash is not this load's.
        served = 0;
        health.failpointCrashes.length = 0;
        const one = await tb.load({ concurrency: 4, requests: 60, streamRatio: 0, minInTokens: 1, maxInTokens: 2, failpointCrash: { who: 'seller:seller' } });
        assert.deepEqual(one.restarts.map((restart) => restart.who), ['seller']);
        assert.equal('restarts' in tb.summary().metrics.load[1], false);
      });
    } finally {
      await server.stop();
    }
  });

  it('a load does not send into a dead node while the supervisor has not yet recorded its crash', async () => {
    let down = false;
    let served = 0;
    const health = structuredClone(CLEAN_HEALTH);
    // The node dies on the 9th request; the supervisor sees the exit only 150 ms later, and the node is back after 500 ms.
    const server = await flakyServer(() => {
      served += 1;
      if (served === 9) {
        down = true;
        const crash = { who: 'seller:seller', point: 'store.after-write', hit: 3, pid: 11, spec: 'a', at: new Date().toISOString() };
        setTimeout(() => health.failpointCrashes.push(crash), 150);
        setTimeout(() => { down = false; crash.restartedAt = new Date().toISOString(); }, 500);
      }
      return down;
    });
    try {
      await withTb({ proxyUrl: server.url, control: { health: async () => health } }, async (tb) => {
        const shape = { concurrency: 4, requests: 60, streamRatio: 0, minInTokens: 1, maxInTokens: 2 };
        const run = await tb.load({ ...shape, gate: crashesGate({ crashes: 1, ...shape, slack: 0 }), failpointCrash: { who: 'seller:seller', specIds: ['a'] } });
        // Only the requests in flight when the node died failed: no worker sent a second one into it.
        assert.ok(run.client.failed >= 1 && run.client.failed <= 4, `${run.client.failed} failed`);
        assert.deepEqual(run.gateProblems, []);
        assert.equal(run.restarts.length, 1);
      });
    } finally {
      await server.stop();
    }
  });

  it('clientSummary counts a failure as inside when it overlaps any restart window', () => {
    const startedAt = 1_000_000;
    const failure = (offset, ms = 100, error = '502:upstream_error') => ({ start: startedAt + offset, ms, error });
    const results = [{ start: startedAt, ms: 50 }, failure(10_000), failure(26_500), failure(40_000, 100, 'fetch:ECONNREFUSED'), failure(61_000), failure(90_000, 100, 'stream-truncated')];
    const first = { stoppedAt: 10_000, downMs: 1000 };
    const second = { stoppedAt: 60_000, downMs: 2000 };
    // One restart, as before: its window ends 15 s after the node is back.
    const single = clientSummary(results, { startedAt, restart: first });
    assert.deepEqual([single.failedInRestartWindow, single.failedOutsideRestartWindow], [1, 4]);
    assert.deepEqual(clientSummary(results, { startedAt, restarts: [first] }), single);
    const both = clientSummary(results, { startedAt, restarts: [first, second] });
    assert.deepEqual([both.failed, both.failedInRestartWindow, both.failedOutsideRestartWindow], [5, 2, 3]);
    assert.deepEqual(both.failuresOutsideRestartWindow, { '502:upstream_error': 1, 'fetch:ECONNREFUSED': 1, 'stream-truncated': 1 });
    assert.deepEqual(gateProblems({ ...both, total: 100, ok: 95 }, crashesGate({ crashes: 2, concurrency: 4, requests: 100 })), ['3 failures outside the restart window']);
    // A request that began before a crash and failed in it overlaps the window.
    assert.equal(clientSummary([failure(55_000, 6000)], { startedAt, restarts: [first, second] }).failedOutsideRestartWindow, 0);
    // No restart: no window fields; an empty list is the same.
    assert.equal('failedInRestartWindow' in clientSummary(results, { startedAt }), false);
    assert.equal('failedInRestartWindow' in clientSummary(results, { startedAt, restarts: [] }), false);
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
        const far = { who: 'buyer', point: 'store.after-write', hit: 1, at: new Date(run.startedAt + 600_000).toISOString(), restartedAt: new Date(run.startedAt + 601_000).toISOString() };
        assert.deepEqual(tb.withFailpointRestart(failed, far).gateProblems, ['1 failures outside the restart window']);
        // Several crashes: a window each, the first is `restart`; a crash before the load began covers that early failure.
        const early = { who: 'seller:seller', point: 'chain.reserve.after-send', hit: 1, at: new Date(run.startedAt - 3000).toISOString(), restartedAt: new Date(run.startedAt - 500).toISOString() };
        const several = tb.withFailpointRestart(failed, [early, far]);
        assert.deepEqual(several.restarts.map((restart) => restart.failpoint), ['chain.reserve.after-send', 'store.after-write']);
        assert.deepEqual([several.restart, several.gateProblems], [several.restarts[0], []]);
        assert.deepEqual(tb.summary().metrics.load.at(-1).restarts, several.restarts);
        // No crash to add: the run is returned as it is.
        assert.equal(tb.withFailpointRestart(run, []), run);
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

describe('a sweep and a testbench that is already running', () => {
  it('starts only on a slot that is free', () => {
    assert.equal(sweepSlotProblem(JSON.stringify({ name: 'wt-example', running: false, lock: 'free' })), null);
    // A compatible testbench that is up would be reused with its own seed, then stopped by the sweep.
    assert.match(sweepSlotProblem(JSON.stringify({ running: true, manifest: { name: 'wt-example', seed: 7 } })), /wt-example is already running/);
    assert.equal(sweepSlotProblem(`[testbench] Note: something\n${JSON.stringify({ name: 'wt-example', running: false }, null, 2)}\n`), null);
    assert.match(sweepSlotProblem('not json'), /could not read/);
    assert.match(sweepSlotProblem('{}'), /already running/);
  });
  it('asks about and stops the slot its runs use', () => {
    assert.deepEqual(sweepSlotArgs(['--chain', 'local']), []);
    assert.deepEqual(sweepSlotArgs(['--chain', 'local', '--slot', 'sweep']), ['--slot', 'sweep']);
  });
});
