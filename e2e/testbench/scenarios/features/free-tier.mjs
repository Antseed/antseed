// The seller's free tier on the full local contract stack (AntseedFreeUsage, seller pools). A zero-priced service
// answers FREE_LIMIT requests per buyer address without any paid channel or reserve, then refuses with 429
// rate_limit_error and retry-after before the upstream sees the request. A priced service with its own free allowance
// serves ALLOWANCE requests free, then charges the next one as usual. A staker then shares a seller-pool stake with
// the buyer (tb.delegateFreeTier, `antseed buyer free-tier add <code>`), and once the stake is active the staked tier
// gives the zero-priced service its multiplied allowance, counted on the delegated position.
//
// cli mode: `antseed seller start` reads the free-tier programs from its config, and the running `antseed buyer start`
// picks up the delegation from its config within a minute.
export const meta = {
  description: 'Free tier: N free requests open no paid channel, then the seller answers 429 rate_limit_error with retry-after on the free service; a priced service serves its allowance free, then charges; a staked delegation added with antseed buyer free-tier add raises the free allowance by its tier multiplier.',
  targets: ['local'],
  requires: ['mockControl', 'warpTime', 'sellerControl', 'sourceContracts'],
  covers: [
    'seller free-tier limiter (packages/node/src/payments/seller-free-tier-limiter.ts)',
    'AntseedFreeUsage and staked delegations (apps/cli/src/cli/commands/buyer/free-tier.ts, packages/node/src/payments/free-tier-delegation.ts)',
    '429 with retry-after before payment',
  ],
};

export const FREE_LIMIT = 2;
export const ALLOWANCE = 2;
export const MULTIPLIER = 3;
/** ANTS x epochs the staked tier needs; the delegation stakes 1000 ANTS for 12 epochs, far above it. */
const TIER_POWER = 1000;
const WINDOW_MS = 3_600_000;

export const topology = {
  mode: 'cli',
  sellers: [{
    id: 'seller',
    providers: {
      chat: {
        plugin: 'openai',
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        services: {
          'free-chat': { categories: ['chat'], pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
          'allowance-chat': { categories: ['chat'], pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }, freeTier: { maxRequestsPerAddress: ALLOWANCE, windowMs: WINDOW_MS, stakeTiers: [] } },
        },
      },
    },
    freeTier: { maxRequestsPerAddress: FREE_LIMIT, windowMs: WINDOW_MS, stakeTiers: [{ minPower: TIER_POWER, multiplier: MULTIPLIER }] },
  }],
};

/**
 * What a 429 from the free tier says: { retryAfter (s), type, code, limit, stakePower, limitedBy }. The buyer proxy
 * passes the seller's facts on under `free_tier` (the seller's own body has them at the top level).
 */
export function freeTierRefusal(reply) {
  const retryAfter = Number(reply.headers?.['retry-after']);
  const facts = reply.json?.free_tier ?? reply.json ?? {};
  return {
    status: reply.status,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
    type: reply.json?.error?.type ?? null,
    code: reply.json?.error?.code ?? null,
    limit: facts.limit ?? null,
    stakePower: facts.stakePower ?? null,
    limitedBy: facts.limitedBy ?? null,
  };
}

