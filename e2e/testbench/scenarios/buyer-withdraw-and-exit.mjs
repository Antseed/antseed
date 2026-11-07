// A buyer takes its money out through the real CLI, on the full local contract stack. `antseed buyer withdraw`
// returns the free deposit while the channel's reserve stays locked; then, with the seller gone, the unilateral exit:
// `antseed buyer channels request-close`, the 15 min grace (tb.warp), `antseed buyer channels withdraw`, which
// releases what the seller never settled. Each step is compared with tb.buyerBalance() and tb.channelState(). This
// is the CLI path the Anvil-impersonation helpers tb.buyerRequestClose()/tb.buyerWithdraw() stand in for elsewhere.
//
// The CLI checks the grace against Date.now() (channel-withdraw.ts secondsUntilChannelWithdrawReady), not the chain's
// clock, so after the warp the withdraw runs with tb.cli({ clock: 'chain' }): as if the user ran it 16 minutes later.
export const meta = {
  description: 'antseed buyer withdraw returns the free balance while the reserved part stays locked; with the seller stopped, buyer channels request-close, the 15 min grace, then buyer channels withdraw releases the reserve. Every step matches the chain.',
  targets: ['local'],
  requires: ['mockControl', 'sellerControl', 'warpTime'],
  covers: [
    'buyer withdraw (apps/cli/src/cli/commands/buyer/withdraw.ts)',
    'unilateral exit request-close, grace, withdraw through the buyer CLI (apps/cli/src/cli/commands/buyer/channel-withdraw.ts)',
  ],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller' }],
};

/** AntseedChannels.TIMEOUT_GRACE_PERIOD. */
const GRACE_SECONDS = 15 * 60;

