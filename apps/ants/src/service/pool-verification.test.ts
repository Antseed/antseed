import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import type { PoolView } from '../api-types.js';
import { AntscanIndexer, parseVerifications, VERIFICATIONS_TTL_MS } from './indexer.js';
import {
  RATES_TTL_MS, attachVerification, claimVerificationRatesRead, pointsMultiplierBps, poolVerification,
  verificationPolicyAddress, verificationRates, verificationServiceUrl,
} from './pool-verification.js';
import { getChainConfig } from '@antseed/node';

const live = { bonusBps: 200n, penaltyBps: 400n };
const HASH = `0x${'AB'.repeat(32)}`;

describe('pointsMultiplierBps', () => {
  it.each([
    [0, 0, 10_000],
    [6, 1, 10_800],
    [10, 1, 11_600],
    [25, 0, 15_000],
    [40, 0, 15_000], // bonus capped at 5,000 bps
    [9, 2, 10_200],
    [0, 5, 0], // 25 × 400 = 10,000: exactly zero
    [3, 8, 0], // floored at zero
  ])('%i SAME, %i DIFF → %i bps at 200/400', (same, diff, expected) => {
    expect(pointsMultiplierBps(same, diff, live)).toBe(expected);
  });

  it('is unchanged with zero rates', () => {
    expect(pointsMultiplierBps(7, 3, { bonusBps: 0n, penaltyBps: 0n })).toBe(10_000);
  });
});

describe('parseVerifications', () => {
  const raw = { verifications: { providers: [
    { agentId: '52894', verifiedCount: 10, diffCount: 1, services: [
      { service: 'model-a', serviceHash: HASH, verdict: 'SAME' },
      { service: 'model-b', serviceHash: `0x${'cd'.repeat(32)}`, verdict: 'DIFF' },
      { service: 'model-c', serviceHash: `0x${'ef'.repeat(32)}`, verdict: 'UNDETERMINED' },
      { service: 'broken', serviceHash: '0x12', verdict: 'DIFF' },
    ] },
    { agentId: '7', services: [{ service: 'x', serviceHash: HASH, verdict: 'diff' }] },
    { agentId: 'peer:abc', verifiedCount: 3 },
    { agentId: '0', verifiedCount: 3 },
  ] } };

  it('keys providers by agent id and keeps their counts and service verdicts', () => {
    const parsed = parseVerifications(raw, 'https://scan');
    expect([...parsed.providers.keys()]).toEqual([52894, 7]);
    expect(parsed.providers.get(52894)).toMatchObject({ sameCount: 10, diffCount: 1 });
    expect(parsed.providers.get(52894)!.services.map(s => s.service)).toEqual(['model-a', 'model-b', 'model-c']);
    expect(parsed.providers.get(52894)!.services[0]!.serviceHash).toBe(HASH.toLowerCase());
    // Without explorer counts, verdicts are counted from the services.
    expect(parsed.providers.get(7)).toMatchObject({ sameCount: 0, diffCount: 1 });
  });

  it('rejects a response without providers', () => {
    expect(() => parseVerifications({ verifications: {} }, 'https://scan')).toThrow();
    expect(() => parseVerifications(null, 'https://scan')).toThrow();
  });

  it('builds per-service links and omits sellers without a SAME or DIFF verdict', () => {
    const parsed = parseVerifications(raw, 'https://scan/');
    expect(verificationServiceUrl('https://scan/', 52894, HASH)).toBe(`https://scan/verification-service/52894~${HASH.toLowerCase()}`);
    expect(poolVerification(52894, parsed, live)).toEqual({
      sameCount: 10, diffCount: 1, pointsMultiplierBps: 11_600,
      sameServices: [{ service: 'model-a', url: `https://scan/verification-service/52894~${HASH.toLowerCase()}` }],
      diffServices: [{ service: 'model-b', url: `https://scan/verification-service/52894~0x${'cd'.repeat(32)}` }],
    });
    expect(poolVerification(52894, parsed, null)?.pointsMultiplierBps).toBeNull();
    const empty = { baseUrl: 'https://scan', providers: new Map([[9, { agentId: 9, sameCount: 0, diffCount: 0, services: [] }]]) };
    expect(poolVerification(9, empty, live)).toBeUndefined();
    expect(poolVerification(404, parsed, live)).toBeUndefined();
  });

  it('leaves views untouched when the read failed', () => {
    const view = { agentId: 52894 } as PoolView;
    attachVerification([view], null, live);
    expect(view.verification).toBeUndefined();
    attachVerification([view], parseVerifications(raw, 'https://scan'), live);
    expect(view.verification?.pointsMultiplierBps).toBe(11_600);
  });
});

describe('AntscanIndexer.verifications', () => {
  afterEach(() => { vi.useRealTimers(); });
  const body = () => new Response(JSON.stringify({ verifications: { providers: [{ agentId: '1', verifiedCount: 2, diffCount: 0, services: [] }] } }));

  it('reads once per TTL and survives wallet invalidation', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => body());
    const indexer = new AntscanIndexer('https://scan', request);
    await indexer.verifications();
    indexer.invalidate();
    await indexer.verifications();
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]![0])).toBe('https://scan/api/views/verifications');
    vi.advanceTimersByTime(VERIFICATIONS_TTL_MS);
    await indexer.verifications();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('waits a minute before retrying a failed read', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 })).mockImplementation(async () => body());
    const indexer = new AntscanIndexer('https://scan', request);
    await expect(indexer.verifications()).rejects.toThrow();
    await expect(indexer.verifications()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect((await indexer.verifications()).providers.get(1)?.sameCount).toBe(2);
  });
});

describe('verification policy rates', () => {
  const context = (chain: Record<string, unknown>) => ({ chain }) as unknown as AntsContext;

  it('claims at most one read per hour and keeps the last good rates when a read fails', () => {
    const ctx = context({ chainId: 'base-local', evmChainId: 31337, verificationPointsPolicyAddress: '0x00000000000000000000000000000000000000d5' });
    const store = claimVerificationRatesRead(ctx, 0)!;
    expect(claimVerificationRatesRead(ctx, 1)).toBeNull();
    store([200n], [400n]);
    expect(verificationRates(ctx)).toEqual(live);
    expect(claimVerificationRatesRead(ctx, RATES_TTL_MS - 1)).toBeNull();
    const again = claimVerificationRatesRead(ctx, RATES_TTL_MS)!;
    again(null, null);
    expect(verificationRates(ctx)).toEqual(live);
  });

  it('has nothing to read without a policy', () => {
    const ctx = context({ chainId: 'base-local', evmChainId: 31337 });
    expect(verificationPolicyAddress(ctx)).toBeNull();
    expect(claimVerificationRatesRead(ctx)).toBeNull();
    expect(verificationRates(ctx)).toBeNull();
  });

  it('falls back to the built-in policy only for the built-in usage accounting', () => {
    const builtIn = getChainConfig('base-mainnet');
    const chain = { chainId: 'base-mainnet', evmChainId: builtIn.evmChainId, usageAccountingAddress: builtIn.usageAccountingAddress };
    expect(verificationPolicyAddress(context(chain))).toBe(builtIn.verificationPointsPolicyAddress);
    expect(verificationPolicyAddress(context({ ...chain, usageAccountingAddress: '0x00000000000000000000000000000000000000aa' }))).toBeNull();
  });
});
