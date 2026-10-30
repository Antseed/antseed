export const meta = {
  description: 'Issue #1200: a buyer that lost a NeedAuth is under-signed, and the seller\'s budget-exhausted 402 asks it to catch up to the delivered spend. The buyer must sign exactly that target, not max(target, signed + minBudgetPerRequest), and settle-on-disconnect must charge exactly the delivered work.',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'mockControl'],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

const sum = (values) => values.reduce((total, value) => total + value, 0n);

export async function run(sb) {
  const [seller] = sb.sellers;
  const model = seller.models[0];
  const cost = sb.mockCostPerChat(seller.id, model);
  const chats = async () => (await sb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions').length;
  const channel = async () => ((await sb.channels())[seller.id] ?? [])[0];
  const signed = async () => BigInt((await channel())?.cumulativeSigned ?? '0');
  const signedAtLeast = (amount, label) => sb.waitFor(async () => {
    const value = await signed();
    return value >= amount ? value : null;
  }, label, { timeoutMs: 30_000 });
  const loseNextNeedAuth = async () => {
    await sb.faults.loseNeedAuths(1);
    return async () => (await sb.waitFor(async () => (await sb.faults.lostNeedAuths())[0], 'a lost NeedAuth frame', { timeoutMs: 30_000 }));
  };
  sb.metric('costPerChatMicroUsdc', String(cost));

  const used = { chats: await chats(), channel: await channel() };
  sb.check('scenario starts on a fresh sandbox (no chats, no open channel)', used.chats === 0 && !used.channel, used);

  await sb.chat({ model, prompt: 'paid request 1' });
  const first = await signedAtLeast(cost, 'the buyer signing chat 1');
  sb.check('chat 1 is signed in full', first === cost, { signed: String(first), cost: String(cost) });

  // No public path leaves a buyer under-signed, so lose the NeedAuth that bills chat 2.
  let lost = await loseNextNeedAuth();
  await sb.chat({ model, prompt: 'paid request 2, its NeedAuth is lost' });
  const billing = await lost();
  const underSigned = await signed();
  sb.check('chat 2 NeedAuth was lost, so the buyer signed less than the seller delivered', billing.lastRequestCost != null && underSigned === cost, { lost: billing, signed: String(underSigned), delivered: String(2n * cost) });

  // The seller answers chat 3 with a 402 and a cost-free NeedAuth carrying the same target. Losing that
  // NeedAuth leaves the buyer's 402 negotiator (extendCurrentSpendingAuth) as the only path that signs.
  lost = await loseNextNeedAuth();
  const third = await sb.chat({ model, prompt: 'paid request 3, triggers the 402 catch-up' });
  const catchUp = await lost();
  const target = 2n * cost;
  sb.check('seller asked for exactly its delivered spend in the 402 catch-up', catchUp.lastRequestCost == null && BigInt(catchUp.requiredCumulativeAmount) === target, { lost: catchUp, delivered: String(target) });
  sb.check('chat 3 answered after the catch-up', third.content.length > 0, third.content);
  sb.metric('catchUpTargetMicroUsdc', String(target));

  sb.check('upstream served exactly three chats', (await chats()) === 3, await chats());
  const delivered = 3n * cost;
  const finalSigned = await signedAtLeast(delivered, 'the buyer signing at least the delivered work');
  const open = await channel();
  sb.metric('signedFinalMicroUsdc', String(finalSigned));
  sb.metric('deliveredMicroUsdc', String(delivered));

  await sb.stopBuyer();
  try {
    const settled = await sb.waitFor(async () => {
      const matching = (await sb.settledEvents(seller.id)).filter((event) => event.args.channelId === open.channelId);
      const balance = await sb.buyerBalance();
      return matching.length > 0 && balance.reserved === 0n ? matching : null;
    }, 'seller settle-on-disconnect', { timeoutMs: 90_000 });
    const paid = sum(settled.map((event) => event.args.delta));
    sb.metric('settledMicroUsdc', String(paid));
    sb.check('buyer signed exactly the delivered work after the catch-up', finalSigned === delivered, { signed: String(finalSigned), delivered: String(delivered), overSigned: String(finalSigned - delivered), settled: String(paid) });
    sb.check('seller settled what the buyer signed', paid === finalSigned, { settled: String(paid), signed: String(finalSigned) });
    sb.check('settled equals the delivered work', paid === delivered, { settled: String(paid), delivered: String(delivered), overCharged: String(paid - delivered) });
  } finally {
    await sb.startBuyer();
  }
}
