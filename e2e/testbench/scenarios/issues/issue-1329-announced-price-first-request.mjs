// #1329: what a buyer pays on a route is its own price for the response it received, from the prices the seller
// announced. The seller's upstream reports 100000 cached prompt tokens per chat, so its cached-input price decides
// what a request costs.
//
// Two things must hold, and each fails by itself without its half of the fix:
//   - the buyer recorded every price the seller bills by, so both sides price a response the same way;
//   - the buyer never signed more than its own price for what it received. A route it records as free costs
//     nothing: it is served free or refused, never paid from the unverified part of the channel.
//
// The variants share this file:
//   'first-request'   cached input is the route's only price (0 / 0 / 0.75 USD per million). The first request to
//                     the seller is on the route, so a seller that takes it answers with a 402.
//   'open-channel'    the same price; a normally priced service opens the channel first and the route is used on it.
//   'cached-discount' cached input is priced below input (3 / 15 / 0.75): an offer the buyer routes to. Both sides
//                     must price each response the same, and the channel closes at exactly that.
// A buyer that knows the price of the first two does not send the request at all: its router refuses an offer
// whose cached-input price is above its input price.
import { usageCost } from '../../lib/mock.mjs';

const ROUTE = 'mock-model';
const PRICED = 'priced-model';
const PROMPT_TOKENS = 10;
const COMPLETION_TOKENS = 8;
const CACHED_TOKENS = 100_000;
const CACHED_ONLY = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.75 };
const CACHED_DISCOUNT = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.75 };
const PRICED_PRICE = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
const USAGE = { prompt: PROMPT_TOKENS, completion: COMPLETION_TOKENS, cached: CACHED_TOKENS };
const REQUESTS = 3;

export function build(order) {
  const ROUTE_PRICE = order === 'cached-discount' ? CACHED_DISCOUNT : CACHED_ONLY;
  const meta = {
    description: `#1329 (${order}): the buyer records every price the seller bills by and signs exactly its own price for the responses it received.`,
    targets: ['local', 'fork'],
    requires: ['mockControl'],
  };

  const topology = {
    sellers: [{
      id: 'seller',
      providers: {
        mock: {
          plugin: 'openai',
          defaults: ROUTE_PRICE,
          services: {
            [ROUTE]: { categories: ['chat'] },
            [PRICED]: { categories: ['chat'], pricing: PRICED_PRICE },
          },
        },
      },
      mock: { cachedPromptTokens: CACHED_TOKENS },
    }],
    payments: { minBudgetPerRequestUsdc: '0.01' },
  };

  async function run(tb) {
    const seller = tb.seller('seller');
    const ask = (model, prompt) => tb.request('/v1/chat/completions', { body: { model: `${seller.peerId}@${model}`, messages: [{ role: 'user', content: prompt }] } });
    const signedNow = async () => (await tb.signedBySeller()).seller;

    tb.check('fresh testbench: nothing signed yet', (await signedNow()) === 0n, String(await signedNow()));

    // The buyer's own price for one response on the route, from what it recorded for the offer.
    const peer = (await tb.peers()).find((entry) => entry.peerId === seller.peerId);
    const provider = Object.values(peer?.providerPricing ?? {})[0];
    const recorded = provider?.services?.[ROUTE] ?? provider?.defaults ?? null;
    const sellerPrice = usageCost(ROUTE_PRICE, USAGE);
    const buyerPrice = recorded ? usageCost(recorded, USAGE) : 0n;
    tb.metric('sellerPricePerRequestMicroUsdc', String(sellerPrice));
    tb.metric('buyerPricePerRequestMicroUsdc', String(buyerPrice));

    let owed = 0n;
    let opening = 0n;
    if (order === 'open-channel') {
      const opened = await ask(PRICED, 'open the channel on the priced service');
      tb.check('the priced request is served', opened.status === 200, { status: opened.status, body: opened.text.slice(0, 300) });
      await tb.waitForPaidChannels('seller', { requests: 1, signed: 1n, timeoutMs: 15_000 });
      // The priced service has no cached-input price, so its cached tokens cost the input price on both sides.
      owed = usageCost(PRICED_PRICE, USAGE);
      // Opening a channel signs the seller's minimum budget before any response is priced.
      opening = await signedNow();
      tb.check('the priced request opened a paid channel', opening >= owed && opening > 0n, { signed: String(opening), owed: String(owed) });
    }

    const replies = [];
    for (let index = 0; index < REQUESTS; index += 1) {
      const reply = await ask(ROUTE, `request ${index + 1} on the route`);
      replies.push({ status: reply.status, body: reply.text.slice(0, 240) });
    }
    const served = replies.filter((reply) => reply.status === 200).length;
    owed += buyerPrice * BigInt(served);
    // Let the SpendingAuth for the last answer land before reading the channel.
    await tb.waitForPaidChannels('seller', { requests: (order === 'open-channel' ? 1 : 0) + served, signed: owed, timeoutMs: 8_000 });
    const signed = await signedNow();
    tb.metric('servedOnRoute', served);
    tb.metric('signedMicroUsdc', String(signed));
    tb.metric('owedAtBuyerPriceMicroUsdc', String(owed));

    // 409 and 402: the buyer or the seller refused to pay or serve. 502: the buyer's router refused the offer.
    tb.check(
      'every request on the route was served or refused with an error (the path ran)',
      replies.every((reply) => [200, 402, 409].includes(reply.status) || (reply.status === 502 && reply.body.includes('outside your buyer routing policy'))),
      replies,
    );
    if (order === 'cached-discount') tb.check('every request on the route was served', served === REQUESTS, replies);
    const ceiling = owed > opening ? owed : opening;
    tb.check(
      'the buyer signed no more than its own price for the responses it received',
      signed <= ceiling,
      { signed: String(signed), owedAtBuyerPrice: String(owed), signedAtOpening: String(opening), served, replies },
    );

    // Without this the seller is short after every response and the buyer's only choices are to overpay or stall.
    tb.check(
      'the buyer recorded every price the seller bills by',
      recorded != null && buyerPrice === sellerPrice,
      { recorded, sellerBillsBy: ROUTE_PRICE, buyerPricePerRequest: String(buyerPrice), sellerPricePerRequest: String(sellerPrice) },
    );

    await tb.closeAll();
    const settlement = await tb.assertSettlementMatchesSigned();
    tb.check(
      'the channel closed at the buyer\'s own price for the responses it received',
      BigInt(settlement.totalPaidMicroUsdc) === owed,
      { settled: settlement.totalPaidMicroUsdc, owedAtBuyerPrice: String(owed) },
    );
  }

  return { meta, topology, run };
}

export const { meta, topology, run } = build('first-request');
