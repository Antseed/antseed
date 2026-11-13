// Crashes and delays: every load-phase fail point of a node armed at once with a seeded chance to kill it, no cap on
// the crashes (one node down at a time and a grace window after each restart set the rate), a drawn time down, delays
// at the points that can wait, and the seller's settle and close points armed through the close. Shared by
// stress-crashes-and-delays (seller) and stress-crashes-and-delays-both (seller and buyer).
import { armedSpec, closeCrashCandidates, crashesAndDelaysSpec, crashesInJournal, delaysInJournal, drawCrashesAndDelaysPlan, POINT_CATALOG, pointsOfNode } from './failpoints.mjs';
import { createPrng, derive } from './prng.mjs';
import { closeWhenReachable, crashesDuringLoad, crashesGate, stressRun, stressTopology, warmUp } from './stress.mjs';

export const CRASH_NODES = { seller: 'seller:seller', buyer: 'buyer' };
/** Long enough for several crashes: about two minutes of traffic around them (measured, see the README). */
export const CRASHES_AND_DELAYS_LOAD = { concurrency: 16, requests: 480 };
/** The last payments of a load are stored within a few seconds; a crash they trigger comes in that time. */
const SETTLE_MS = 5000;
/** The seller's idle settle comes 15 s after the last request: the close phase waits for it, so `chain.settle.*` is reached armed. */
const IDLE_SETTLE_MS = 20_000;
const RESTART_TIMEOUT_MS = 180_000;
/** A bound on the time, not on the crashes: after this many rounds the points are disarmed and the nodes left to finish. */
const MAX_ROUNDS = 8;
const MAX_CLOSE_ROUNDS = 5;

