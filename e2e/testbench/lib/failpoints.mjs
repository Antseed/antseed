// Fail points, testbench side: what a hit does. The payment code only reaches a named point
// (packages/buyer-core/src/failpoints.ts); this registry decides, from a spec and a seed, whether that hit crashes
// the node, throws or waits. Pure: lib/failpoint-preload.mjs gives it the clock, the journal and the kill.
import { dirname, join } from 'node:path';
import { createPrng, derive } from './prng.mjs';

/** The key on `globalThis` (as `Symbol.for`) the payment code reads its handler from. */
export const FAILPOINT_HANDLER_KEY = 'antseed.failpoints';
/** Read only by lib/failpoint-preload.mjs, never by packages/ or apps/. */
export const FAILPOINTS_FILE_ENV = 'ANTSEED_TESTBENCH_FAILPOINTS_FILE';
export const FAILPOINT_ACTIONS = ['crash', 'error', 'delay'];
export const MAX_FAILPOINT_DELAY_MS = 120_000;

const seller = { nodes: ['seller'] };
const buyer = { nodes: ['buyer'] };
/**
 * Every fail point: which node reaches it, whether it is a sync point (a delay cannot wait there) and when a stress
 * run reaches it: `load` under paid traffic on a small reserve, `close` only when a channel settles or closes,
 * `exit` only on the buyer's unilateral exit (requestClose, withdraw). The buyer node never takes that path: the
 * one-shot commands `antseed buyer channels request-close` and `withdraw` do, each reaching its three points once,
 * and stress-failpoint-exit kills them there (tb.cli({ failpoints })).
 * `hits` is how often each node reached the point in one stress-failpoint-crash run with nothing armed (seed 1 on
 * the local chain: the warm-up request and 160 requests 16-way on a 0.25 USDC reserve, counted 5 s after the load);
 * a drawn `nth` stays well inside it. The settle and close points were each reached once by the seller when the
 * channel then settled and closed, with one more store write on the seller and three on the buyer. Names must match
 * FAILPOINTS in buyer-core (test/failpoints.test.mjs). `keyed` marks the points whose call site passes the payment
 * step as a key, `<channel id>:<cumulative amount>` (the SpendingAuth's amount, the NeedAuth's required amount, the
 * seller's spend after a response, a top-up's new ceiling): a `keyed` rule can decide by it.
 */
export const POINT_CATALOG = {
  'store.before-write': { nodes: ['seller', 'buyer'], sync: true, phase: 'load', hits: { seller: 275, buyer: 388 } },
  'store.after-write': { nodes: ['seller', 'buyer'], sync: true, phase: 'load', hits: { seller: 275, buyer: 388 } },
  'chain.reserve.before-send': { ...seller, phase: 'load', hits: { seller: 1 } },
  'chain.reserve.after-send': { ...seller, phase: 'load', hits: { seller: 1 } },
  'chain.reserve.after-receipt': { ...seller, phase: 'load', hits: { seller: 1 } },
  'chain.top-up.before-send': { ...seller, phase: 'load', hits: { seller: 8 } },
  'chain.top-up.after-send': { ...seller, phase: 'load', hits: { seller: 8 } },
  'chain.top-up.after-receipt': { ...seller, phase: 'load', hits: { seller: 8 } },
  'chain.settle.before-send': { ...seller, phase: 'close' },
  'chain.settle.after-send': { ...seller, phase: 'close' },
  'chain.settle.after-receipt': { ...seller, phase: 'close' },
  'chain.close.before-send': { ...seller, phase: 'close' },
  'chain.close.after-send': { ...seller, phase: 'close' },
  'chain.close.after-receipt': { ...seller, phase: 'close' },
  'chain.request-close.before-send': { ...buyer, phase: 'exit' },
  'chain.request-close.after-send': { ...buyer, phase: 'exit' },
  'chain.request-close.after-receipt': { ...buyer, phase: 'exit' },
  'chain.withdraw.before-send': { ...buyer, phase: 'exit' },
  'chain.withdraw.after-send': { ...buyer, phase: 'exit' },
  'chain.withdraw.after-receipt': { ...buyer, phase: 'exit' },
  'seller.response.after-cost-recorded': { ...seller, sync: true, keyed: true, phase: 'load', hits: { seller: 161 } },
  'seller.need-auth.before-send': { ...seller, sync: true, keyed: true, phase: 'load', hits: { seller: 210 } },
  'seller.need-auth.after-send': { ...seller, sync: true, keyed: true, phase: 'load', hits: { seller: 210 } },
  'seller.spending-auth.after-verify': { ...seller, sync: true, keyed: true, phase: 'load', hits: { seller: 105 } },
  'seller.spending-auth.after-store': { ...seller, sync: true, keyed: true, phase: 'load', hits: { seller: 105 } },
  'seller.top-up.after-verify': { ...seller, sync: true, keyed: true, phase: 'load', hits: { seller: 10 } },
  'buyer.spending-auth.after-sign': { ...buyer, keyed: true, phase: 'load', hits: { buyer: 212 } },
  'buyer.spending-auth.before-send': { ...buyer, sync: true, keyed: true, phase: 'load', hits: { buyer: 212 } },
  'buyer.spending-auth.after-send': { ...buyer, sync: true, keyed: true, phase: 'load', hits: { buyer: 212 } },
  'buyer.reserve-auth.before-send': { ...buyer, sync: true, keyed: true, phase: 'load', hits: { buyer: 11 } },
  'buyer.reserve-auth.after-send': { ...buyer, sync: true, keyed: true, phase: 'load', hits: { buyer: 11 } },
};

