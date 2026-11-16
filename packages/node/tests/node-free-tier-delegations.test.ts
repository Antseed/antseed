import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntseedNode } from '../src/node.js';
import { decodeFreeTierDelegationsHeader, type FreeTierDelegation } from '../src/payments/free-tier-delegation.js';

const dirs: string[] = [];
const nodes: AntseedNode[] = [];

afterEach(async () => {
  for (const node of nodes.splice(0)) await node.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function defaultHandlerHeader(node: AntseedNode): string | null {
  const handler = (node as unknown as { _buyerHandler: { _deps: { freeTierDelegationsHeader?: () => string | null } } })._buyerHandler;
  return handler._deps.freeTierDelegationsHeader?.() ?? null;
}

describe('default buyer free-tier delegations', () => {
  it('sends the configured delegations and picks up replacements', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'antseed-free-tier-node-'));
    dirs.push(dataDir);
    const node = new AntseedNode({ role: 'buyer', dataDir, bootstrapNodes: [], noOfficialBootstrap: true });
    nodes.push(node);
    await node.start();
    expect(defaultHandlerHeader(node)).toBeNull();

    const delegation: FreeTierDelegation = {
      staker: `0x${'aa'.repeat(20)}`,
      buyer: node.identity!.wallet.address,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      signature: `0x${'11'.repeat(65)}`,
    };
    node.setFreeTierDelegations([delegation]);
    expect(decodeFreeTierDelegationsHeader(defaultHandlerHeader(node)!, delegation.buyer)).toEqual([delegation]);
  });
});

describe('seller free-tier service classification', () => {
  it('counts a unit-priced service as paid, like the request handler does', () => {
    const node = new AntseedNode({ role: 'seller', bootstrapNodes: [], noOfficialBootstrap: true });
    const free = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
    node.registerProvider({
      name: 'images',
      services: ['paid-image', 'free-image', 'paid-chat', 'free-chat'],
      pricing: { defaults: free, services: { 'paid-chat': { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.1 } } },
      serviceUnitBillingModels: {
        'paid-image': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.02 }] } },
        'free-image': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0 }] } },
      },
      maxConcurrency: 1,
      handleRequest: async () => { throw new Error('unused'); },
      getCapacity: () => ({ current: 0, max: 1 }),
    } as never);
    const offered = (node as unknown as { _offeredServicesByPrice(): { paid: string[]; free: string[] } })._offeredServicesByPrice();
    expect(offered.paid.sort()).toEqual(['paid-chat', 'paid-image']);
    expect(offered.free.sort()).toEqual(['free-chat', 'free-image']);
  });
});
