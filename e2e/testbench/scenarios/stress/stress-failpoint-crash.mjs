import { failpointCoverage } from '../../lib/crashes-and-delays.mjs';
import { armedSpec, countsInJournal, crashSpec, drawLoadCrash, triggeredInJournal } from '../../lib/failpoints.mjs';
import { createPrng, derive } from '../../lib/prng.mjs';
import { GATES, stressRun, stressTopology, warmUp } from '../../lib/stress.mjs';

export const meta = {
  description: 'One seeded crash at a fail point per run, on a 0.25 USDC reserve: the seed draws a point the payment path reaches under load (a store write, a NeedAuth or SpendingAuth step, the reserve or top-up transaction), the node it belongs to (seller or buyer) and the hit at which that node is killed (SIGKILL) there. The supervisor starts the node again, 160 requests run 16-way around it, the point must be seen firing, nothing may fail outside the restart window, and the oracle judges the money (stress failpoint-crash). Run it across seeds.',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'buyerControl', 'mockControl', 'failpoints'],
};

export const topology = stressTopology({ failpoints: true, buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' } });

const NODES = { seller: 'seller:seller', buyer: 'buyer' };

/** What this scenario arms for a run seed, without a testbench (`pnpm testbench plan`). */
export function failpointPlan(seed) {
  const plan = drawLoadCrash(createPrng(derive(seed, 'failpoint')));
  return { plan, specs: { [NODES[plan.who]]: armedSpec(seed, NODES[plan.who], crashSpec(plan)) } };
}

export async function run(tb) {
  const { plan, specs } = failpointPlan(tb.seed);
  const who = NODES[plan.who];
  tb.metric('failpointPlan', plan);
  await tb.event('failpoint-plan', plan);
  console.log(`[failpoint] plan: crash the ${plan.who} at ${plan.point} hit ${plan.nth}`);
  // Armed before the warm-up: a point reached once per channel (the reserve) fires there, the others under load.
  // The arming's id scopes every piece of evidence below: a reused testbench keeps earlier crashes and journal lines.
  const { id: specId } = await tb.faults.failpoints(who, specs[who]);
  try {
    await stressRun(tb, {
      load: { concurrency: 16, requests: 160, failpointCrash: { who, specIds: [specId] } },
      gate: GATES['failpoint-crash'],
      afterLoad: async (run) => {
        // A crash in the load's last payments, or before the load (the warm-up), is not in the load's own record yet.
        // No crash at all leaves the run as it is: the evidence below fails it.
        const late = run.restart ? null : await tb.faults.waitForFailpointRestart(who, { specId, timeoutMs: 30_000 }).catch(() => null);
        // One more paid request once the node is back: after a crash near the end of the load nothing else would
        // reconnect the two, and the buyer and seller must be able to go on with each other, not only to close.
        if (run.restart || late) await warmUp(tb, undefined, 'after-restart');
        return late ? tb.withFailpointRestart(run, late) : run;
      },
      evidence: async ({ run }) => {
        const journal = await tb.faults.failpointJournal(who);
        tb.metric('failpointCoverage', failpointCoverage({ [plan.who]: [plan.point] }, await tb.faults.failpointCrashes({ specIds: [specId] })));
        return [
          { name: `fault path ran: fail point ${plan.point} fired on the ${plan.who}`, ok: triggeredInJournal(journal, plan.point, 'crash', specId), detail: journal.filter((entry) => entry.action && entry.spec === specId) },
          { name: `fault path ran: the ${plan.who} was killed at the fail point and started again`, ok: run.restart?.failpoint === plan.point && run.restart.crashed === true, detail: run.restart ?? 'no restart recorded' },
        ];
      },
    });
  } finally {
    // Clearing makes a node write its hit counts (it looks at its spec file once a second when idle).
    for (const node of Object.values(NODES)) await tb.faults.clearFailpoints(node);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    // How often the nodes now running reached each point (a killed node's counts die with it).
    tb.metric('failpointHits', Object.fromEntries(await Promise.all(Object.values(NODES).map(async (node) => [node, countsInJournal(await tb.faults.failpointJournal(node))]))));
  }
}
