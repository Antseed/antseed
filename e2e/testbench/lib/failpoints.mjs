// Fail points, testbench side: what a hit does. The payment code only reaches a named point
// (packages/buyer-core/src/failpoints.ts); this registry decides, from a spec and a seed, whether that hit crashes
// the node, throws or waits. Pure: lib/failpoint-preload.mjs gives it the clock, the journal and the kill.
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
 * `exit` only on the buyer's unilateral exit (requestClose, withdraw), which no stress shape takes.
 * `hits` is how often each node reached the point in one stress-failpoint-crash run with nothing armed (seed 1 on
 * the local chain: the warm-up request and 160 requests 16-way on a 0.25 USDC reserve, counted 5 s after the load);
 * a drawn `nth` stays well inside it. The settle and close points were each reached once by the seller when the
 * channel then settled and closed, with one more store write on the seller and three on the buyer. Names must match
 * FAILPOINTS in buyer-core (test/failpoints.test.mjs).
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
  'seller.response.after-cost-recorded': { ...seller, sync: true, phase: 'load', hits: { seller: 161 } },
  'seller.need-auth.before-send': { ...seller, sync: true, phase: 'load', hits: { seller: 210 } },
  'seller.need-auth.after-send': { ...seller, sync: true, phase: 'load', hits: { seller: 210 } },
  'seller.spending-auth.after-verify': { ...seller, sync: true, phase: 'load', hits: { seller: 105 } },
  'seller.spending-auth.after-store': { ...seller, sync: true, phase: 'load', hits: { seller: 105 } },
  'seller.top-up.after-verify': { ...seller, sync: true, phase: 'load', hits: { seller: 10 } },
  'buyer.spending-auth.after-sign': { ...buyer, phase: 'load', hits: { buyer: 212 } },
  'buyer.spending-auth.before-send': { ...buyer, sync: true, phase: 'load', hits: { buyer: 212 } },
  'buyer.spending-auth.after-send': { ...buyer, sync: true, phase: 'load', hits: { buyer: 212 } },
  'buyer.reserve-auth.before-send': { ...buyer, sync: true, phase: 'load', hits: { buyer: 11 } },
  'buyer.reserve-auth.after-send': { ...buyer, sync: true, phase: 'load', hits: { buyer: 11 } },
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

/**
 * A checked copy of a spec: `{ seed, points: { '<name>': { action: 'crash' | 'error' | 'delay', ms?, nth?, p?, count? } } }`.
 * `nth` triggers on exactly that hit of the point, `p` on a seeded share of hits (both: on the nth hit, with that
 * chance; neither: on every hit), `count` caps the triggers (default 1 for a crash, no cap otherwise). `id` names one
 * arming, so triggers of an earlier spec in the journal do not count against this one.
 */