/** What an `error` action throws from the point. */
export class FailpointError extends Error {
  constructor(point) {
    super(`fail point ${point}`);
    this.name = 'FailpointError';
    this.point = point;
  }
}

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const NODE_NAME = /^(buyer|seller:[a-z0-9][a-z0-9-]{0,23})$/;

/** The longest a spec may keep a killed node down before the supervisor starts it again. */
export const MAX_FAILPOINT_RESTART_DELAY_MS = 120_000;

/** The longest a crash may come after its point (killAfterMs). */
export const MAX_KILL_AFTER_MS = 1000;

/** A checked copy of one rule of a point; a delay's `ms` is a number or a `[min, max]` range a trigger draws from. */
function normalizeRule(name, rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw bad(`Fail point ${name} needs { action }`);
  const { action, ms, nth, p, count, whenDown, keyed, group, killAfterMs, killWhenDown, ...rest } = rule;
  if (Object.keys(rest).length) throw bad(`Fail point ${name} has unknown settings: ${Object.keys(rest).join(', ')}`);
  if (!FAILPOINT_ACTIONS.includes(action)) throw bad(`Fail point ${name} action must be one of ${FAILPOINT_ACTIONS.join(', ')}`);
  const msOk = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_FAILPOINT_DELAY_MS;
  const delayOk = msOk(ms) || (Array.isArray(ms) && ms.length === 2 && msOk(ms[0]) && msOk(ms[1]) && ms[0] <= ms[1]);
  if (action === 'delay' ? !delayOk : ms !== undefined) {
    throw bad(action === 'delay' ? `Fail point ${name} delay needs ms: 0..${MAX_FAILPOINT_DELAY_MS}, or [min, max] in that range` : `Fail point ${name}: only a delay takes ms`);
  }
  if (nth !== undefined && !(Number.isInteger(nth) && nth >= 1)) throw bad(`Fail point ${name} nth must be a positive integer`);
  if (p !== undefined && !(typeof p === 'number' && p >= 0 && p <= 1)) throw bad(`Fail point ${name} p must be 0..1`);
  if (count !== undefined && !(Number.isInteger(count) && count >= 1)) throw bad(`Fail point ${name} count must be a positive integer`);
  if (whenDown !== undefined && !(action === 'crash' && typeof whenDown === 'string' && NODE_NAME.test(whenDown))) throw bad(`Fail point ${name} whenDown names the node (buyer or seller:<id>) a crash rule waits to see down`);
  if (keyed !== undefined && typeof keyed !== 'boolean') throw bad(`Fail point ${name} keyed must be true or false`);
  if (keyed && (p === undefined || nth !== undefined)) throw bad(`Fail point ${name}: a keyed rule decides per key with p, and takes no nth`);
  if (group !== undefined && !(keyed && typeof group === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(group))) throw bad(`Fail point ${name} group names what a keyed rule hashes its key with instead of the point`);
  if (killAfterMs !== undefined && !(action === 'crash' && Number.isInteger(killAfterMs) && killAfterMs >= 0 && killAfterMs <= MAX_KILL_AFTER_MS)) throw bad(`Fail point ${name} killAfterMs is for a crash: 0..${MAX_KILL_AFTER_MS}`);
  if (killWhenDown !== undefined && !(action === 'crash' && killAfterMs === undefined && whenDown === undefined && typeof killWhenDown === 'string' && NODE_NAME.test(killWhenDown))) throw bad(`Fail point ${name} killWhenDown names the node (buyer or seller:<id>) whose death a crash waits for, and goes with neither killAfterMs nor whenDown`);
  return {
    action,
    ...(ms !== undefined ? { ms: Array.isArray(ms) ? [...ms] : ms } : {}),
    ...(nth !== undefined ? { nth } : {}),
    ...(p !== undefined ? { p } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(whenDown !== undefined ? { whenDown } : {}),
    ...(keyed ? { keyed: true } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(killAfterMs !== undefined ? { killAfterMs } : {}),
    ...(killWhenDown !== undefined ? { killWhenDown } : {}),
  };
}

/**
 * A checked copy of a spec: `{ seed, points: { '<name>': rule | [rule, ...] }, maxCrashes?, graceMs?, restartDelayMs?,
 * ignoreOthers? }` with a rule `{ action: 'crash' | 'error' | 'delay', ms?, nth?, p?, count?, whenDown?, keyed?, group?,
 * killAfterMs? }`. A point
 * with several rules tries them in order on every hit and the first that triggers wins, so one point can carry a delay
 * and a crash. `nth` triggers on exactly that hit of the point, `p` on a seeded share of hits (both: on the nth hit,
 * with that chance; neither: on every hit), `count` caps the triggers of that rule (no cap, except 1 for a crash rule
 * without `p` in a spec without `maxCrashes`: it would kill every life of the node at the same hit). `id` names one
 * arming, so triggers of an earlier spec in the journal do not count against this one.
 *
 * A rule with `keyed: true` decides by the payment step instead of the hit: the payment code passes a key at some
 * points (a channel id and a cumulative amount, see `keyed` in POINT_CATALOG), and the rule triggers when a hash of
 * the spec's seed, the point (or the rule's `group`) and that key falls below `p` (keyedDecision), at most once per
 * key over all lives of the node. The order the hits arrive in does not change which keys are picked, and two nodes
 * armed with one seed and one `group` pick the same keys. A hit without a key never triggers a keyed rule.
 * `killAfterMs` makes a crash come that long after its point instead of at it: the trigger is journaled at the point,
 * the node runs on (no further fail point acts in it) and is killed when the time is up. That is for a point right
 * after a send: a frame the code just handed to the transport is still in the socket's queue, and a kill at the point
 * itself would take it along. `killWhenDown: '<node>'` makes a crash wait the same way until the shared crash state
 * says that node is down (looked at every 25 ms): the rule marks the step at its point, and the node dies when the
 * other one has died. Either way the journal line is written at the kill, with `triggeredAt` for the point's time.
 *
 * Crashes are coordinated across the armed nodes of a testbench through the supervisor's shared crash state
 * (crashBlocked): no crash rule triggers while any node a fail point killed is still down, or while the grace window
 * after its restart runs. `graceMs` (a number, or a `[min, max]` range drawn per crash) is that window for a crash
 * of this spec; a node that was never killed has none. `ignoreOthers: true` takes this spec's crashes out of that
 * rule, and a crash rule with `whenDown: '<node>'` triggers only while the shared state says that node is down (and
 * for that reason is not held back by it): both are for a scenario that wants two nodes down together.
 * `maxCrashes` caps the crash triggers of this arming over all points and all lives of the node, and
 * `restartDelayMs: [min, max]` is how long the supervisor keeps a node this spec killed down (a seeded draw).
 */
export function normalizeFailpointSpec(spec, { names = Object.keys(POINT_CATALOG) } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw bad('A fail point spec is an object: { seed, points }');
  const { seed = 0, points = {}, id, maxCrashes, graceMs, restartDelayMs, ignoreOthers, ...unknown } = spec;
  if (Object.keys(unknown).length) throw bad(`A fail point spec has unknown settings: ${Object.keys(unknown).join(', ')}`);
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw bad('spec.seed must be an integer in [0, 2^32)');
  if (!points || typeof points !== 'object' || Array.isArray(points)) throw bad('spec.points maps point names to { action, ... }');
  if (maxCrashes !== undefined && !(Number.isInteger(maxCrashes) && maxCrashes >= 1)) throw bad('spec.maxCrashes must be a positive integer');
  const delayOk = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_FAILPOINT_RESTART_DELAY_MS;
  const rangeOk = (value) => Array.isArray(value) && value.length === 2 && value.every(delayOk) && value[0] <= value[1];
  if (graceMs !== undefined && !((Number.isInteger(graceMs) && graceMs >= 0) || rangeOk(graceMs))) throw bad(`spec.graceMs must be a non-negative integer, or [min, max] with 0 <= min <= max <= ${MAX_FAILPOINT_RESTART_DELAY_MS}`);
  if (restartDelayMs !== undefined && !rangeOk(restartDelayMs)) {
    throw bad(`spec.restartDelayMs must be [min, max] with 0 <= min <= max <= ${MAX_FAILPOINT_RESTART_DELAY_MS}`);
  }
  if (ignoreOthers !== undefined && typeof ignoreOthers !== 'boolean') throw bad('spec.ignoreOthers must be true or false');
  const normalized = {};
  for (const [name, rule] of Object.entries(points)) {
    if (!names.includes(name)) throw bad(`Unknown fail point ${name}`);
    if (Array.isArray(rule)) {
      if (rule.length === 0) throw bad(`Fail point ${name} needs at least one rule`);
      normalized[name] = rule.map((entry) => normalizeRule(name, entry));
    } else normalized[name] = normalizeRule(name, rule);
  }
  return {
    ...(id !== undefined ? { id: String(id) } : {}),
    seed,
    ...(maxCrashes !== undefined ? { maxCrashes } : {}),
    ...(graceMs !== undefined ? { graceMs: Array.isArray(graceMs) ? [...graceMs] : graceMs } : {}),
    ...(restartDelayMs !== undefined ? { restartDelayMs: [...restartDelayMs] } : {}),
    ...(ignoreOthers ? { ignoreOthers: true } : {}),
    points: normalized,
  };
}

/** Journal lines as entries; a torn last line (the node was killed while writing) is skipped. */
export function parseJournal(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return entries;
}

/** Triggers per point that a journal records for the spec `id`: what an earlier life of this node already did. */
export function triggersInJournal(entries, id) {
  const counts = {};
  for (const entry of entries) {
    if (!entry.action || entry.skipped || entry.spec !== id) continue;
    counts[entry.point] = (counts[entry.point] ?? 0) + 1;
  }
  return counts;
}

/** The crash triggers a journal records for the spec `id`, oldest first: one per life of the node this arming ended. */
export function crashesInJournal(entries, id) {
  return entries.filter((entry) => entry.action === 'crash' && !entry.skipped && entry.spec === id);
}

/**
 * Delays per point that fired under the spec `id` (`{ point: n }`). A node journals only the first delay of a point
 * line by line; the totals of one arming in one process are a `delays` entry written when that arming ends (the spec
 * changes, the node stops, or a crash trigger is about to kill it).
 */
export function delaysInJournal(entries, id) {
  const totals = {};
  for (const entry of entries) {
    if (!entry.delays || entry.spec !== id) continue;
    for (const [point, count] of Object.entries(entry.delays)) totals[point] = (totals[point] ?? 0) + count;
  }
  return totals;
}

/** The crash a journal records for process `pid`, if a fail point killed it: its last crash trigger. */
export function crashInJournal(entries, pid) {
  return entries.findLast((entry) => entry.pid === pid && entry.action === 'crash' && !entry.skipped) ?? null;
}

/**
 * The journal's crash trigger that explains a node's exit, or null when the exit is a real one. A fail point kills
 * with SIGKILL, so any other exit is not its doing; and a crash entry an earlier `failpointCrashes` record already
 * stands for (same pid and time) explains that earlier exit, not this one: a pid the system hands out again must not
 * turn a real crash into an expected one.
 */
export function failpointCrashOfExit(entries, { pid, signal }, records = []) {
  if (signal !== 'SIGKILL') return null;
  const consumed = (entry) => records.some((record) => record.pid === entry.pid && record.at === entry.at && record.point === entry.point);
  return entries.findLast((entry) => entry.pid === pid && entry.action === 'crash' && !entry.skipped && !consumed(entry)) ?? null;
}

/**
 * How long the supervisor keeps a node down after crash number `crashNumber` (1 for the first of `who`) of the armed
 * `spec`: a draw from its `restartDelayMs` range, seeded from the spec's seed (itself derived from the run seed and
 * the node), the node and the crash number; `fallbackMs` when the spec sets none or is no longer the one that killed.
 */
export function restartDelayFor(spec, { who, crashNumber, specId, fallbackMs }) {
  const range = spec?.restartDelayMs;
  if (!range || (specId !== undefined && spec.id !== specId)) return fallbackMs;
  const random = createPrng(derive(spec.seed ?? 0, `failpoint-restart:${who}#${crashNumber}`));
  return range[0] + Math.floor(random() * (range[1] - range[0] + 1));
}

/**
 * The grace window after the restart that follows crash number `crashNumber` of `who` under the armed `spec`: its
 * `graceMs`, or a draw from the range, seeded like restartDelayFor; 0 when the spec sets none or is no longer the one
 * that killed.
 */
export function graceFor(spec, { who, crashNumber, specId }) {
  const grace = spec?.graceMs;
  if (grace === undefined || (specId !== undefined && spec.id !== specId)) return 0;
  if (!Array.isArray(grace)) return grace;
  const random = createPrng(derive(spec.seed ?? 0, `failpoint-grace:${who}#${crashNumber}`));
  return grace[0] + Math.floor(random() * (grace[1] - grace[0] + 1));
}

/**
 * Hit counting and trigger decisions for one node. `arm(spec, journalEntries)` loads a spec (null disarms) and
 * restarts the hit counts; triggers the journal already records for that spec count against `count` and `maxCrashes`,
 * so a crash with `count: 1` does not fire again in the process that replaces the killed one. `hit(name, { sync,
 * others })` returns `{ point, hit, first, trigger }`: `first` on the first hit of a point in this process, `trigger`
 * null or `{ action, ms?, rule?, skipped?, quiet?, key?, killAfterMs?, killWhenDown? }` (`rule`: the index in a point's rule list;
 * `quiet`: a delay that is not the first of its point in this arming, which the journal counts instead of listing;
 * `key`: the key a keyed rule fired on, from the hit's `key`). A delay on a sync point
 * cannot wait: it is returned as `skipped`, and still counts. `others()` returns the shared crash state as
 * `{ blocked, down }` (crashBlocked and the nodes that are down); it is asked only when a crash rule would otherwise
 * trigger, and a caller that passes none is never held back.
 */
const NO_OTHERS = () => ({ blocked: false, down: [] });

/**
 * Whether a keyed rule picks `key`: a hash of the seed, the group (the rule's `group`, else the point name) and the
 * key, as a number in [0, 1), below `p`. No stream, no hit count: the same seed, group and key decide the same in any
 * order, in any process.
 */
export function keyedDecision(seed, group, key, p) {
  return derive(derive(seed, `keyed:${group}`), String(key)) / 2 ** 32 < p;
}

export function createFailpointRegistry() {
  let spec = null;
  let hits = {};
  let triggers = {};
  let streams = {};
  let delays = {};
  let crashes = 0;
  let keysFired = {};
  const reached = new Set();
  const total = {};
  return {
    arm(next, journalEntries = []) {
      spec = next && Object.keys(next.points ?? {}).length ? next : null;
      hits = {};
      streams = {};
      delays = {};
      triggers = {};
      keysFired = {};
      crashes = spec ? crashesInJournal(journalEntries, spec.id).length : 0;
      if (!spec) return;
      for (const entry of journalEntries) {
        // A key an earlier life already fired on, skipped or not: once per key.
        if (entry.key !== undefined && entry.action && entry.spec === spec.id) (keysFired[`${entry.point}#${entry.rule ?? 0}`] ??= new Set()).add(entry.key);
        // Delays are counted from the `delays` totals below: only the first of a point is a line.
        if (!entry.action || entry.action === 'delay' || entry.skipped || entry.spec !== spec.id) continue;
        const key = `${entry.point}#${entry.rule ?? 0}`;
        triggers[key] = (triggers[key] ?? 0) + 1;
      }
      for (const [point, count] of Object.entries(delaysInJournal(journalEntries, spec.id))) {
        const index = [spec.points[point]].flat().findIndex((rule) => rule?.action === 'delay');
        if (index >= 0) triggers[`${point}#${index}`] = count;
      }
    },
    spec: () => spec,
    /** Hits per point since the process started, across armings: what the catalog's `hits` are measured from. */
    totals: () => ({ ...total }),
    /** Delays per point that waited since the arming (skipped ones are not delays). */
    delays: () => ({ ...delays }),
    hit(name, { sync = false, others = NO_OTHERS, key: hitKey } = {}) {
      total[name] = (total[name] ?? 0) + 1;
      const first = !reached.has(name);
      reached.add(name);
      const armed = spec?.points[name];
      if (!armed) return { point: name, hit: total[name], first, trigger: null };
      const hit = (hits[name] = (hits[name] ?? 0) + 1);
      const rules = Array.isArray(armed) ? armed : [armed];
      for (const [index, rule] of rules.entries()) {
        const key = `${name}#${index}`;
        const fired = triggers[key] ?? 0;
        // A stream per point, rule and life of the node (the crashes this arming already has): a restarted node does
        // not replay the draws that led to its crash.
        const random = (rule.p === undefined || rule.keyed) && !Array.isArray(rule.ms) ? null : (streams[key] ??= createPrng(derive(spec.seed, `${name}#${index}#${crashes}`)));
        // Drawn on every hit, so the hit a `p` picks does not depend on `nth`, `count` or the grace period. A keyed
        // rule draws nothing: the key decides, once.
        const chance = rule.keyed
          ? hitKey !== undefined && !keysFired[key]?.has(hitKey) && keyedDecision(spec.seed, rule.group ?? name, hitKey, rule.p)
          : rule.p === undefined ? true : random() < rule.p;
        const isCrash = rule.action === 'crash';
        const limit = rule.count ?? (isCrash && rule.p === undefined && spec.maxCrashes === undefined ? 1 : Infinity);
        if (fired >= limit || !chance || (rule.nth !== undefined && hit !== rule.nth)) continue;
        if (isCrash) {
          if (spec.maxCrashes !== undefined && crashes >= spec.maxCrashes) continue;
          // One node down at a time, and nothing killed in the grace window after a restart: unless this rule waits
          // for exactly that (whenDown) or the spec opts out.
          if (rule.whenDown !== undefined ? !others().down.includes(rule.whenDown) : !spec.ignoreOthers && others().blocked) continue;
        }
        triggers[key] = fired + 1;
        if (rule.keyed) (keysFired[key] ??= new Set()).add(hitKey);
        if (isCrash) crashes += 1;
        const skipped = rule.action === 'delay' && sync;
        const ms = Array.isArray(rule.ms) ? rule.ms[0] + Math.floor(random() * (rule.ms[1] - rule.ms[0] + 1)) : rule.ms;
        const waits = rule.action === 'delay' && !skipped;
        if (waits) delays[name] = (delays[name] ?? 0) + 1;
        return {
          point: name, hit, first,
          trigger: {
            action: rule.action,
            ...(ms !== undefined ? { ms } : {}),
            ...(Array.isArray(armed) ? { rule: index } : {}),
            ...(skipped ? { skipped: 'sync point' } : {}),
            ...(waits && delays[name] > 1 ? { quiet: true } : {}),
            ...(rule.keyed ? { key: hitKey } : {}),
            ...(rule.killAfterMs ? { killAfterMs: rule.killAfterMs } : {}),
            ...(rule.killWhenDown ? { killWhenDown: rule.killWhenDown } : {}),
          },
        };
      }
      return { point: name, hit, first, trigger: null };
    },
  };
}

/**
 * The latest hit counts a journal holds (`{ point: hits }` of one process since it started), or null. A helper process
 * a node starts inherits the handler and leaves empty counts when it exits; those are skipped.
 */
export function countsInJournal(entries) {
  return entries.findLast((entry) => entry.counts && Object.keys(entry.counts).length > 0)?.counts ?? null;
}

/**
 * Whether a journal records that `point` triggered `action` (and, for a crash, killed the process) under the arming
 * `specId`. The journal outlives a run on a reused testbench, so without the id an earlier arming's trigger would
 * count; leave it out only to ask about any arming.
 */
export function triggeredInJournal(entries, point, action, specId) {
  return entries.some((entry) => entry.point === point && entry.action === action && !entry.skipped && (specId === undefined || entry.spec === specId));
}

/** `who` of a node as a file name: `buyer`, `seller:<id>` → `seller-<id>`. */
export function failpointFileName(who) {
  if (who !== 'buyer' && !/^seller:[a-z0-9][a-z0-9-]{0,23}$/.test(who)) throw Object.assign(new Error(`Fail points belong to buyer or seller:<id>, not ${who}`), { statusCode: 404 });
  return `${who.replace(':', '-')}.json`;
}

/** The journal next to a node's spec file. */
export const failpointJournalPath = (specPath) => specPath.replace(/\.json$/, '.journal.jsonl');

/**
 * The supervisor's shared crash state, one file for all nodes of a testbench, in the directory of their spec files:
 * `{ down: { '<who>': '<ISO time it died>' }, graceUntil: '<ISO time>' | null }`. A node is `down` from the moment
 * the supervisor saw a fail point kill it until it is back in service; `graceUntil` is the end of the latest grace
 * window after such a restart. Every node's handler reads it before a crash.
 */
export const failpointSharedStatePath = (specPath) => join(dirname(specPath), 'crash-state.json');

/** The shared state while nothing has been killed. */
export const emptyCrashState = () => ({ down: {}, graceUntil: null });

/**
 * What a node's handler makes of the shared crash state at `now` (ms): `down`, the nodes a fail point killed that are
 * not back yet, and `blocked`, whether a coordinated crash must not fire: a node is down, or the grace window after a
 * restart is running. A missing or unreadable state blocks nothing: nothing was killed yet.
 */
export function crashBlocked(state, now) {
  const down = state && typeof state.down === 'object' && state.down ? Object.keys(state.down) : [];
  const graceUntil = Date.parse(state?.graceUntil ?? '');
  return { down, blocked: down.length > 0 || (Number.isFinite(graceUntil) && now < graceUntil) };
}

/** The shared state after `who` was killed at `at` (ISO): it is down. */
export function crashStateAfterKill(state, who, at) {
  return { ...state, down: { ...state.down, [who]: at } };
}

/** The shared state after `who` is back in service at `now` (ms): no longer down, and nothing is killed for `graceMs`. */
export function crashStateAfterRestart(state, who, now, graceMs = 0) {
  const { [who]: _back, ...down } = state.down;
  const until = Math.max(now + graceMs, Date.parse(state.graceUntil ?? '') || 0);
  return { down, graceUntil: graceMs > 0 || state.graceUntil ? new Date(until).toISOString() : null };
}

// ── Seeded plans for the fail point scenarios ───────────────────────────────

/** Points a stress load on a small reserve reaches, as `{ who, point, max }` (the most hits a drawn `nth` may ask for). */
export function loadCrashCandidates(catalog = POINT_CATALOG) {
  const out = [];
  for (const [point, entry] of Object.entries(catalog)) {
    if (entry.phase !== 'load') continue;
    for (const who of entry.nodes) out.push({ who, point, max: entry.hits?.[who] ?? 1 });
  }
  return out;
}

/** Points reached only when a channel settles or closes; `store.*` writes happen then too. All on the seller. */
export function closeCrashCandidates(catalog = POINT_CATALOG) {
  const chain = Object.entries(catalog).filter(([, entry]) => entry.phase === 'close').map(([point]) => point);
  return [...chain, 'store.before-write', 'store.after-write'].map((point) => ({ who: 'seller', point }));
}

/**
 * One crash for a stress load, drawn from `random` (tb.prng('failpoint')): `{ who, point, nth }`. `nth` lies in the
 * first 60% of the hits the catalog measured, so a slower or shorter run still reaches it, and past the first hit of
 * a busy point, so the crash lands in running traffic rather than in the warm-up request.
 */
export function drawLoadCrash(random, candidates = loadCrashCandidates()) {
  const { who, point, max } = candidates[Math.floor(random() * candidates.length)];
  const top = Math.max(1, Math.floor(max * 0.6));
  const floor = top >= 10 ? 4 : 1;
  return { who, point, nth: floor + Math.floor(random() * (top - floor + 1)) };
}

/** One crash for the close phase: `{ who: 'seller', point, nth: 1 }`, armed once traffic has stopped. */
export function drawCloseCrash(random, candidates = closeCrashCandidates()) {
  return { ...candidates[Math.floor(random() * candidates.length)], nth: 1 };
}

/**
 * A spec with the seed tb.faults.failpoints() gives it when it names none: derived from the run seed and the node, so
 * a scenario's plan can be printed for a seed without a testbench.
 */
export function armedSpec(runSeed, who, spec) {
  return { seed: derive(runSeed, `failpoints:${who}`), ...spec };
}

/** The spec that arms one drawn crash. */
export function crashSpec(plan) {
  return { points: { [plan.point]: { action: 'crash', nth: plan.nth } } };
}

/**
 * A load's restart record from a fail point crash the supervisor recorded: when the node died and how long it was
 * down, relative to the load's start, in the shape clientSummary and a `restart: true` gate read.
 */
export function restartFromCrash(crash, loadStartedAt) {
  const diedAt = Date.parse(crash.at);
  return { who: crash.who.split(':')[0], failpoint: crash.point, hit: crash.hit, crashed: true, stoppedAt: diedAt - loadStartedAt, downMs: Date.parse(crash.restartedAt) - diedAt };
}

/** The supervisor's crash records of one or several armings (`specIds`) and nodes (`who`, all when left out), oldest first. */
export function crashesOfArming(records, { specIds, who } = {}) {
  const nodes = who === undefined ? null : [who].flat();
  return (records ?? [])
    .filter((record) => (!specIds || specIds.includes(record.spec)) && (!nodes || nodes.includes(record.who)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ── Crashes and delays: every point armed at once, no cap on the crashes ─────

/** The points of `phase` that `node` ('seller' or 'buyer') reaches, as `{ point, sync, hits }`. */
export function pointsOfNode(node, { catalog = POINT_CATALOG, phase = 'load' } = {}) {
  return Object.entries(catalog)
    .filter(([, entry]) => entry.phase === phase && entry.nodes.includes(node))
    .map(([point, entry]) => ({ point, sync: Boolean(entry.sync), keyed: Boolean(entry.keyed), hits: entry.hits?.[node] ?? 1 }));
}

/** The requests of the load the catalog's `hits` were measured on. */
export const CATALOG_LOAD_REQUESTS = 160;
/** The most a point reached a few times may be given: a point reached once is not killed at every reach. */
export const MAX_RARE_POINT_P = 0.25;

/**
 * A spec's `points` that arm every load-phase point `node` reaches at once. Each gets a crash rule with
 * `p = crashesPerPoint / (hits x hitsScale)` (`hits` from the catalog, `hitsScale` how much longer the load is than
 * the one they were measured on; at most `maxP`), so a point reached once and a point reached 300 times are each
 * expected to kill the node about equally often. With `delay: { p, ms }` every point that can wait (not a sync point)
 * also gets a delay rule in front of the crash rule, with that `p` per hit and `ms` (a number or a `[min, max]` range).
 * With `keyed: true` the crash rule of every point that carries a key decides per payment step instead of per hit
 * (the same `p`: a point is reached about once per step), so one seed kills at the same steps in every run.
 */
export function allPointsSpec({ node, catalog = POINT_CATALOG, crashesPerPoint, delay, hitsScale = 1, maxP = 1, keyed = false }) {
  if (!(typeof crashesPerPoint === 'number' && crashesPerPoint > 0)) throw new Error('allPointsSpec needs crashesPerPoint > 0');
  if (!(hitsScale > 0) || !(maxP > 0 && maxP <= 1)) throw new Error('allPointsSpec needs hitsScale > 0 and 0 < maxP <= 1');
  const points = {};
  for (const { point, sync, hits, keyed: carriesKey } of pointsOfNode(node, { catalog })) {
    const crash = { action: 'crash', p: Math.min(maxP, crashesPerPoint / (hits * hitsScale)), ...(keyed && carriesKey ? { keyed: true } : {}) };
    points[point] = delay && !sync ? [{ action: 'delay', ms: delay.ms, p: delay.p }, crash] : crash;
  }
  if (Object.keys(points).length === 0) throw new Error(`No load-phase fail point is reached by ${node}`);
  return { points };
}

const between = (random, min, max) => min + Math.floor(random() * (max - min + 1));

/**
 * The seeded plan of a crashes-and-delays run, per node: `{ expectedCrashes, crashesPerPoint, graceMs: [min, max],
 * restartDelayMs: [min, max], delay: { p, msRange } }`. There is no cap on the crashes: `expectedCrashes` (6 to 9)
 * crash triggers would fire over the node's points in the run's load if nothing held them back, and the shared rule
 * (one node down at a time, a grace window after each restart) sets how many do. A killed node stays down for a time
 * drawn per crash from `restartDelayMs` (from 2 to 4 s up to 6 to 10 s) and the grace after its restart is drawn per
 * crash from `graceMs` (from 5 to 8 s up to 10 to 20 s). Points that can wait delay a `p` (0.05 to 0.3) share of their
 * hits by 200 to 3000 ms. The nodes are drawn in the order given, so the first node's plan does not depend on which
 * others follow.
 */
export function drawCrashesAndDelaysPlan(random, { nodes = ['seller'], catalog = POINT_CATALOG } = {}) {
  const plan = {};
  for (const node of nodes) {
    const points = pointsOfNode(node, { catalog }).length;
    if (points === 0) throw new Error(`No load-phase fail point is reached by ${node}`);
    const expectedCrashes = 6 + Math.floor(random() * 301) / 100;
    const graceMin = between(random, 5000, 8000);
    const graceMax = between(random, 10_000, 20_000);
    const restartMin = between(random, 2000, 4000);
    const restartMax = between(random, 6000, 10_000);
    const delayP = 0.05 + Math.floor(random() * 26) / 100;
    const delayMin = between(random, 200, 1000);
    const delayMax = between(random, delayMin, 3000);
    plan[node] = {
      expectedCrashes, crashesPerPoint: expectedCrashes / points, graceMs: [graceMin, graceMax],
      restartDelayMs: [restartMin, restartMax], delay: { p: delayP, msRange: [delayMin, delayMax] },
    };
  }
  return plan;
}

/**
 * The spec that arms one node's part of a crashes-and-delays plan on every load-phase point it reaches, for a load of
 * `requests` requests; `keyed` as in allPointsSpec.
 */
export function crashesAndDelaysSpec(node, nodePlan, { catalog = POINT_CATALOG, requests = CATALOG_LOAD_REQUESTS, keyed = false } = {}) {
  return {
    ...allPointsSpec({ node, catalog, crashesPerPoint: nodePlan.crashesPerPoint, delay: { p: nodePlan.delay.p, ms: nodePlan.delay.msRange }, hitsScale: requests / CATALOG_LOAD_REQUESTS, maxP: MAX_RARE_POINT_P, keyed }),
    graceMs: nodePlan.graceMs, restartDelayMs: nodePlan.restartDelayMs,
  };
}

// ── Correlated crashes: two nodes down together, on purpose ─────────────────

/** How long each node of a correlated crash stays down: the buyer dies within a moment of the seller, so the windows overlap by seconds. */
export const CORRELATED_BUYER_DOWN_MS = [3000, 6000];
export const CORRELATED_SELLER_DOWN_MS = [6000, 10_000];
/** The chance that a SpendingAuth is the one both nodes die at: over the 100 and more a load signs, one is picked in all but about 1 run in 500. */
export const CORRELATED_STEP_P = 0.06;
/** What both nodes hash a SpendingAuth's key with, so they pick the same one. */
export const CORRELATED_GROUP = 'spending-auth';

/**
 * The plan of a correlated crash: `{ seed, group, p, buyerPoint, sellerPoint }`. Both nodes are armed with one seed
 * and a keyed crash rule on the same payment step, a SpendingAuth: the buyer right after it sent one
 * (`buyer.spending-auth.after-send`), the seller right after it verified one (`seller.spending-auth.after-verify`).
 * The key is the channel and the cumulative amount, so both pick the same SpendingAuth (keyedDecision), whatever
 * order the traffic arrives in. Which one is picked is not known before the run (the channel id is not), only that
 * it is the same on both.
 */
export function drawCorrelatedCrash(seed) {
  return { seed: derive(seed, 'crashes-correlated'), group: CORRELATED_GROUP, p: CORRELATED_STEP_P, buyerPoint: 'buyer.spending-auth.after-send', sellerPoint: 'seller.spending-auth.after-verify' };
}

/**
 * The two specs of a correlated crash plan, by node name (`nodes`: `{ seller, buyer }`). The seller dies at the
 * point, the moment it has verified the picked SpendingAuth. The buyer cannot die at its point: a kill right after
 * the send would take the frame along, and a SpendingAuth above the reserve ceiling is verified only once the
 * seller's top-up is mined, seconds later, which a dead buyer would never see (the seller closes the channel of a
 * buyer that disconnects). So the buyer marks the step at its point and is killed as soon as the shared crash state
 * says the seller is down (`killWhenDown`). One crash per node, and neither spec waits for the other node to be up.
 */
export function correlatedCrashSpecs(plan, nodes) {
  const spec = (point, extra, restartDelayMs) => ({ seed: plan.seed, points: { [point]: { action: 'crash', p: plan.p, keyed: true, group: plan.group, ...extra } }, maxCrashes: 1, ignoreOthers: true, restartDelayMs });
  return {
    buyer: spec(plan.buyerPoint, { killWhenDown: nodes.seller }, CORRELATED_BUYER_DOWN_MS),
    seller: spec(plan.sellerPoint, {}, CORRELATED_SELLER_DOWN_MS),
  };
}

// ── The buyer's exit: one-shot commands killed at a fail point ──────────────

/**
 * The plan of an exit run: `{ requestClose, withdraw }`, one of the three `chain.request-close.*` points and one of
 * the three `chain.withdraw.*` points (nothing sent yet, broadcast, mined), at which that command is killed.
 */
export function drawExitCrashes(random, { catalog = POINT_CATALOG } = {}) {
  const points = pointsOfNode('buyer', { catalog, phase: 'exit' }).map((entry) => entry.point);
  const pick = (op) => { const of = points.filter((point) => point.startsWith(`chain.${op}.`)); return of[Math.floor(random() * of.length)]; };
  return { requestClose: pick('request-close'), withdraw: pick('withdraw') };
}

/** Whether two crash records were down at the same time: each died before the other was back. */
export function downWindowsOverlap(a, b) {
  const window = (crash) => [Date.parse(crash.at), crash.restartedAt ? Date.parse(crash.restartedAt) : Infinity];
  const [aStart, aEnd] = window(a);
  const [bStart, bEnd] = window(b);
  return aStart < bEnd && bStart < aEnd;
}