export async function run(tb) {
  const seller = tb.seller('seller');
  const pin = (model) => `${seller.peerId}@${model}`;
  const ask = (model, prompt) => tb.request('/v1/chat/completions', { body: { model: pin(model), messages: [{ role: 'user', content: prompt }] } });
  const paidChannels = async () => ((await tb.request('/_antseed/channels?all=1')).json?.channels ?? []).filter((channel) => (channel.channelKind ?? 'paid') === 'paid');
  const upstreamCount = async () => (await tb.mockRequests('seller')).length;

  // 1. A priced service with its own allowance: ALLOWANCE requests free, the next one paid.
  for (let index = 0; index < ALLOWANCE; index += 1) {
    const reply = await ask('allowance-chat', `allowance request ${index + 1}`);
    tb.check(`priced request ${index + 1} of ${ALLOWANCE} is served from the free allowance`, reply.status === 200 && reply.headers['x-antseed-free-tier'] === 'covered', { status: reply.status, freeTier: reply.headers['x-antseed-free-tier'] ?? null, body: reply.text.slice(0, 200) });
  }
  const paid = await ask('allowance-chat', 'past the allowance');
  tb.check('the request past the allowance is served and paid', paid.status === 200 && paid.headers['x-antseed-free-tier'] !== 'covered', { status: paid.status, freeTier: paid.headers['x-antseed-free-tier'] ?? null, body: paid.text.slice(0, 200) });
  const signed = await tb.waitFor(async () => {
    const total = (await tb.signedBySeller()).seller;
    return total > 0n ? total : null;
  }, 'the buyer to sign the paid request', { timeoutMs: 30_000 });
  const cost = tb.mockCostPerChat('seller', 'allowance-chat');
  tb.check('the buyer signed exactly one paid request: the allowance was free', signed === cost, { signed: String(signed), costPerRequest: String(cost) });
  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned();
  tb.check('settlement charged the one paid request only', BigInt(settlement.totalPaidMicroUsdc) === cost, settlement);

  // 2. A staker stakes 1000 ANTS on this seller for 12 epochs, active from the next epoch. The seller caches the
  // current epoch for 10 minutes of wall time (an epoch is a week on Base), and every request above already looked
  // it up, so the seller restarts after the warp, like one started once the stake is active. The buyer gets the
  // delegation code only after the free limit is reached.
  const delegation = await tb.delegateFreeTier({ amount: '1000', epochs: 12, sellerId: 'seller' });
  const warped = await tb.warpToNextEpoch();
  tb.check('the stake is active from the next epoch', warped.to === warped.from + 1, warped);
  await tb.stopSeller('seller');
  await tb.startSeller('seller');

  // 3. The zero-priced service: FREE_LIMIT requests, no paid channel, no reserve.
  const beforeFree = await tb.buyerBalance();
  const paidBefore = (await paidChannels()).length;
  for (let index = 0; index < FREE_LIMIT; index += 1) {
    const reply = await ask('free-chat', `free request ${index + 1}`);
    tb.check(`free request ${index + 1} of ${FREE_LIMIT} is served`, reply.status === 200 && reply.json?.choices?.length > 0, { status: reply.status, body: reply.text.slice(0, 300) });
  }
  const afterFree = await tb.buyerBalance();
  tb.check('free requests opened no paid channel and reserved or charged nothing', (await paidChannels()).length === paidBefore && afterFree.reserved === 0n && afterFree.available === beforeFree.available, { paidChannelsBefore: paidBefore, channels: await paidChannels(), before: String(beforeFree.available), balance: { available: String(afterFree.available), reserved: String(afterFree.reserved) } });
  const upstreamAfterFree = await upstreamCount();
  const refused = await ask('free-chat', 'one free request too many');
  const refusal = freeTierRefusal(refused);
  tb.check('the next free request gets 429 rate_limit_error with retry-after', refusal.status === 429 && refusal.type === 'rate_limit_error' && refusal.code === 'free_tier_exhausted' && refusal.retryAfter >= 1 && refusal.retryAfter <= WINDOW_MS / 1000 && refusal.limit === FREE_LIMIT, { ...refusal, body: refused.text.slice(0, 1500) });
  tb.check('the refused request never reached the upstream', (await upstreamCount()) === upstreamAfterFree, { before: upstreamAfterFree, after: await upstreamCount() });

  // 4. The buyer adds the staker's code; the staked tier multiplies the free limit.
  const added = await tb.cli(['buyer', 'free-tier', 'add', delegation.code]);
  tb.check('antseed buyer free-tier add accepts the staker\'s code', added.code === 0 && added.stdout.toLowerCase().includes(delegation.staker.toLowerCase()), { code: added.code, stdout: added.stdout.slice(0, 300), stderr: added.stderr.slice(-300) });
  const listed = await tb.cli(['buyer', 'free-tier', 'list'], { clock: 'chain' });
  tb.check('antseed buyer free-tier list names the staker', listed.code === 0 && listed.stdout.toLowerCase().includes(delegation.staker.toLowerCase()), { code: listed.code, stdout: listed.stdout.slice(0, 600), stderr: listed.stderr.slice(-300) });

  // The running buyer reloads its delegations within a minute; until then the seller still refuses.
  const started = Date.now();
  const first = await tb.waitFor(async () => {
    const reply = await ask('free-chat', 'free request on the staked tier');
    return reply.status === 200 ? reply : null;
  }, 'the delegated stake to lift the free limit', { timeoutMs: 150_000, intervalMs: 5000 });
  tb.metric('delegationPickedUpMs', Date.now() - started);
  tb.check('with the delegated stake the free service answers again', first.status === 200, { status: first.status });
  let extra = 1;
  let limited = null;
  while (extra < FREE_LIMIT * MULTIPLIER + 2) {
    const reply = await ask('free-chat', `staked free request ${extra + 1}`);
    if (reply.status !== 200) { limited = reply; break; }
    extra += 1;
  }
  const stakedRefusal = limited ? freeTierRefusal(limited) : null;
  tb.metric('stakedFreeRequests', extra);
  // Staked usage is counted on the positions, not the address (FreeTierStakeStanding.positionIds): the tier's whole
  // allowance is there, whatever the address already used.
  tb.check(`the staked tier serves ${MULTIPLIER}x the free limit on the delegated position, then refuses with 429`, extra === FREE_LIMIT * MULTIPLIER && stakedRefusal?.status === 429 && stakedRefusal.type === 'rate_limit_error' && stakedRefusal.limitedBy === 'stake' && stakedRefusal.limit === FREE_LIMIT * MULTIPLIER && BigInt(stakedRefusal.stakePower) * 10n ** 18n === BigInt(delegation.power), { extra, refusal: stakedRefusal, power: delegation.power, body: limited?.text.slice(0, 600) });
  const end = await tb.buyerBalance();
  tb.check('the staked free requests reserved nothing', end.reserved === 0n, { available: String(end.available), reserved: String(end.reserved) });
}