/** micro-USDC as the decimal USDC amount `antseed buyer withdraw` takes ("9", "0.000036"). */
export function usdcArg(micros) {
  const value = BigInt(micros);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

const amounts = (balance) => ({ available: String(balance.available), reserved: String(balance.reserved) });

const JSON_IGNORED = 'not filed yet: `buyer channels` declares --json itself, so commander gives the flag to `channels` and its request-close/withdraw/list subcommands print text (apps/cli/src/cli/commands/buyer/channels.ts)';

/**
 * What `buyer channels request-close|withdraw <id> --json` reported: its JSON, or the same facts read from the text
 * transcript it prints while --json is ignored (JSON_IGNORED). { transaction, estimatedRefundMicros, json }.
 */
export function channelCommandResult({ json, stdout }) {
  if (json) return { transaction: json.transaction ?? null, estimatedRefundMicros: json.estimatedRefund !== undefined ? BigInt(json.estimatedRefund) : null, json: true };
  const transaction = /Transaction:\s+(0x[0-9a-fA-F]{64})/.exec(stdout)?.[1] ?? null;
  const refund = /Estimated released reserve:\s+(\d+(?:\.\d{1,6})?) USDC/.exec(stdout)?.[1];
  const estimatedRefundMicros = refund === undefined ? null : BigInt(refund.split('.')[0]) * 1_000_000n + BigInt((refund.split('.')[1] ?? '').padEnd(6, '0'));
  return { transaction, estimatedRefundMicros, json: false };
}

export async function run(tb) {
  const sellerId = tb.sellers[0].id;
  const model = tb.sellers[0].models[0];
  const buyer = tb.manifest.buyer.address;
  const deposit = BigInt(tb.manifest.depositMicros);
  await tb.chat({ model, sellerId, prompt: 'paid chat before the buyer leaves' });
  const channel = await tb.waitFor(async () => {
    const rows = (await tb.request('/_antseed/channels')).json?.channels ?? [];
    return rows.find((row) => row.status === 'active' && BigInt(row.cumulativeSigned ?? '0') > 0n);
  }, 'a signed, active channel', { timeoutMs: 30_000 });
  const channelId = channel.channelId;
  const opened = await tb.channelState(channelId);
  const start = await tb.buyerBalance();
  tb.check('the chat opened a channel whose reserve is locked on-chain', opened.status === 1 && BigInt(opened.deposit) > 0n && start.reserved === BigInt(opened.deposit) && start.available + start.reserved === deposit, { channel: opened, balance: amounts(start) });

  // 1. Withdraw the free part of the deposit; the reserve cannot leave while the channel is open.
  const walletBefore = await tb.usdcBalance(buyer);
  const withdraw = await tb.cli(['buyer', 'withdraw', usdcArg(start.available)]);
  const afterWithdraw = await tb.buyerBalance();
  const walletAfter = await tb.usdcBalance(buyer);
  tb.check('antseed buyer withdraw <free balance> exits 0', withdraw.code === 0, { code: withdraw.code, stdout: withdraw.stdout.slice(-400), stderr: withdraw.stderr.slice(-400) });
  tb.check('buyer withdraw moved the free balance to the wallet and left the reserve locked', afterWithdraw.available === 0n && afterWithdraw.reserved === start.reserved && walletAfter - walletBefore === start.available, { before: amounts(start), after: amounts(afterWithdraw), walletGain: String(walletAfter - walletBefore) });
  const overdraw = await tb.cli(['buyer', 'withdraw', '0.000001']);
  const afterOverdraw = await tb.buyerBalance();
  tb.check('buyer withdraw cannot take the reserved part', overdraw.code !== 0 && afterOverdraw.available === 0n && afterOverdraw.reserved === start.reserved && (await tb.usdcBalance(buyer)) === walletAfter, { code: overdraw.code, stderr: overdraw.stderr.slice(-300), balance: amounts(afterOverdraw) });

  // 2. The seller goes away without closing the channel; the buyer exits on its own.
  await tb.stopSeller(sellerId);
  const orphaned = await tb.channelState(channelId);
  tb.check('the stopped seller left the channel open on-chain', orphaned.status === 1 && orphaned.closeRequestedAt === 0, orphaned);
  const requested = await tb.cli(['buyer', 'channels', 'request-close', channelId, '--json']);
  const requestedResult = channelCommandResult(requested);
  const closing = await tb.channelState(channelId);
  tb.check('antseed buyer channels request-close exits 0 with its transaction', requested.code === 0 && /^0x[0-9a-f]{64}$/i.test(requestedResult.transaction ?? '') && (!requested.json || (requested.json.channelId === channelId && requested.json.withdrawAfterSeconds === GRACE_SECONDS)), { code: requested.code, json: requested.json, stdout: requested.stdout.slice(-400), stderr: requested.stderr.slice(-400) });
  tb.knownIssue('buyer channels request-close --json prints JSON', requestedResult.json, { stdout: requested.stdout.slice(0, 300) }, JSON_IGNORED);
  tb.check('request-close is recorded on-chain and the reserve stays locked', closing.status === 1 && closing.closeRequestedAt > 0 && (await tb.buyerBalance()).reserved === start.reserved, closing);
  const early = await tb.cli(['buyer', 'channels', 'withdraw', channelId, '--json'], { clock: 'chain' });
  tb.check('buyer channels withdraw is refused before the grace period ends', early.code !== 0 && (await tb.channelState(channelId)).status === 1 && (await tb.buyerBalance()).reserved === start.reserved, { code: early.code, stderr: early.stderr.slice(-300) });

  await tb.warp(GRACE_SECONDS + 60);
  const released = await tb.cli(['buyer', 'channels', 'withdraw', channelId, '--json'], { clock: 'chain' });
  const releasedResult = channelCommandResult(released);
  const exited = await tb.channelState(channelId);
  const end = await tb.buyerBalance();
  const refund = BigInt(closing.deposit) - BigInt(closing.settled);
  tb.check('antseed buyer channels withdraw exits 0 after the grace and estimates the refund', released.code === 0 && /^0x[0-9a-f]{64}$/i.test(releasedResult.transaction ?? '') && releasedResult.estimatedRefundMicros === refund, { code: released.code, json: released.json, stdout: released.stdout.slice(-400), stderr: released.stderr.slice(-400), refund: String(refund) });
  tb.knownIssue('buyer channels withdraw --json prints JSON', releasedResult.json, { stdout: released.stdout.slice(0, 300) }, JSON_IGNORED);
  tb.check('the channel timed out on-chain', exited.status === 3, exited);
  tb.check('withdraw released the unsettled reserve to the deposit', end.reserved === 0n && end.available === refund, { before: amounts(afterOverdraw), after: amounts(end), refund: String(refund) });
  tb.check('nothing was lost: wallet withdrawal + deposit left + settled = the original deposit', start.available + end.available + BigInt(exited.settled) === deposit, { withdrawn: String(start.available), left: String(end.available), settled: exited.settled, deposit: String(deposit) });
  // The withdrawn USDC is the buyer's to spend: it moves on from the wallet like any other transfer.
  const elsewhere = '0x000000000000000000000000000000000000bEEF';
  const before = await tb.usdcBalance(elsewhere);
  await tb.usdcTransfer(buyer, elsewhere, start.available);
  tb.check('the withdrawn USDC can be sent on from the wallet', (await tb.usdcBalance(elsewhere)) - before === start.available && (await tb.usdcBalance(buyer)) === walletAfter - start.available, { sent: String(start.available) });
  tb.metric('exit', { channelId, reserve: closing.deposit, settled: exited.settled, refund: String(refund), withdrawn: String(start.available) });
}
