// #1329: a buyer limited to free routes still paid a seller. The seller's only price is for cached input
// (0 / 0 / 0.75 USD per million) and its upstream reports 100000 cached prompt tokens per chat, so it bills every
// request. When the buyer records the route as free (an announcement that leaves out the cached-input price), the
// first request to the seller is answered with a payment demand, and a buyer that negotiates it pays on a route it
// chose as free.
//
// The scenario asserts the invariant, not one outcome, so it holds whatever price the buyer records:
//   - on a route the buyer recorded as free it signs nothing and opens no channel;
//   - on a route it recorded as paid it signs no more than its own price for the responses it received;
//   - every request gets an answer: served, refused by the buyer (409), or refused by its routing policy.
import { usageCost } from '../../lib/mock.mjs';

const ROUTE = 'mock-model';
const PROMPT_TOKENS = 10;
const COMPLETION_TOKENS = 8;
const CACHED_TOKENS = 100_000;
const CACHED_ONLY = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.75 };
const USAGE = { prompt: PROMPT_TOKENS, completion: COMPLETION_TOKENS, cached: CACHED_TOKENS };
const REQUESTS = 3;
const REQUEST_TIMEOUT_MS = 90_000;

export const meta = {
  description: '#1329: a buyer never pays on a route it recorded as free; on a route it pays, it signs no more than its own price for what it received.',
  targets: ['local', 'fork'],
  requires: [],
};

export const topology = {
  sellers: [{
    id: 'seller',
    providers: {
      mock: {
        plugin: 'openai',
        defaults: CACHED_ONLY,
        services: { [ROUTE]: { categories: ['chat'] } },
      },
    },
    mock: { cachedPromptTokens: CACHED_TOKENS },
  }],
  payments: { minBudgetPerRequestUsdc: '0.01' },
};

/** The price the buyer recorded for the route: the service's own pricing over the provider's defaults. */
function recordedPrice(peer) {
  for (const provider of Object.values(peer?.providerPricing ?? {})) {
    const service = provider?.services?.[ROUTE];
    if (service || provider?.defaults) return { ...(provider.defaults ?? {}), ...(service ?? {}) };
  }
  return null;
}

const isFree = (price) => price != null && Object.values(price).every((value) => typeof value !== 'number' || value === 0);

export async function run(tb) {
  const seller = tb.seller('seller');
  const signedNow = async () => (await tb.signedBySeller()).seller;
  const channelsNow = async () => ((await tb.channels({ all: true })).seller ?? []);

  tb.check('fresh testbench: nothing signed yet', (await signedNow()) === 0n, String(await signedNow()));

  const peer = (await tb.peers()).find((entry) => entry.peerId === seller.peerId);
  const recorded = recordedPrice(peer);
  const recordedFree = isFree(recorded);
  const buyerPrice = recorded ? usageCost(recorded, USAGE) : 0n;
  tb.metric('recordedPrice', recorded);
  tb.metric('recordedFree', recordedFree);
  tb.metric('sellerPricePerRequestMicroUsdc', String(usageCost(CACHED_ONLY, USAGE)));
  tb.metric('buyerPricePerRequestMicroUsdc', String(buyerPrice));

  const replies = [];
  for (let index = 0; index < REQUESTS; index += 1) {
    try {
      const reply = await tb.request('/v1/chat/completions', {
        body: { model: `${seller.peerId}@${ROUTE}`, messages: [{ role: 'user', content: `[req:r${index + 1}] request ${index + 1} on the route` }] },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      replies.push(reply.status === 200 ? { status: 200 } : { status: reply.status, body: reply.text.slice(0, 240) });
    } catch (error) {
      replies.push({ status: 'no answer', body: String(error?.message ?? error).slice(0, 240) });
    }
  }
  const served = replies.filter((reply) => reply.status === 200).length;
  const owed = recordedFree ? 0n : buyerPrice * BigInt(served);
  // The proxy answers before the buyer stores that request's SpendingAuth: let it land before reading the channel.
  if (served > 0 && (await channelsNow()).length > 0) {
    await tb.waitForPaidChannels('seller', { requests: served, signed: owed > 0n ? owed : 1n, timeoutMs: 8_000 });
  }
  const signed = await signedNow();
  const channels = await channelsNow();
  tb.metric('servedOnRoute', served);
  tb.metric('signedMicroUsdc', String(signed));
  tb.metric('owedAtBuyerPriceMicroUsdc', String(owed));
  tb.metric('channelsOpened', channels.length);

  // Close before judging, so a failing run leaves no reserve locked.
  await tb.closeAll();

  if (recordedFree) {
    tb.check(
      'the buyer signed nothing on a route it recorded as free',
      signed === 0n && channels.length === 0,
      { recorded, signed: String(signed), channelsOpened: channels.length, served, replies },
    );
  } else {
    tb.check(
      'the buyer signed no more than its own price for the responses it received',
      signed <= owed,
      { recorded, signed: String(signed), owedAtBuyerPrice: String(owed), served, replies },
    );
  }
  // 409: the buyer refused a payment demand. 502: its routing policy refused the offer before sending it.
  tb.check(
    'every request on the route was answered: served, refused by the buyer, or refused by its routing policy',
    replies.every((reply) => reply.status === 200 || reply.status === 409
      || (reply.status === 502 && reply.body.includes('outside your buyer routing policy'))),
    replies,
  );
  // Every channel settled on-chain at exactly what the buyer signed, and no reserve is left locked.
  await tb.assertSettlementMatchesSigned();
}
