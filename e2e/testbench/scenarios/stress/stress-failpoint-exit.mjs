// The buyer's unilateral exit under crashes, through the real CLI (modelled on features/buyer-withdraw-and-exit): after
// paid traffic the seller is killed and stays down, and each of the two one-shot commands of the exit is killed
// (SIGKILL) at one drawn fail point of its transaction: nothing sent yet, broadcast, or mined. The command is then run
// again, as a user would after seeing it die, until the step is done. Each step is compared with the chain.
//
// The commands are processes of their own, not the buyer node: tb.cli({ failpoints }) preloads the fail point handler
// into them with a spec and a journal per command. A command a fail point killed died of SIGKILL with the trigger in
// its journal (result.failpoint.crash); anything else is the command's own failure.
import { failpointCoverage } from '../../lib/crashes-and-delays.mjs';
import { armedSpec, crashSpec, drawExitCrashes } from '../../lib/failpoints.mjs';
import { createPrng, derive } from '../../lib/prng.mjs';
import { runAll } from '../../lib/stress.mjs';

export const meta = {
  description: 'The buyer\'s unilateral exit under crashes (cli mode, local): after paid traffic the seller is killed and stays down; antseed buyer channels request-close is killed (SIGKILL) at one drawn chain.request-close.* fail point and run again until the close request is on chain exactly once; after the 15 min grace antseed buyer channels withdraw is killed at one drawn chain.withdraw.* point and run again until the channel has timed out. Both points must be seen firing, each step must match the chain, and at the end the money adds up to the original deposit with no reserve left. Run it across seeds.',
  targets: ['local'],
  requires: ['mockControl', 'sellerControl', 'warpTime', 'failpoints'],
  covers: ['unilateral exit request-close, grace, withdraw through the buyer CLI under a crash (apps/cli/src/cli/commands/buyer/channel-withdraw.ts)'],
};

export const topology = { mode: 'cli', sellers: [{ id: 'seller' }] };

/** AntseedChannels.TIMEOUT_GRACE_PERIOD. */
const GRACE_SECONDS = 15 * 60;
/** A user runs a command again a few seconds after it died, not in the same instant: a broadcast transaction is mined by then. */
const RERUN_AFTER_MS = 3000;
const MAX_RERUNS = 3;
const PAID_CHATS = 3;

/** What this scenario arms for a run seed, without a testbench (`pnpm testbench plan`). */
export function failpointPlan(seed) {
  const plan = drawExitCrashes(createPrng(derive(seed, 'failpoint-exit')));
  return { plan, specs: { 'cli:request-close': armedSpec(seed, 'cli:1', crashSpec({ point: plan.requestClose, nth: 1 })), 'cli:withdraw': armedSpec(seed, 'cli:2', crashSpec({ point: plan.withdraw, nth: 1 })) } };
}

