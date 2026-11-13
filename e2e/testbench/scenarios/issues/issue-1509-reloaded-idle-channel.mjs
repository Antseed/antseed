// #1509. A seller's idle settle and idle close timers belonged to buyers that had sent a request to the running
// process. A channel the seller reloaded from its store after a restart, whose buyer never came back, had neither:
// it stayed open on-chain with the buyer's reserve locked, and work delivered shortly before the restart was never
// settled. Here the buyer pays, the seller loses power before its idle settle, the buyer goes away for good, and
// the restarted seller must settle the delivered work and then close the channel on its own.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAll } from '../../lib/stress.mjs';

export const meta = {
  description: '#1509: a seller that restarts with a paid, unsettled channel whose buyer never returns settles the delivered work after the idle settle timeout and closes the channel after the idle close timeout, releasing the reserve.',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'buyerControl', 'mockControl'],
};

// The seller checks its stored channels at startup and every 60 s. With these timeouts the first periodic check
// finds the channel idle past the settle timeout only, and the second finds it idle past the close timeout.
const SETTLE_IDLE_MS = 20_000;
const CLOSE_IDLE_MS = 100_000;
const CHECK_INTERVAL_MS = 60_000;
const CHATS = 3;

// Priced so the three chats (1800 micro-USDC each on the mock's fixed usage) clear the seller's minimum settle
// amount (payments.minSettleDelta, 2000 micro-USDC): an idle settle below it is skipped by design.
const PRICING = { inputUsdPerMillion: 100, outputUsdPerMillion: 100 };

export const topology = {
  mode: 'cli',
  sellers: [{
    id: 'seller',
    providers: { chat: { plugin: 'openai', defaults: PRICING, services: { 'testbench-chat': { categories: ['chat'] } } } },
    env: { ANTSEED_DEBUG: '1' },
  }],
  buyer: { maxPricing: { defaults: { inputUsdPerMillion: 200, outputUsdPerMillion: 200 } } },
  payments: { settlementIdleMs: SETTLE_IDLE_MS, closeIdleMs: CLOSE_IDLE_MS },
};

const sum = (values) => values.reduce((total, value) => total + value, 0n);
const text = (value) => String(value);

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const deposit = BigInt(tb.manifest.depositMicros);
  const delivered = tb.mockCostPerChat(seller.id, model) * BigInt(CHATS);
  const settledOnChain = async (channelId) => sum((await tb.settledEvents(seller.id)).filter((event) => event.args.channelId === channelId).map((event) => event.args.delta));

  const start = await tb.buyerBalance();
  tb.check('fresh testbench: the deposit is available and nothing is reserved', start.available === deposit && start.reserved === 0n, { available: text(start.available), reserved: text(start.reserved) });

  // A paid channel: the buyer has signed for exactly the delivered work, and the seller has settled none of it yet.
  for (let index = 0; index < CHATS; index++) {
    const reply = await tb.chat({ model, prompt: `paid request ${index + 1}` });
    tb.check(`paid chat ${index + 1} answered`, reply.content.length > 0, reply.usage);
  }
  const [channel] = await tb.waitForPaidChannels(seller.id, { requests: CHATS, signed: delivered });
  tb.check('the buyer holds one open channel signed for exactly the delivered work', Boolean(channel) && BigInt(channel.cumulativeSigned) === delivered, { signed: channel?.cumulativeSigned, delivered: text(delivered) });
  if (!channel) return;
  const channelId = channel.channelId;
  tb.check('the upstream delivered the three chats', (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions').length === CHATS);

  // The seller loses power before its idle settle, then the buyer goes away. The dead seller sees no disconnect,
  // so nothing closes the channel on the way down.
  await tb.crashSeller(seller.id);
  await tb.stopBuyer();
  const atCrash = await tb.channelState(channelId);
  const reservedAtCrash = (await tb.buyerBalance()).reserved;
  tb.check('the channel is open, paid and unsettled when the seller restarts (the state #1509 starts from)', atCrash.status === 1 && BigInt(atCrash.settled) === 0n && reservedAtCrash > 0n, { ...atCrash, reserved: text(reservedAtCrash) });

  await tb.startSeller(seller.id);
  const restartedAt = Date.now();

  // Idle settle: the reloaded channel's signed amount is collected while the channel stays open.
  const settledWhileOpen = await tb.waitFor(async () => {
    const state = await tb.channelState(channelId);
    return BigInt(state.settled) > 0n ? state : null;
  }, 'the restarted seller to settle the reloaded idle channel', { timeoutMs: CHECK_INTERVAL_MS + 45_000, intervalMs: 1000 }).catch(() => null);
  tb.metric('idleSettleAfterRestartMs', settledWhileOpen ? Date.now() - restartedAt : null);

  // Idle close: the channel ends and the unspent reserve returns to the buyer.
  const closed = await tb.waitFor(async () => {
    const state = await tb.channelState(channelId);
    return state.status !== 1 ? state : null;
  }, 'the restarted seller to close the reloaded idle channel', { timeoutMs: CLOSE_IDLE_MS + CHECK_INTERVAL_MS, intervalMs: 1000 }).catch(() => null);
  tb.metric('idleCloseAfterRestartMs', closed ? Date.now() - restartedAt : null);

  const final = await tb.channelState(channelId);
  const end = await tb.buyerBalance();
  const paid = await settledOnChain(channelId);
  // The path under test ran: the seller's own log names the stored-channel settle and close for this channel.
  const log = await readFile(join(tb.manifest.dir, 'logs', `seller-${seller.id}.log`), 'utf8').catch(() => '');
  const lines = log.split('\n').filter((line) => line.includes(channelId.slice(0, 18)));
  const idleSettles = lines.filter((line) => line.includes('past the settle timeout')).length;
  const idleCloses = lines.filter((line) => line.includes('past the close timeout')).length;
  tb.metric('reloadedIdleSettleLogLines', idleSettles);
  tb.metric('reloadedIdleCloseLogLines', idleCloses);

  // Leave the testbench as teardown expects it before judging: the buyer is back.
  await tb.startBuyer();

  // Every verdict is reported, then the run fails if any did.
  await runAll([
    () => tb.check('the restarted seller settled the reloaded idle channel at the delivered amount', Boolean(settledWhileOpen) && BigInt(settledWhileOpen.settled) === delivered, settledWhileOpen ?? final),
    () => tb.check('the idle settle left the channel open', settledWhileOpen?.status === 1, settledWhileOpen ?? final),
    () => tb.check('the restarted seller closed the reloaded idle channel', closed?.status === 2, closed ?? final),
    () => tb.check('settlement equals the delivered work', paid === delivered && BigInt(final.settled) === delivered, { settledEvents: text(paid), channelSettled: final.settled, delivered: text(delivered) }),
    () => tb.check('the reserve was released and the buyer paid exactly the delivered work', end.reserved === 0n && end.available === deposit - delivered, { available: text(end.available), reserved: text(end.reserved), expectedAvailable: text(deposit - delivered) }),
    () => tb.check('the seller log shows the stored-channel idle settle and idle close for this channel', idleSettles > 0 && idleCloses > 0, { idleSettles, idleCloses }),
  ]);
}
