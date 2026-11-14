// #1329: the other side of "a route priced at zero costs nothing". A per-image service whose token prices are
// zero (0 / 0 USD per million tokens, 0.04 USD per image) is a paid route: the buyer must open a channel on the
// seller's 402 and sign exactly the image price. A buyer that reads "zero token prices" as "free" refuses it.
export const meta = {
  description: '#1329: a paid per-image service with zero token prices is negotiated and paid exactly, not refused as a free route.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

const IMAGE_MODEL = 'qwen-image';
const IMAGE_PRICE_MICRO_USDC = 40_000n;

export const topology = {
  sellers: [{
    id: 'seller',
    providers: {
      mock: {
        plugin: 'openai',
        defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        services: {
          [IMAGE_MODEL]: {
            pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
            capabilities: { inputs: ['text'], outputs: ['image'] },
            unitBillingModels: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } },
          },
        },
      },
    },
  }],
  payments: { minBudgetPerRequestUsdc: '0.01' },
};

export async function run(tb) {
  const seller = tb.seller('seller');
  const before = (await tb.signedBySeller()).seller;
  tb.check('fresh testbench: nothing signed yet', before === 0n, String(before));

  const reply = await tb.request('/v1/images/generations', {
    body: { model: `${seller.peerId}@${IMAGE_MODEL}`, prompt: 'A tiny purple cube', n: 1 },
  });
  tb.check(
    'the paid image request is served (HTTP 200 with one image)',
    reply.status === 200 && Array.isArray(reply.json?.data) && reply.json.data.length === 1,
    { status: reply.status, body: reply.text.slice(0, 400) },
  );

  const upstream = (await tb.mockRequests('seller')).filter((entry) => entry.path === '/v1/images/generations');
  tb.check('the upstream generated exactly one image request', upstream.length === 1, upstream.length);

  const open = await tb.waitForPaidChannels('seller', { requests: 1, signed: IMAGE_PRICE_MICRO_USDC, timeoutMs: 15_000 });
  const signed = (await tb.signedBySeller()).seller;
  tb.check(
    'the buyer signed exactly the per-image price',
    signed === IMAGE_PRICE_MICRO_USDC,
    { signed: String(signed), expected: String(IMAGE_PRICE_MICRO_USDC), channels: open.length },
  );

  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned();
  tb.check(
    'settlement equals the one image',
    BigInt(settlement.totalPaidMicroUsdc) === IMAGE_PRICE_MICRO_USDC,
    { settled: settlement.totalPaidMicroUsdc, expected: String(IMAGE_PRICE_MICRO_USDC) },
  );
}
