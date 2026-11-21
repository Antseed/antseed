import { describe, expect, it, vi } from 'vitest';
import { SellerBlindRelay, blindRelayCostUsdc, type BlindRelayCharge } from '../src/seller-blind-relay.js';
import type { Provider } from '../src/interfaces/seller-provider.js';

const BUYER = 'aa'.repeat(20);
const OTHER = 'bb'.repeat(20);
const NOW = 1_000_000;

function provider(spends: number[], multiplier = 1.5) {
  const spend = vi.fn(async () => spends.length > 1 ? spends.shift()! : spends[0]!);
  const value: Provider = {
    name: 'p',
    services: ['open-model'],
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    handleRequest: vi.fn(),
    getCapacity: () => ({ current: 0, max: 1 }),
    mintBlindCredential: vi.fn(async () => ({
      handle: 'upstream-handle',
      credential: 'scoped-token',
      upstream: { host: 'api.example.com', port: 443, baseUrl: 'https://api.example.com/v1', model: 'org/open-model' },
      expiresAt: NOW + 600_000,
      spendLimitUsd: 0.1,
    })),
    blindCredentialSpendUsd: spend,
    blindRelayPriceMultiplier: multiplier,
  };
  return { value, spend };
}

function relay() {
  const charges: BlindRelayCharge[] = [];
  const blind = new SellerBlindRelay({ charge: (charge) => charges.push(charge), now: () => NOW, sleep: async () => {} });
  return { blind, charges };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('blindRelayCostUsdc', () => {
  it('rounds up to whole USDC base units and charges nothing for no spend', () => {
    expect(blindRelayCostUsdc(0.00000062, 1)).toBe(1n);
    expect(blindRelayCostUsdc(0.002, 1.5)).toBe(3000n);
    expect(blindRelayCostUsdc(0, 2)).toBe(0n);
  });
});

describe('SellerBlindRelay', () => {
  it('mints a credential that names the upstream but not the provider handle', async () => {
    const { blind } = relay();
    const minted = await blind.mint(BUYER, 'open-model', provider([0]).value);
    expect(minted).toMatchObject({ credential: 'scoped-token', upstream: { host: 'api.example.com', model: 'org/open-model' }, spendLimitUsd: 0.1 });
    expect(JSON.stringify(minted)).not.toContain('upstream-handle');
  });

  it("lets only the buyer it was minted for open a stream, and one stream at a time", async () => {
    const { blind } = relay();
    const { credentialId } = await blind.mint(BUYER, 'open-model', provider([0]).value);
    await expect(blind.authorize(OTHER, 's0', credentialId)).rejects.toThrow('unknown credential');
    const grant = await blind.authorize(BUYER, 's1', credentialId);
    expect(grant).toMatchObject({ host: 'api.example.com', port: 443 });
    await expect(blind.authorize(BUYER, 's2', credentialId)).rejects.toThrow('credential busy');
  });

  it('charges each stream by the change in upstream spend, waiting for the counter to move', async () => {
    const { blind, charges } = relay();
    const { value, spend } = provider([0, 0, 0.002, 0.002, 0.005], 1.5);
    const { credentialId } = await blind.mint(BUYER, 'open-model', value);
    (await blind.authorize(BUYER, 'req-1', credentialId)).onClose!({ bytesUp: 1, bytesDown: 1 });
    await settle();
    expect(charges).toEqual([{ buyerPeerId: BUYER, requestId: 'req-1', service: 'open-model', costUsdc: 3000n }]);
    expect(spend).toHaveBeenCalledTimes(3);

    (await blind.authorize(BUYER, 'req-2', credentialId)).onClose!({ bytesUp: 1, bytesDown: 1 });
    await settle();
    expect(charges[1]).toEqual({ buyerPeerId: BUYER, requestId: 'req-2', service: 'open-model', costUsdc: 4500n });
  });

  it('refuses a fifth live credential for one buyer', async () => {
    const { blind } = relay();
    const { value } = provider([0]);
    for (let i = 0; i < 4; i += 1) await blind.mint(BUYER, 'open-model', value);
    await expect(blind.mint(BUYER, 'open-model', value)).rejects.toThrow('too many live credentials');
    await expect(blind.mint(OTHER, 'open-model', value)).resolves.toBeTruthy();
  });
});
