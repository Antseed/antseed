// #1329: a buyer still paid on a route it chose as free. A seller announces a service as free, and the buyer records
// that price. The seller then raises its price and restarts. Until its next periodic refresh, the buyer still holds the
// free announcement, so it sends requests on a route it chose as free while the seller now bills them: the first
// request is answered with a payment demand, and a buyer that negotiates it pays on a route it chose as free.
//
// The buyer's refresh interval is set long (30 minutes; the CLI default is 5) so the price raise lands inside that
// window on every run, and the scenario checks that the buyer still records the route as free right before it sends.
//
// Fixed: on a route it recorded as free the buyer signs nothing and opens no channel. It refuses the payment demand
// (409), and every channel settles at exactly what was signed.
import { usageCost } from '../../lib/mock.mjs';

const PROVIDER = 'mock';
const ROUTE = 'mock-model';
const FREE = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
const RAISED = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
const USAGE = { prompt: 10, completion: 8 };
const REQUESTS = 3;
const REQUEST_TIMEOUT_MS = 90_000;
const PEER_REFRESH_INTERVAL_MS = 30 * 60_000;

export const meta = {
  description: '#1329: a seller announced as free raises its price before the buyer refreshes; the buyer never pays on the route it recorded as free.',
  targets: ['local', 'fork'],
  requires: ['sellerControl'],
};

export const topology = {
  sellers: [{
    id: 'seller',
    providers: {
      [PROVIDER]: {
        plugin: 'openai',
        defaults: FREE,
        services: { [ROUTE]: { categories: ['chat'] } },
      },
    },
  }],
  buyer: { peerRefreshIntervalMs: PEER_REFRESH_INTERVAL_MS },
  payments: { minBudgetPerRequestUsdc: '0.01' },
};

/** The price the buyer holds for the route: the service's own pricing over the provider's defaults. */
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
  const routeAsRecorded = async () => {
    const price = recordedPrice((await tb.peers()).find((entry) => entry.peerId === seller.peerId));
    const status = await (await tb.request('/_antseed/status')).json;
    return { price, free: isFree(price), peersUpdatedAt: status?.peersUpdatedAt ?? null };
  };

  tb.check('fresh testbench: nothing signed yet', (await signedNow()) === 0n, String(await signedNow()));

  const before = await routeAsRecorded();
  tb.metric('recordedBeforeRaise', before.price);
  tb.check('the buyer recorded the route as free', before.free, { recorded: before.price, announced: FREE });

  // The seller raises its price. It reads its pricing when it starts, and it restarts without making the buyer
  // rediscover it: the buyer keeps the free announcement until its own refresh.
  await tb.stopSeller('seller');
  await tb.setSellerPricing('seller', { provider: PROVIDER, defaults: RAISED });
  await tb.startSeller('seller', { refreshBuyer: false });

  const sending = await routeAsRecorded();
  tb.metric('recordedWhenSending', sending.price);
  tb.check(
    'the buyer still records the route as free when it sends (it has not refreshed the seller yet)',
    sending.free && sending.peersUpdatedAt === before.peersUpdatedAt,
    { recorded: sending.price, peersUpdatedAt: { before: before.peersUpdatedAt, sending: sending.peersUpdatedAt } },
  );

  const replies = [];
  for (let index = 0; index < REQUESTS; index += 1) {
    try {
      const reply = await tb.request('/v1/chat/completions', {
        body: { model: `${seller.peerId}@${ROUTE}`, messages: [{ role: 'user', content: `[req:r${index + 1}] request ${index + 1} on the route` }] },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      replies.push(reply.status === 200 ? { status: 200 } : { status: reply.status, body: reply.text.slice(0, 600) });
    } catch (error) {
      replies.push({ status: 'no answer', body: String(error?.message ?? error).slice(0, 240) });
    }
  }
  const served = replies.filter((reply) => reply.status === 200).length;
  // The proxy answers before the buyer stores that request's SpendingAuth: let it land before reading the channel.
  // Only a buyer that paid gets here, and anything it signed fails the check below, so a slow store is not an error.
  if (served > 0 && (await channelsNow()).length > 0) {
    await tb.waitForPaidChannels('seller', { requests: served, signed: 1n, timeoutMs: 8_000 }).catch(() => {});
  }
  const signed = await signedNow();
  const channels = await channelsNow();
  tb.metric('sellerPricePerRequestMicroUsdc', String(usageCost(RAISED, USAGE)));
  tb.metric('replies', replies);
  tb.metric('servedOnRoute', served);
  tb.metric('signedMicroUsdc', String(signed));
  tb.metric('channelsOpened', channels.length);

  // Close before judging, so a failing run leaves no reserve locked.
  await tb.closeAll();

  tb.check(
    'the buyer signed nothing and opened no channel on a route it recorded as free',
    signed === 0n && channels.length === 0,
    { recorded: sending.price, sellerPrice: RAISED, signed: String(signed), channelsOpened: channels.length, served, replies },
  );
  // 409 with the buyer's reason: the seller asked for payment for a service it announces as free.
  tb.check(
    'every request on the route was answered: the buyer refused each payment demand (409)',
    replies.every((reply) => reply.status === 409 && reply.body.includes('announces as free')),
    replies,
  );
  // Every channel settled on-chain at exactly what the buyer signed, and no reserve is left locked.
  await tb.assertSettlementMatchesSigned();
}