const amounts = (balance) => ({ available: String(balance.available), reserved: String(balance.reserved) });
const tail = (result) => ({ code: result.code, signal: result.signal, json: result.json, stdout: result.stdout.slice(-300), stderr: result.stderr.slice(-300) });
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export async function run(tb) {
  const { plan } = failpointPlan(tb.seed);
  tb.metric('failpointPlan', plan);
  await tb.event('failpoint-plan', plan);
  console.log(`[failpoint] plan: kill request-close at ${plan.requestClose} and withdraw at ${plan.withdraw}`);
  const sellerId = tb.sellers[0].id;
  const model = tb.sellers[0].models[0];
  const buyer = tb.manifest.buyer.address;
  const deposit = BigInt(tb.manifest.depositMicros);
  const fired = [];

  for (let index = 0; index < PAID_CHATS; index += 1) await tb.chat({ model, sellerId, prompt: `paid chat ${index + 1} before the buyer leaves` });
  const channel = await tb.waitFor(async () => {
    const rows = (await tb.request('/_antseed/channels')).json?.channels ?? [];
    return rows.find((row) => row.status === 'active' && BigInt(row.cumulativeSigned ?? '0') > 0n && (row.requestCount ?? 0) >= PAID_CHATS);
  }, 'a signed, active channel', { timeoutMs: 30_000 });
  const channelId = channel.channelId;
  const opened = await tb.channelState(channelId);
  const start = await tb.buyerBalance();
  tb.check('the paid chats opened a channel whose reserve is locked on-chain', opened.status === 1 && BigInt(opened.deposit) > 0n && start.reserved === BigInt(opened.deposit) && start.available + start.reserved === deposit, { channel: opened, balance: amounts(start) });

  // The seller dies without settling or closing and stays down: the buyer has to leave on its own.
  await tb.crashSeller(sellerId);
  const orphaned = await tb.channelState(channelId);
  tb.check('the crashed seller left the channel open on-chain, no close requested', orphaned.status === 1 && orphaned.closeRequestedAt === 0, orphaned);

  /**
   * One step of the exit: the command killed at `point`, the chain compared with what that point leaves behind, then
   * the command run again until it exits 0 or `done()` says the step is on chain. Returns the reruns and the count of
   * transactions the buyer sent in the step.
   */
  const step = async (name, args, point, { options = {}, sentAfterCrash, done }) => {
    const nonceBefore = await tb.transactionCount(buyer);
    const killed = await tb.cli(args, { ...options, failpoints: crashSpec({ point, nth: 1 }) });
    const crash = killed.failpoint.crash;
    if (crash) fired.push({ who: 'buyer', point: crash.point });
    tb.check(`fault path ran: ${name} was killed at ${point} (SIGKILL, the trigger in its journal)`, killed.signal === 'SIGKILL' && crash?.point === point && crash.hit === 1, { ...tail(killed), journal: killed.failpoint.journal });
    // Before the send nothing may be on chain; after it the transaction is out and gets mined without the command.
    const sent = !point.endsWith('.before-send');
    const mined = sent ? await tb.waitFor(async () => (await tb.transactionCount(buyer)) === nonceBefore + 1 && done(), `the ${name} transaction the killed command had sent to be mined`, { timeoutMs: 20_000, intervalMs: 500 }).then(() => true, () => false) : false;
    const afterCrash = await tb.channelState(channelId);
    tb.check(`${name} killed at ${point}: ${sent ? 'its transaction is mined although the command died' : 'nothing was sent'}`, sent ? mined && sentAfterCrash(afterCrash) : (await tb.transactionCount(buyer)) === nonceBefore && !sentAfterCrash(afterCrash), { channel: afterCrash, transactionsSent: (await tb.transactionCount(buyer)) - nonceBefore });
    const reruns = [];
    for (let attempt = 0; attempt < MAX_RERUNS; attempt += 1) {
      await sleep(RERUN_AFTER_MS);
      const again = await tb.cli(args, options);
      reruns.push(tail(again));
      if (again.code === 0 || await done()) break;
    }
    return { killed: tail(killed), afterCrash, reruns, transactionsSent: (await tb.transactionCount(buyer)) - nonceBefore };
  };

  // 1. request-close, killed once, then run again.
  const requested = await step('request-close', ['buyer', 'channels', 'request-close', channelId, '--json'], plan.requestClose, {
    sentAfterCrash: (state) => state.closeRequestedAt > 0,
    done: async () => (await tb.channelState(channelId)).closeRequestedAt > 0,
  });
  const closing = await tb.channelState(channelId);
  const lastRequest = requested.reruns.at(-1);
  await runAll([
    () => tb.check('request-close run again after the crash exits 0: it sends the request, or reports the one already on chain', lastRequest?.code === 0 && lastRequest.json?.channelId === channelId && (requested.afterCrash.closeRequestedAt > 0 ? lastRequest.json.alreadyRequested === true : /^0x[0-9a-f]{64}$/i.test(lastRequest.json.transaction ?? '')), requested.reruns),
    () => tb.check('the close request is on chain exactly once: one transaction, and the rerun did not move its time', closing.status === 1 && closing.closeRequestedAt > 0 && requested.transactionsSent === 1 && (requested.afterCrash.closeRequestedAt === 0 || requested.afterCrash.closeRequestedAt === closing.closeRequestedAt), { channel: closing, afterCrash: requested.afterCrash, transactionsSent: requested.transactionsSent }),
    async () => tb.check('the reserve stays locked until the grace period is over', (await tb.buyerBalance()).reserved === start.reserved, amounts(await tb.buyerBalance())),
  ]);

  // 2. The grace, then withdraw, killed once, then run again. The CLI checks the grace against its own clock.
  await tb.warp(GRACE_SECONDS + 60);
  const refund = BigInt(closing.deposit) - BigInt(closing.settled);
  const withdrawn = await step('withdraw', ['buyer', 'channels', 'withdraw', channelId, '--json'], plan.withdraw, {
    options: { clock: 'chain' },
    sentAfterCrash: (state) => state.status === 3,
    done: async () => (await tb.channelState(channelId)).status === 3,
  });
  const exited = await tb.channelState(channelId);
  const end = await tb.buyerBalance();
  const lastWithdraw = withdrawn.reruns.at(-1);
  // Run again after a withdraw that already went through, the command finds nothing left to withdraw and says so.
  const refusedCleanly = lastWithdraw?.code === 1 && /nothing active remains to withdraw/.test(lastWithdraw.stderr + lastWithdraw.stdout);
  await runAll([
    () => tb.check('withdraw run again after the crash: it withdraws, or says that nothing active remains', withdrawn.afterCrash.status === 3 ? lastWithdraw?.code === 0 || refusedCleanly : lastWithdraw?.code === 0 && /^0x[0-9a-f]{64}$/i.test(lastWithdraw.json?.transaction ?? '') && BigInt(lastWithdraw.json.estimatedRefund ?? -1) === refund, withdrawn.reruns),
    () => tb.check('the channel timed out on-chain with exactly one withdraw transaction', exited.status === 3 && withdrawn.transactionsSent === 1, { channel: exited, transactionsSent: withdrawn.transactionsSent }),
    () => tb.check('withdraw released the unsettled reserve to the deposit; no reserve is left', end.reserved === 0n && end.available - start.available === refund, { before: amounts(start), after: amounts(end), refund: String(refund) }),
    () => tb.check('nothing was lost: deposit left + settled = the original deposit', end.available + BigInt(exited.settled) === deposit, { left: String(end.available), settled: exited.settled, deposit: String(deposit) }),
    () => tb.check('fault path ran: both drawn exit points fired', fired.length === 2 && fired[0].point === plan.requestClose && fired[1].point === plan.withdraw, fired),
  ]);
  tb.metric('failpointCoverage', failpointCoverage({ buyer: [plan.requestClose, plan.withdraw] }, fired));
  tb.metric('exit', { channelId, plan, reserve: closing.deposit, settled: exited.settled, refund: String(refund), requestClose: requested, withdraw: withdrawn, withdrawRerunRefused: refusedCleanly });
  console.log(`[failpoint] plan: kill request-close at ${plan.requestClose} and withdraw at ${plan.withdraw} -> ${fired.length} of 2 fired; request-close reruns ${requested.reruns.length}, withdraw reruns ${withdrawn.reruns.length}${refusedCleanly ? ' (the rerun found nothing left to withdraw)' : ''}`);
}
