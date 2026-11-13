import { CRASH_NODES, crashesAndDelaysTopology, failpointCoverage } from '../../lib/crashes-and-delays.mjs';
import { correlatedCrashSpecs, crashesInJournal, downWindowsOverlap, drawCorrelatedCrash } from '../../lib/failpoints.mjs';
import { crashesDuringLoad, crashesGate, stressRun, warmUp } from '../../lib/stress.mjs';

export const meta = {
  description: 'Buyer and seller down together, on purpose, at the same payment step, on a 0.25 USDC reserve: both are armed with one seed and a keyed crash on a SpendingAuth, the buyer right after it sent one and the seller right after it verified one. The key is the channel and the cumulative amount, so both pick the same SpendingAuth: the seller is killed (SIGKILL) the moment it has verified it, and the buyer, which marked it when it sent it, as soon as it sees the seller down. The supervisor starts both again, 160 requests run 16-way around it, both crashes must be seen firing at the same key with overlapping down windows, nothing may fail outside the restart windows, and the oracle judges the money (stress crashes-correlated). Run it across seeds.',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'buyerControl', 'mockControl', 'failpoints'],
};

export const topology = crashesAndDelaysTopology();

const LOAD = { concurrency: 16, requests: 160 };
const RESTART_TIMEOUT_MS = 180_000;

/** What this scenario arms for a run seed, without a testbench (`pnpm testbench plan`). */
export function failpointPlan(seed) {
  const plan = drawCorrelatedCrash(seed);
  const specs = correlatedCrashSpecs(plan, CRASH_NODES);
  return { plan, specs: Object.fromEntries(Object.entries(specs).map(([node, spec]) => [CRASH_NODES[node], spec])) };
}

export async function run(tb) {
  const { plan, specs } = failpointPlan(tb.seed);
  const line = `buyer and seller at the same SpendingAuth (${plan.buyerPoint} and ${plan.sellerPoint}, one key in about ${Math.round(1 / plan.p)})`;
  tb.metric('failpointPlan', plan);
  await tb.event('failpoint-plan', plan);
  console.log(`[failpoint] plan: correlated crash of ${line}`);
  const who = [CRASH_NODES.seller, CRASH_NODES.buyer];
  const armed = {};
  for (const node of who) armed[node] = await tb.faults.failpoints(node, specs[node]);
  const specIds = who.map((node) => armed[node].id);
  const gateFor = (crashes) => crashesGate({ crashes, ...LOAD });
  let crashes = [];
  try {
    await stressRun(tb, {
      load: { ...LOAD, failpointCrash: { who, specIds } },
      gate: gateFor(0),
      afterLoad: async (run) => {
        crashes = await tb.faults.waitForFailpointRestarts({ specIds, timeoutMs: RESTART_TIMEOUT_MS }).catch(() => tb.faults.failpointCrashes({ specIds }));
        // One more paid request once both are back: they must be able to go on with each other, not only to close.
        if (crashes.length && crashes.every((crash) => crash.restartedAt)) await warmUp(tb, undefined, 'after-restart');
        for (const node of who) await tb.faults.clearFailpoints(node);
        return tb.withFailpointRestart({ ...run, gate: gateFor(crashesDuringLoad(crashes, run).length) }, crashes.filter((crash) => crash.restartedAt));
      },
      evidence: async () => {
        crashes = await tb.faults.failpointCrashes({ specIds });
        const of = (node) => crashes.filter((crash) => crash.who === CRASH_NODES[node]);
        const [seller] = of('seller');
        const [buyer] = of('buyer');
        const journals = Object.fromEntries(await Promise.all(who.map(async (node) => [node, crashesInJournal(await tb.faults.failpointJournal(node), armed[node].id)])));
        const overlap = Boolean(seller && buyer) && downWindowsOverlap(seller, buyer);
        const sameStep = Boolean(seller && buyer) && seller.key !== undefined && seller.key === buyer.key;
        const overlapMs = overlap ? Math.min(Date.parse(seller.restartedAt), Date.parse(buyer.restartedAt)) - Math.max(Date.parse(seller.at), Date.parse(buyer.at)) : 0;
        tb.metric('crashesCorrelated', { plan, specIds, crashes, overlap, overlapMs, sameStep, key: sameStep ? seller.key : null });
        tb.metric('failpointCoverage', failpointCoverage({ seller: Object.keys(specs[CRASH_NODES.seller].points), buyer: Object.keys(specs[CRASH_NODES.buyer].points) }, crashes));
        console.log(`[failpoint] plan: correlated crash of ${line} -> ${crashes.map((crash) => `${crash.who.split(':')[0]} ${crash.point}@${crash.hit}${crash.restartedAt ? ` (down ${Date.parse(crash.restartedAt) - Date.parse(crash.at)} ms)` : ' (not restarted)'}`).join(', ') || 'no crash'}; ${sameStep ? 'the same step' : 'not the same step'}; ${overlap ? `down together for ${overlapMs} ms` : 'not down together'}`);
        const brief = (list) => list.map(({ who: node, point, hit, key, at, restartedAt, overlapped }) => ({ who: node, point, hit, key, at, restartedAt, overlapped }));
        return [
          { name: 'fault path ran: a fail point killed the buyer and the seller, once each', ok: of('seller').length === 1 && of('buyer').length === 1 && journals[CRASH_NODES.seller].length === 1 && journals[CRASH_NODES.buyer].length === 1, detail: brief(crashes) },
          { name: `fault path ran: both were killed at the same payment step (the same SpendingAuth, at ${plan.buyerPoint} and ${plan.sellerPoint})`, ok: sameStep && buyer.point === plan.buyerPoint && seller.point === plan.sellerPoint, detail: brief(crashes) },
          { name: 'fault path ran: both nodes were down at the same time (the supervisor saw one die while the other was down) and both were started again', ok: overlap && crashes.some((crash) => crash.overlapped) && crashes.every((crash) => crash.restartedAt), detail: brief(crashes) },
        ];
      },
    });
  } finally {
    for (const node of who) await tb.faults.clearFailpoints(node).catch(() => {});
  }
}
