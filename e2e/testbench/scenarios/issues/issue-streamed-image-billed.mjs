export const meta = {
  description: 'An image request priced per image is billed for the final images it delivers, whether it is answered as JSON or as a stream of events with partial previews, and what was signed is settled exactly.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

const IMAGE_MODEL = 'qwen-image';
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
  tb.check('every image the upstream served was paid for', servedStreamed === 1 && completed.length === 1 && signedForStreamed >= IMAGE_PRICE, observed);
  tb.check('the streamed image arrived as a stream, with its partial previews before the final image', streamed.status === 200 && /text\/event-stream/.test(observed.contentType ?? '')
    && events.filter((name) => name === 'image_generation.partial_image').length === 2 && events.at(-1) === 'image_generation.completed', observed);
  // The partial previews are not billed: one image's price, plus at most its tokens, never a second image.
  tb.check('the stream was charged as one image, not for its partial previews', signedForStreamed >= IMAGE_PRICE && signedForStreamed < 2n * IMAGE_PRICE, observed);

  await tb.closeAll();
  const expected = await tb.signedBySeller();
  const settlement = await tb.assertSettlementMatchesSigned(expected);
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.check('settled amount equals what both images were charged', BigInt(settlement.totalPaidMicroUsdc) === signedAfterPlain + signedForStreamed, { settled: settlement.totalPaidMicroUsdc, expected: String(signedAfterPlain + signedForStreamed) });
}
