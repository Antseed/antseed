import { describe, expect, it } from 'vitest';
import { explorerSellers } from './explorer.js';

const directory = [
  { address: '0xAbC0000000000000000000000000000000000001', agentId: '53008', sellerName: 'Flash', sellerProviders: ['openai'], modelsServed: 7, uniqueBuyers: 130, requestCount: '2136184', earnedUsdc: '48304049795', ghostRate: 2.2, lastSettledAt: 1788737507 },
  { address: '0xabc0000000000000000000000000000000000002', agentId: null, sellerName: null },
  { address: '0xabc0000000000000000000000000000000000003', agentId: '53008' },
];

describe('explorerSellers', () => {
  it('maps the explorer directory by address and agent id, first agent claim wins', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(directory), { status: 200 })) as unknown as typeof fetch;
    const sellers = await explorerSellers('https://explorer.test/', fetchImpl);
    expect(sellers.byAddress.get('0xabc0000000000000000000000000000000000001')?.name).toBe('Flash');
    expect(sellers.byAddress.get('0xabc0000000000000000000000000000000000001')?.lifetimeVolumeUsdc).toBe('48304049795');
    expect(sellers.byAddress.get('0xabc0000000000000000000000000000000000002')?.name).toBeNull();
    expect(sellers.byAgent.get(53008)).toBe('0xabc0000000000000000000000000000000000001');
  });

  it('returns empty maps when the explorer is unreachable or unset', async () => {
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await explorerSellers('https://down.test', failing)).byAddress.size).toBe(0);
    expect((await explorerSellers(undefined, failing)).byAgent.size).toBe(0);
  });
});
