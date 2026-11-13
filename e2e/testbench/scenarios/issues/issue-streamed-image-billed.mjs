export const meta = {
  description: 'An image request priced per image is billed for the images it delivers: one that asks for the answer as a stream of events, which per-image billing cannot count, is refused before the upstream is called, and the images served are settled exactly.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

const IMAGE_MODEL = 'gpt-image-1';
const IMAGE_PRICE_USD = 0.04;
const IMAGE_PRICE = BigInt(Math.round(IMAGE_PRICE_USD * 1_000_000));

// cli mode, so `--seller-tree` and `--buyer-tree` can run either side from another checkout.
export const topology = {
  mode: 'cli',
  sellers: [{
    id: 'seller',
    providers: {
      mock: {
        plugin: 'openai',
        services: {
          [IMAGE_MODEL]: {
            capabilities: { inputs: ['text'], outputs: ['image'] },
            unitBillingModels: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: IMAGE_PRICE_USD }] } },
          },
        },
      },
    },
  }],
  buyer: { maxPricing: { defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } } },
};

export async function run(tb) {
  const [seller] = tb.sellers;
  const upstreamImages = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/images/generations');
  const channel = async () => ((await tb.channels())[seller.id] ?? [])[0];
  const signed = async () => BigInt((await channel())?.cumulativeSigned ?? '0');
  const generate = (prompt, extra = {}) => tb.request('/v1/images/generations', { stream: extra.stream === true, body: { model: IMAGE_MODEL, prompt, ...extra } });

  const fresh = { images: (await upstreamImages()).length, channel: await channel() };
  tb.check('scenario starts on a fresh testbench (no image requests, no open channel)', fresh.images === 0 && !fresh.channel, fresh);

  // An image answered as JSON, which per-image billing counts.
  const plain = await generate('[req:plain] a red fox in the snow');
  await tb.waitForPaidChannels(seller.id, { requests: 1, signed: IMAGE_PRICE, timeoutMs: 15_000 });
  const signedAfterPlain = await signed();
  // At least the image's price; the seller may add the request's tokens on top.
  tb.check('the image answered as JSON was served and charged at least one image', plain.status === 200 && plain.json?.data?.length === 1 && signedAfterPlain >= IMAGE_PRICE, { status: plain.status, images: plain.json?.data?.length ?? null, signed: String(signedAfterPlain), price: String(IMAGE_PRICE) });

  // The same request asking for OpenAI's stream of events, with two partial images before the final one.
  const servedBefore = (await upstreamImages()).length;
  const streamed = await generate('[req:streamed] a red fox in the snow', { stream: true, partial_images: 2 });
  // Give any payment for it the same time the first one had.
  await tb.waitForPaidChannels(seller.id, { requests: 2, signed: signedAfterPlain + 1n, timeoutMs: 15_000 });
  const signedForStreamed = (await signed()) - signedAfterPlain;
  const servedStreamed = (await upstreamImages()).length - servedBefore;
  const events = [...streamed.text.matchAll(/^event: (\S+)$/gm)].map((match) => match[1]);
  const completed = [...streamed.text.matchAll(/^data: (.+)$/gm)].map((match) => { try { return JSON.parse(match[1]); } catch { return null; } })
    .filter((data) => data?.type === 'image_generation.completed' && typeof data.b64_json === 'string' && data.b64_json.length > 0);
  const observed = {
    status: streamed.status,
    contentType: streamed.headers['content-type'] ?? null,
    upstreamCalls: servedStreamed,
    events,
    finalImagesDelivered: completed.length,
    signedForIt: String(signedForStreamed),
    price: String(IMAGE_PRICE),
    body: streamed.status === 200 ? undefined : streamed.text.slice(0, 300),
  };
  // One check first, so a failure shows the whole case at once.
  tb.check('every image the upstream served was paid for', servedStreamed === 0 || signedForStreamed >= IMAGE_PRICE * BigInt(Math.max(1, completed.length)), observed);
  tb.check('the streamed image request was refused before the upstream was called', streamed.status === 400 && servedStreamed === 0 && completed.length === 0, observed);
  tb.check('nothing was signed for the refused request', signedForStreamed === 0n, observed);

  await tb.closeAll();
  const expected = await tb.signedBySeller();
  const settlement = await tb.assertSettlementMatchesSigned(expected);
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.check('settled amount equals what the image served as JSON was charged', BigInt(settlement.totalPaidMicroUsdc) === signedAfterPlain, { settled: settlement.totalPaidMicroUsdc, expected: String(signedAfterPlain) });
}
