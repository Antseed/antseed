/**
 * A route the buyer chose as free, which the seller bills anyway (#1329).
 *
 * The real buyer stack (request handler, negotiator, payment manager, sqlite
 * store) against the real seller stack; only the chain is faked. The seller
 * announces the service at $0 and bills it at $0.6 / $1.2 per million.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeCostUsdc } from '../src/payments/pricing.js';
import { setupBuyerSellerStack, type BuyerSellerStack } from './helpers/buyer-seller-stack.js';

const USAGE = { promptTokens: 66_000, cachedTokens: 61_380, completionTokens: 87 };
const BILLED = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 1.2 };
const FREE = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
const PER_REQUEST = computeCostUsdc(USAGE.promptTokens - USAGE.cachedTokens, USAGE.completionTokens, BILLED, USAGE.cachedTokens);
// The CLI buyer's defaults.
const MAX_PER_REQUEST = 300_000n;
const MAX_RESERVE = 1_000_000n;

const stacks: BuyerSellerStack[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const stack of stacks.splice(0)) stack.cleanup();
});

function setup(options: Parameters<typeof setupBuyerSellerStack>[0]): BuyerSellerStack {
  const stack = setupBuyerSellerStack(options);
  stacks.push(stack);
  return stack;
}

async function sendAll(stack: BuyerSellerStack, count: number, service?: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    statuses.push((await stack.send(stack.chat(`${service ?? 'free'}-${i}`, service))).statusCode);
    await stack.settle();
  }
  return statuses;
}

describe('buyer on a route chosen as free that the seller bills', () => {
  it('signs nothing and opens no channel, however often the seller asks for payment', async () => {
    const stack = setup({
      sellerPricing: { defaults: BILLED },
      announced: { providerPricing: { venice: { defaults: FREE, services: { 'chat-model': FREE } } } },
      usage: USAGE,
      maxPerRequestUsdc: MAX_PER_REQUEST,
      maxReserveAmountUsdc: MAX_RESERVE,
    });

    const statuses = await sendAll(stack, 20);

    expect(stack.totalSigned()).toBe(0n);
    expect(stack.sentAuths).toHaveLength(0);
    expect(stack.reserve).not.toHaveBeenCalled();
    expect(stack.chain.size).toBe(0);
    expect(statuses).toEqual(Array(20).fill(409));
  }, 60_000);

  it('on a channel already open for a paid service, signs one overdraft window at most and opens no further channel', async () => {
    const stack = setup({
      sellerPricing: { defaults: BILLED, services: { 'paid-model': BILLED } },
      announced: {
        providerPricing: { venice: { defaults: FREE, services: { 'chat-model': FREE, 'paid-model': BILLED } } },
        providerServiceApiProtocols: { venice: { services: { 'chat-model': ['openai-chat-completions'], 'paid-model': ['openai-chat-completions'] } } },
      } as never,
      usage: USAGE,
      maxPerRequestUsdc: MAX_PER_REQUEST,
      maxReserveAmountUsdc: MAX_RESERVE,
      extraServices: ['paid-model'],
    });

    // The paid response is signed at exactly its announced price.
    expect(await sendAll(stack, 1, 'paid-model')).toEqual([200]);
    expect(stack.totalSigned()).toBe(PER_REQUEST);

    await sendAll(stack, 10);

    expect(stack.signedByChannel().size).toBe(1);
    expect(stack.reserve).toHaveBeenCalledOnce();
    expect(stack.totalSigned() - PER_REQUEST).toBeLessThanOrEqual(MAX_PER_REQUEST);
  }, 60_000);

  it('still pays a paid route of the same seller at its announced price', async () => {
    const stack = setup({
      sellerPricing: { defaults: BILLED },
      announced: { providerPricing: { venice: { defaults: BILLED, services: { 'chat-model': BILLED } } } },
      usage: USAGE,
      maxPerRequestUsdc: MAX_PER_REQUEST,
      maxReserveAmountUsdc: MAX_RESERVE,
    });

    expect(await sendAll(stack, 5)).toEqual(Array(5).fill(200));
    expect(stack.totalSigned()).toBe(PER_REQUEST * 5n);
    expect(stack.signedByChannel().size).toBe(1);
  }, 60_000);
});
