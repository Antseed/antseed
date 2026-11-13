import { failpointCoverage } from '../../lib/crashes-and-delays.mjs';
import { armedSpec, crashSpec, drawCloseCrash, triggeredInJournal } from '../../lib/failpoints.mjs';
import { createPrng, derive } from '../../lib/prng.mjs';
import { closeWhenReachable, GATES, runAll, stressTopology, STRESS_MODEL, warmUp } from '../../lib/stress.mjs';

export const meta = {
  description: 'One seeded seller crash at a fail point that only settling or closing reaches, on a 0.25 USDC reserve: after a small load the seed draws a point (before or after the settle or close transaction is sent, after its receipt, or a store write of the close) and the seller is killed (SIGKILL) there, with the transaction unsent, in flight or mined but not yet recorded. The supervisor starts the seller again, the point must be seen firing, and the oracle then closes whatever is still open and judges the money (stress failpoint-close). Run it across seeds.',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'mockControl', 'failpoints'],
};

export const topology = stressTopology({ failpoints: true, buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' } });

const WHO = 'seller:seller';
// The last SpendingAuths of the load are stored within a few seconds; the seller's idle settle comes 15 s after the last request.
const QUIESCE_MS = 5000;
const CLOSE_AFTER_RESTART_MS = 120_000;

/** What this scenario arms for a run seed, without a testbench (`pnpm testbench plan`). */
export function failpointPlan(seed) {
  const plan = drawCloseCrash(createPrng(derive(seed, 'failpoint')));
  return { plan, specs: { [WHO]: armedSpec(seed, WHO, crashSpec(plan)) } };
}

export async function run(tb) {
  const { plan, specs } = failpointPlan(tb.seed);
  // settle() is what the seller's idle timer sends; close() and the store writes around it follow a close request.
  const trigger = plan.point.startsWith('chain.settle.') ? 'idle-settle' : 'close';
  tb.metric('failpointPlan', { ...plan, trigger });
  await tb.event('failpoint-plan', { ...plan, trigger });
  console.log(`[failpoint] plan: crash the seller at ${plan.point} hit ${plan.nth} (${trigger})`);

  const before = await tb.paymentSnapshot();
  await warmUp(tb);
  const load = await tb.load({ model: STRESS_MODEL, concurrency: 8, requests: 32, gate: GATES.default });
  await new Promise((resolveWait) => setTimeout(resolveWait, QUIESCE_MS));

  let crash = null;
  let closeError = null;
  let specId;
  try {
    // The arming's id scopes the evidence: a reused testbench keeps earlier crashes and journal lines.
    ({ id: specId } = await tb.faults.failpoints(WHO, specs[WHO]));
    // The seller dies in the middle of this close, so the close request itself may fail; the oracle closes again below.
    if (trigger === 'close') await tb.closeAll().catch((error) => { closeError = error.message; });
    crash = await tb.faults.waitForFailpointRestart(WHO, { specId, timeoutMs: 90_000 }).catch(() => null);
  } finally {
    await tb.faults.clearFailpoints(WHO);
  }
  if (closeError) await tb.event('close-during-crash', { error: closeError });

  // No request follows the restart, so the buyer has to find the seller again by itself, and it does not look for a
  // seller it just failed to reach for about 30 s. Close as soon as it can; if it never can, the oracle's own close
  // fails below and says why.
  if (crash) {
    const close = await closeWhenReachable(tb, { timeoutMs: CLOSE_AFTER_RESTART_MS });
    tb.metric('closeAttemptsAfterRestart', close.attempts + (close.closed ? 0 : 1));
    if (close.attempts > 1 || !close.closed) await tb.event('close-after-restart-retried', { attempts: close.attempts - (close.closed ? 1 : 0), lastError: close.lastError });
  }

  await runAll([
    // The load was fault-free and over before the point was armed, so the oracle's exact rule holds: what the seller
    // recorded as spent equals what was delivered. The crash only hits the settle or close of that finished work.
    () => tb.assertDeliveredWorkPaid({ before, results: load.results }),
    () => tb.assertNoCrashes(),
    async () => tb.metric('failpointCoverage', failpointCoverage({ seller: [plan.point] }, await tb.faults.failpointCrashes({ specIds: [specId] }))),
    async () => {
      const journal = await tb.faults.failpointJournal(WHO);
      tb.check(`fault path ran: fail point ${plan.point} fired on the seller`, triggeredInJournal(journal, plan.point, 'crash', specId), journal.filter((entry) => entry.action && entry.spec === specId));
    },
    () => tb.check('fault path ran: the seller was killed at the fail point and started again', crash?.point === plan.point && crash.spec === specId && Boolean(crash.restartedAt), crash ?? 'no fail point crash recorded'),
    () => tb.checkGate(load),
  ]);
}