export const crashesAndDelaysTopology = () => stressTopology({ failpoints: true, buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' } });

/** The close phase's chance per hit of a settle, close or store point: 0.04 to 0.10, from the seed. */
export function drawClosePhasePlan(random) {
  return { p: (4 + Math.floor(random() * 7)) / 100 };
}

/**
 * The spec the seller carries through the settle and the close: a crash rule with the plan's `p` on every point only
 * settling or closing reaches and on the store writes, the seller's delays in front of it at the points that can wait,
 * and the seller's time down and grace.
 */
export function closePhaseSpec(closePlan, sellerPlan, { catalog = POINT_CATALOG } = {}) {
  const points = {};
  for (const { point } of closeCrashCandidates(catalog)) {
    const crash = { action: 'crash', p: closePlan.p };
    points[point] = catalog[point].sync ? crash : [{ action: 'delay', ms: sellerPlan.delay.msRange, p: sellerPlan.delay.p }, crash];
  }
  return { points, graceMs: sellerPlan.graceMs, restartDelayMs: sellerPlan.restartDelayMs };
}

/**
 * Everything a crashes-and-delays run arms, from the run seed alone: `{ plan, specs: { '<who>': spec }, closeSpec }`
 * (`plan.close` is the close phase's). The same seed gives the same plan and specs in every run; `pnpm testbench plan`
 * prints it. `keyed: true` makes the crash rules of the points that carry a payment step's key decide by that step
 * instead of by the hit (allPointsSpec); the shipped scenarios decide by the hit.
 */
export function crashesAndDelaysPlan(seed, { nodes, requests = CRASHES_AND_DELAYS_LOAD.requests, keyed = false }) {
  const prng = (label) => createPrng(derive(seed, label));
  const drawn = drawCrashesAndDelaysPlan(prng('crashes-and-delays'), { nodes });
  const close = drawClosePhasePlan(prng('crashes-and-delays-close'));
  const specs = Object.fromEntries(nodes.map((node) => [CRASH_NODES[node], armedSpec(seed, CRASH_NODES[node], crashesAndDelaysSpec(node, drawn[node], { requests, keyed }))]));
  // Its own seed: the close phase's draws do not repeat the load phase's at the store points.
  const closeSpec = { ...closePhaseSpec(close, drawn.seller), seed: derive(seed, `failpoints:${CRASH_NODES.seller}:close`) };
  return { plan: { ...drawn, close }, specs, closeSpec };
}

/** One line for the console and the sweep: what is armed on each node, without the per-point numbers. */
export function crashesPlanLine(plan) {
  const { close, ...nodes } = plan;
  const perNode = Object.entries(nodes).map(([node, entry]) => `${node}: ${pointsOfNode(node).length} points, about ${entry.expectedCrashes} crashes drawn, no cap, grace ${entry.graceMs.join('-')} ms, down ${entry.restartDelayMs.join('-')} ms, delays p=${entry.delay.p} ${entry.delay.msRange.join('-')} ms`);
  return [...perNode, ...(close ? [`close: p=${close.p}`] : [])].join('; ');
}

/** What fired, for the same line: `seller store.after-write@31 (down 4200 ms), ...; 1 in the close; 0 overlapped; 5 delays`. */
export function crashesFiredLine(crashes, delays, closeCrashes = []) {
  const fired = [...crashes, ...closeCrashes].map((crash) => `${crash.who.split(':')[0]} ${crash.point}@${crash.hit}${crash.restartedAt ? ` (down ${Date.parse(crash.restartedAt) - Date.parse(crash.at)} ms${crash.overlapped ? ', overlapped' : ''})` : ' (not restarted)'}`);
  const delayed = Object.values(delays).reduce((sum, perPoint) => sum + Object.values(perPoint).reduce((a, b) => a + b, 0), 0);
  const total = crashes.length + closeCrashes.length;
  const overlapped = [...crashes, ...closeCrashes].filter((crash) => crash.overlapped).length;
  return `${total} crash${total === 1 ? '' : 'es'}${fired.length ? `: ${fired.join(', ')}` : ''}; ${closeCrashes.length} in the close; ${overlapped} overlapped; ${delayed} delay${delayed === 1 ? '' : 's'}`;
}

/**
 * The run's evidence checks, from what the supervisor recorded (`crashes`, of this run's armings only, close phase
 * included) and what the nodes' journals hold for those armings (`journalCrashes`): at least one crash fired, and
 * every crash the journals hold was recorded by the supervisor and followed by a restart.
 */
export function crashesEvidence({ crashes, journalCrashes }) {
  const summary = crashes.map(({ who, point, hit, at, restartDelayMs, graceMs, restartedAt, restartError, overlapped }) => ({ who, point, hit, at, restartDelayMs, graceMs, restartedAt, ...(overlapped ? { overlapped } : {}), ...(restartError ? { restartError } : {}) }));
  return [
    { name: 'fault path ran: at least one fail point crash fired', ok: crashes.length > 0 && journalCrashes > 0, detail: { crashes: summary, journalCrashes } },
    { name: 'fault path ran: every fail point crash was followed by a restart', ok: journalCrashes === crashes.length && crashes.every((crash) => crash.restartedAt), detail: { crashes: summary, journalCrashes } },
  ];
}

/** What a run covered, for a sweep's summary: the points armed per node and where a crash fired (`who` without the seller id). */
export function failpointCoverage(armed, crashes) {
  return { armed, crashes: crashes.map((crash) => ({ node: crash.who.split(':')[0], point: crash.point })) };
}

/**
 * Runs crashes and delays on `nodes` (['seller'] or ['seller', 'buyer']): arms each node's part of the seeded plan
 * before the warm-up request, runs the load around the crashes, sends one more paid request after the last restart,
 * then keeps the seller's settle and close points armed through its idle settle and the close (repeated after a crash,
 * like stress-failpoint-close), disarms, and lets stressRun judge: the oracle with its restart bounds, the crash and
 * isolation checks, the evidence above and a gate sized by the crashes that fired during the load. All evidence is
 * scoped to the specs armed here, by id.
 */
export async function crashesAndDelays(tb, { nodes }) {
  const { plan, specs, closeSpec } = crashesAndDelaysPlan(tb.seed, { nodes });
  const line = crashesPlanLine(plan);
  console.log(`[failpoint] plan: crashes and delays on ${line} ${JSON.stringify(plan)}`);
  await tb.event('crashes-and-delays-plan', { plan });
  const armed = {};
  for (const node of nodes) armed[node] = await tb.faults.failpoints(CRASH_NODES[node], specs[CRASH_NODES[node]]);
  const who = nodes.map((node) => CRASH_NODES[node]);
  const specIds = Object.values(armed).map((spec) => spec.id);
  let closeId = null;
  const clear = async () => { for (const node of who) await tb.faults.clearFailpoints(node); };
  const settled = (ids = specIds) => tb.faults.waitForFailpointRestarts({ specIds: ids, timeoutMs: RESTART_TIMEOUT_MS });
  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const gateFor = (crashes) => crashesGate({ crashes, concurrency: CRASHES_AND_DELAYS_LOAD.concurrency, requests: CRASHES_AND_DELAYS_LOAD.requests });
  let crashes = [];
  let closeCrashes = [];
  let closeAttempts = 0;
  let disarmed = false;
  // What went wrong between the load and the judging (a node that never came back, a request that never went through
  // after a restart): kept so the oracle still runs, and failed as a check of its own in the evidence.
  let phaseError = null;
  try {
    await stressRun(tb, {
      load: { ...CRASHES_AND_DELAYS_LOAD, failpointCrash: { who, specIds } },
      gate: gateFor(0),
      afterLoad: async (run) => {
        // The points stay armed while the nodes meet again: a paid request after a restart can itself be the next
        // crash (not one right after a kill: the grace window covers it). Repeat until one went through and nothing fired.
        let met = 0;
        let error = null;
        try {
          for (let round = 0; round < MAX_ROUNDS; round += 1) {
            await sleep(SETTLE_MS);
            crashes = await settled();
            if (crashes.length === met) break;
            met = crashes.length;
            // One more paid request once the nodes are back: after a crash near the end of the load nothing else
            // would reconnect the two, and they must be able to go on with each other, not only to close.
            await warmUp(tb, undefined, `after-restart-${round}`);
          }
          // The close phase: the buyer is disarmed, the seller trades its load points for the settle, close and store
          // points, and stays armed through its idle settle and every close attempt.
          if (armed.buyer) await tb.faults.clearFailpoints(CRASH_NODES.buyer);
          crashes = await settled();
          closeId = (await tb.faults.failpoints(CRASH_NODES.seller, closeSpec)).id;
          await sleep(IDLE_SETTLE_MS);
          for (let round = 0, seen = -1; round < MAX_CLOSE_ROUNDS; round += 1) {
            closeCrashes = await settled([closeId]);
            if (closeCrashes.length === seen) break;
            seen = closeCrashes.length;
            const close = await closeWhenReachable(tb);
            closeAttempts += close.attempts + (close.closed ? 0 : 1);
            await sleep(1000);
          }
        } catch (caught) {
          error = caught;
        }
        await clear();
        disarmed = true;
        // A crash between the last look and the disarming: wait for it, and let the nodes meet once more, unarmed.
        await sleep(1000);
        const all = [...specIds, ...(closeId ? [closeId] : [])];
        const before = crashes.length + closeCrashes.length;
        const final = await settled(all).catch((caught) => { error ??= caught; return tb.faults.failpointCrashes({ specIds: all }); });
        crashes = final.filter((crash) => specIds.includes(crash.spec));
        closeCrashes = final.filter((crash) => crash.spec === closeId);
        if (!error && final.length !== before) await closeWhenReachable(tb);
        if (error) await tb.event('crashes-and-delays-error', { error: error.message });
        phaseError = error;
        const inLoad = crashesDuringLoad(crashes, run).length;
        tb.metric('crashesDuringLoad', inLoad);
        return tb.withFailpointRestart({ ...run, gate: gateFor(inLoad) }, final.filter((crash) => crash.restartedAt));
      },
      evidence: async () => {
        // The nodes write their delay totals when the spec is cleared (they look at the file once a second when idle).
        await sleep(1500);
        const journals = Object.fromEntries(await Promise.all(nodes.map(async (node) => [node, await tb.faults.failpointJournal(CRASH_NODES[node])])));
        const ids = (node) => [armed[node].id, ...(node === 'seller' && closeId ? [closeId] : [])];
        const all = [...specIds, ...(closeId ? [closeId] : [])];
        const recorded = await tb.faults.failpointCrashes({ specIds: all });
        crashes = recorded.filter((crash) => specIds.includes(crash.spec));
        closeCrashes = recorded.filter((crash) => crash.spec === closeId);
        const journalCrashes = nodes.reduce((sum, node) => sum + ids(node).reduce((count, id) => count + crashesInJournal(journals[node], id).length, 0), 0);
        const delays = Object.fromEntries(nodes.map((node) => [node, ids(node).reduce((totals, id) => { for (const [point, count] of Object.entries(delaysInJournal(journals[node], id))) totals[point] = (totals[point] ?? 0) + count; return totals; }, {})]));
        const overlapped = recorded.filter((crash) => crash.overlapped).length;
        tb.metric('crashesAndDelays', { plan, specIds, closeSpecId: closeId, crashes, closeCrashes, closeAttempts, overlapped, delays });
        const armedPoints = Object.fromEntries(nodes.map((node) => [node, [...new Set([...Object.keys(specs[CRASH_NODES[node]].points), ...(node === 'seller' && closeId ? Object.keys(closeSpec.points) : [])])]]));
        tb.metric('failpointCoverage', failpointCoverage(armedPoints, recorded));
        await tb.event('crashes-and-delays', { crashes, closeCrashes, overlapped, delays });
        // The sweep shows a run's last plan line: this one adds what fired.
        console.log(`[failpoint] plan: crashes and delays on ${line} -> ${crashesFiredLine(crashes, delays, closeCrashes)} ${JSON.stringify({ plan, crashes, closeCrashes })}`);
        return [
          ...crashesEvidence({ crashes: recorded, journalCrashes }),
          { name: 'after every restart a paid request went through, and the settle and close phase ran to its end', ok: phaseError === null, detail: { error: phaseError?.message ?? null } },
        ];
      },
    });
  } finally {
    if (!disarmed) await clear().catch(() => {});
  }
}