export function normalizeFailpointSpec(spec, { names = Object.keys(POINT_CATALOG) } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw bad('A fail point spec is an object: { seed, points }');
  const { seed = 0, points = {}, id } = spec;
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw bad('spec.seed must be an integer in [0, 2^32)');
  if (!points || typeof points !== 'object' || Array.isArray(points)) throw bad('spec.points maps point names to { action, ... }');
  const normalized = {};
  for (const [name, rule] of Object.entries(points)) {
    if (!names.includes(name)) throw bad(`Unknown fail point ${name}`);
    if (!rule || typeof rule !== 'object') throw bad(`Fail point ${name} needs { action }`);
    const { action, ms, nth, p, count, ...rest } = rule;
    if (Object.keys(rest).length) throw bad(`Fail point ${name} has unknown settings: ${Object.keys(rest).join(', ')}`);
    if (!FAILPOINT_ACTIONS.includes(action)) throw bad(`Fail point ${name} action must be one of ${FAILPOINT_ACTIONS.join(', ')}`);
    if (action === 'delay' ? !(Number.isInteger(ms) && ms >= 0 && ms <= MAX_FAILPOINT_DELAY_MS) : ms !== undefined) {
      throw bad(action === 'delay' ? `Fail point ${name} delay needs ms: 0..${MAX_FAILPOINT_DELAY_MS}` : `Fail point ${name}: only a delay takes ms`);
    }
    if (nth !== undefined && !(Number.isInteger(nth) && nth >= 1)) throw bad(`Fail point ${name} nth must be a positive integer`);
    if (p !== undefined && !(typeof p === 'number' && p >= 0 && p <= 1)) throw bad(`Fail point ${name} p must be 0..1`);
    if (count !== undefined && !(Number.isInteger(count) && count >= 1)) throw bad(`Fail point ${name} count must be a positive integer`);
    normalized[name] = {
      action,
      ...(ms !== undefined ? { ms } : {}),
      ...(nth !== undefined ? { nth } : {}),
      ...(p !== undefined ? { p } : {}),
      ...(count !== undefined ? { count } : {}),
    };
  }
  return { ...(id !== undefined ? { id: String(id) } : {}), seed, points: normalized };
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

/** The crash a journal records for process `pid`, if a fail point killed it: its last crash trigger. */
export function crashInJournal(entries, pid) {
  return entries.findLast((entry) => entry.pid === pid && entry.action === 'crash' && !entry.skipped) ?? null;
}

/**
 * Hit counting and trigger decisions for one node. `arm(spec, journalEntries)` loads a spec (null disarms) and
 * restarts the hit counts; triggers the journal already records for that spec count against `count`, so a crash with
 * `count: 1` does not fire again in the process that replaces the killed one. `hit(name, { sync })` returns
 * `{ point, hit, first, trigger }`: `first` on the first hit of a point in this process, `trigger` null or
 * `{ action, ms?, skipped? }`. A delay on a sync point cannot wait: it is returned as `skipped`, and still counts.
 */
export function createFailpointRegistry() {
  let spec = null;
  let hits = {};
  let triggers = {};
  let streams = {};
  const reached = new Set();
  const total = {};
  return {
    arm(next, journalEntries = []) {
      spec = next && Object.keys(next.points ?? {}).length ? next : null;
      hits = {};
      streams = {};
      triggers = spec ? triggersInJournal(journalEntries, spec.id) : {};
    },
    spec: () => spec,
    /** Hits per point since the process started, across armings: what the catalog's `hits` are measured from. */
    totals: () => ({ ...total }),
    hit(name, { sync = false } = {}) {
      total[name] = (total[name] ?? 0) + 1;
      const first = !reached.has(name);
      reached.add(name);
      const rule = spec?.points[name];
      if (!rule) return { point: name, hit: total[name], first, trigger: null };
      const hit = (hits[name] = (hits[name] ?? 0) + 1);
      const fired = triggers[name] ?? 0;
      // A stream per point and per earlier trigger: a restarted node does not replay the draws that led to its crash.
      const random = rule.p === undefined ? null : (streams[name] ??= createPrng(derive(spec.seed, `${name}#${fired}`)));
      // Drawn on every hit, so the hit a `p` picks does not depend on `nth` or `count`.
      const chance = random ? random() < rule.p : true;
      const limit = rule.count ?? (rule.action === 'crash' ? 1 : Infinity);
      if (fired >= limit || !chance || (rule.nth !== undefined && hit !== rule.nth)) return { point: name, hit, first, trigger: null };
      triggers[name] = fired + 1;
      const skipped = rule.action === 'delay' && sync;
      return { point: name, hit, first, trigger: { action: rule.action, ...(rule.ms !== undefined ? { ms: rule.ms } : {}), ...(skipped ? { skipped: 'sync point' } : {}) } };
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

/** Whether a journal records that `point` triggered `action` (and, for a crash, killed the process). */
export function triggeredInJournal(entries, point, action) {
  return entries.some((entry) => entry.point === point && entry.action === action && !entry.skipped);
}

/** `who` of a node as a file name: `buyer`, `seller:<id>` → `seller-<id>`. */
export function failpointFileName(who) {
  if (who !== 'buyer' && !/^seller:[a-z0-9][a-z0-9-]{0,23}$/.test(who)) throw Object.assign(new Error(`Fail points belong to buyer or seller:<id>, not ${who}`), { statusCode: 404 });
  return `${who.replace(':', '-')}.json`;
}

/** The journal next to a node's spec file. */
export const failpointJournalPath = (specPath) => specPath.replace(/\.json$/, '.journal.jsonl');

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
