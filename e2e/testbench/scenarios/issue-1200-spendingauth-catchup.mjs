export const meta = {
  description: 'Issue #1200: a buyer that lost a NeedAuth is under-signed, and the seller\'s budget-exhausted 402 asks it to catch up to the delivered spend. The buyer must sign exactly that target, not max(target, signed + minBudgetPerRequest), and settle-on-disconnect must charge exactly the delivered work.',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'buyerFaults', 'mockControl'],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

const sum = (values) => values.reduce((total, value) => total + value, 0n);

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const cost = tb.mockCostPerChat(seller.id, model);
  const chats = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions').length;
  const channel = async () => ((await tb.channels())[seller.id] ?? [])[0];
  const signed = async () => BigInt((await channel())?.cumulativeSigned ?? '0');
  const signedAtLeast = (amount, label) => tb.waitFor(async () => {
    const value = await signed();
    return value >= amount ? value : null;
  }, label, { timeoutMs: 30_000 });
  const loseNextNeedAuth = async () => {
    await tb.faults.loseNeedAuths(1);
    return async () => (await tb.waitFor(async () => (await tb.faults.lostNeedAuths())[0], 'a lost NeedAuth frame', { timeoutMs: 30_000 }));
  };
  tb.metric('costPerChatMicroUsdc', String(cost));

  const used = { chats: await chats(), channel: await channel() };
  tb.check('scenario starts on a fresh testbench (no chats, no open channel)', used.chats === 0 && !used.channel, used);

  await tb.chat({ model, prompt: 'paid request 1' });
  const first = await signedAtLeast(cost, 'the buyer signing chat 1');
  tb.check('chat 1 is signed in full', first === cost, { signed: String(first), cost: String(cost) });

  // No public path leaves a buyer under-signed, so lose the NeedAuth that bills chat 2.
  let lost = await loseNextNeedAuth();
  await tb.chat({ model, prompt: 'paid request 2, its NeedAuth is lost' });
  const billing = await lost();
  const underSigned = await signed();
  tb.check('chat 2 NeedAuth was lost, so the buyer signed less than the seller delivered', billing.lastRequestCost != null && underSigned === cost, { lost: billing, signed: String(underSigned), delivered: String(2n * cost) });

  // The seller answers chat 3 with a 402 and a cost-free NeedAuth carrying the same target. Losing that
  // NeedAuth leaves the buyer's 402 negotiator (extendCurrentSpendingAuth) as the only path that signs.
  lost = await loseNextNeedAuth();
  const third = await tb.chat({ model, prompt: 'paid request 3, triggers the 402 catch-up' });
  const catchUp = await lost();
  const target = 2n * cost;
  tb.check('seller asked for exactly its delivered spend in the 402 catch-up', catchUp.lastRequestCost == null && BigInt(catchUp.requiredCumulativeAmount) === target, { lost: catchUp, delivered: String(target) });
  tb.check('chat 3 answered after the catch-up', third.content.length > 0, third.content);
  tb.metric('catchUpTargetMicroUsdc', String(target));

  tb.check('upstream served exactly three chats', (await chats()) === 3, await chats());
  const delivered = 3n * cost;
  const finalSigned = await signedAtLeast(delivered, 'the buyer signing at least the delivered work');
  const open = await channel();
  tb.metric('signedFinalMicroUsdc', String(finalSigned));
  tb.metric('deliveredMicroUsdc', String(delivered));

  await tb.stopBuyer();
  try {
    const settled = await tb.waitFor(async () => {
      const matching = (await tb.settledEvents(seller.id)).filter((event) => event.args.channelId === open.channelId);
      const balance = await tb.buyerBalance();
      return matching.length > 0 && balance.reserved === 0n ? matching : null;
    }, 'seller settle-on-disconnect', { timeoutMs: 90_000 });
    const paid = sum(settled.map((event) => event.args.delta));
    tb.metric('settledMicroUsdc', String(paid));
    tb.check('buyer signed exactly the delivered work after the catch-up', finalSigned === delivered, { signed: String(finalSigned), delivered: String(delivered), overSigned: String(finalSigned - delivered), settled: String(paid) });
    tb.check('seller settled what the buyer signed', paid === finalSigned, { settled: String(paid), signed: String(finalSigned) });
    tb.check('settled equals the delivered work', paid === delivered, { settled: String(paid), delivered: String(delivered), overCharged: String(paid - delivered) });
  } finally {
    await tb.startBuyer();
  }
}
