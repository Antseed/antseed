import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeteringStorage } from '../src/metering/storage.js';
import { SellerFreeTierLimiter, normalizeRemoteIp } from '../src/payments/seller-free-tier-limiter.js';
import { freeTierServiceScope, parseFreeTierProgram } from '../src/payments/free-tier-program.js';
import {
  FREE_TIER_DELEGATION_TYPES,
  encodeFreeTierDelegationsHeader,
  freeTierDelegationMessage,
  makeFreeTierDelegationDomain,
} from '../src/payments/free-tier-delegation.js';
import type { FreeTierStakeResolver } from '../src/payments/free-tier-stake-resolver.js';

const BUYER = '11'.repeat(20);
const OTHER_BUYER = '22'.repeat(20);
const THIRD_BUYER = '33'.repeat(20);
const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';
const tempDirs: string[] = [];

function persistentStorage(): MeteringStorage {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-free-tier-'));
  tempDirs.push(dir);
  return new MeteringStorage(join(dir, 'metering.db'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('normalizeRemoteIp', () => {
  it('collapses IPv4-mapped addresses and groups IPv6 by /64', () => {
    expect(normalizeRemoteIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeRemoteIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeRemoteIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64');
    expect(normalizeRemoteIp('2001:db8:1:2::1')).toBe('2001:0db8:0001:0002::/64');
    expect(normalizeRemoteIp('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
    expect(normalizeRemoteIp('')).toBeNull();
    expect(normalizeRemoteIp(null)).toBeNull();
    expect(normalizeRemoteIp('not-an-ip')).toBeNull();
  });
});

describe('SellerFreeTierLimiter', () => {
  it('limits zero-priced requests across services by buyer address', () => {
    const storage = persistentStorage();
    const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 2, windowMs: 60_000 }, storage);

    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free-model-a', remoteIp: IP, nowMs: 1_000 }))
      .toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free-model-b', remoteIp: IP, nowMs: 2_000 }))
      .toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free-model-a', remoteIp: IP, nowMs: 3_000 })).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 58_000,
      limitedBy: 'address',
      buyerAddress: `0x${BUYER}`,
      remoteIp: IP,
      standing: null,
      tier: null,
      limit: 2,
      program: { base: { maxRequestsPerAddress: 2, maxRequestsPerIp: null, windowMs: 60_000 }, stakeTiers: [] },
    });
    // No IP limit configured: another address from the same IP is still fine.
    expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free-model-a', remoteIp: IP, nowMs: 3_000 }).allowed).toBe(true);
    storage.close();
  });

  it('limits by remote IP across rotating buyer addresses', () => {
    const storage = persistentStorage();
    const limiter = new SellerFreeTierLimiter({ maxRequestsPerIp: 2, windowMs: 60_000 }, storage);

    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', remoteIp: IP, nowMs: 1_000 })).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free', remoteIp: IP, nowMs: 2_000 })).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume({ buyerPeerId: THIRD_BUYER, service: 'free', remoteIp: `::ffff:${IP}`, nowMs: 3_000 })).toMatchObject({
      allowed: false,
      retryAfterMs: 58_000,
      limitedBy: 'ip',
      remoteIp: IP,
    });
    expect(limiter.consume({ buyerPeerId: THIRD_BUYER, service: 'free', remoteIp: OTHER_IP, nowMs: 3_000 }).allowed).toBe(true);
    storage.close();
  });

  it('enforces both limits when both are configured and reports the binding one', () => {
    const storage = persistentStorage();
    const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 2, maxRequestsPerIp: 3, windowMs: 60_000 }, storage);

    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', remoteIp: IP, nowMs: 1_000 })).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', remoteIp: IP, nowMs: 2_000 })).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', remoteIp: IP, nowMs: 3_000 })).toMatchObject({ allowed: false, limitedBy: 'address' });
    // Fresh address, same IP: one IP slot left, then the IP limit binds.
    expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free', remoteIp: IP, nowMs: 4_000 })).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume({ buyerPeerId: THIRD_BUYER, service: 'free', remoteIp: IP, nowMs: 5_000 })).toMatchObject({ allowed: false, limitedBy: 'ip', retryAfterMs: 56_000 });
    // Denied requests are not recorded, so a different IP is unaffected.
    expect(limiter.consume({ buyerPeerId: THIRD_BUYER, service: 'free', remoteIp: OTHER_IP, nowMs: 5_000 })).toMatchObject({ allowed: true, remaining: 1 });
    storage.close();
  });

  it('skips the IP limit when the remote address is unknown', () => {
    const storage = persistentStorage();
    const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, maxRequestsPerIp: 1, windowMs: 60_000 }, storage);
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', remoteIp: null, nowMs: 1_000 })).toMatchObject({ allowed: true, remaining: 0, remoteIp: null });
    expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free', remoteIp: undefined, nowMs: 1_000 })).toMatchObject({ allowed: true });
    expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free', remoteIp: null, nowMs: 1_000 })).toMatchObject({ allowed: false, limitedBy: 'address' });
    storage.close();
  });

  it('uses a sliding window and persists usage across seller restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antseed-free-tier-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'metering.db');
    const firstStorage = new MeteringStorage(dbPath);
    const first = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, maxRequestsPerIp: 1, windowMs: 10_000 }, firstStorage);
    expect(first.consume({ buyerPeerId: BUYER, service: 'free-model', remoteIp: IP, nowMs: 5_000 }).allowed).toBe(true);
    firstStorage.close();

    const restartedStorage = new MeteringStorage(dbPath);
    const restarted = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, maxRequestsPerIp: 1, windowMs: 10_000 }, restartedStorage);
    expect(restarted.consume({ buyerPeerId: BUYER, service: 'free-model', remoteIp: IP, nowMs: 14_999 })).toMatchObject({ allowed: false, limitedBy: 'address' });
    expect(restarted.consume({ buyerPeerId: OTHER_BUYER, service: 'free-model', remoteIp: IP, nowMs: 14_999 })).toMatchObject({ allowed: false, limitedBy: 'ip' });
    expect(restarted.consume({ buyerPeerId: BUYER, service: 'free-model', remoteIp: IP, nowMs: 15_001 })).toMatchObject({ allowed: true, remaining: 0 });
    restartedStorage.close();
  });

  it('falls back to bounded in-memory accounting when metering is unavailable', () => {
    const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, maxRequestsPerIp: 2, windowMs: 1_000 });
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free-model', remoteIp: IP, nowMs: 1_000 })).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free-model', remoteIp: IP, nowMs: 1_500 })).toMatchObject({ allowed: false, limitedBy: 'address' });
    expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free-model', remoteIp: IP, nowMs: 1_500 })).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume({ buyerPeerId: THIRD_BUYER, service: 'free-model', remoteIp: IP, nowMs: 1_600 })).toMatchObject({ allowed: false, limitedBy: 'ip' });
    expect(limiter.consume({ buyerPeerId: BUYER, service: 'free-model', remoteIp: IP, nowMs: 2_001 })).toMatchObject({ allowed: true });
  });

  it('rejects invalid limits', () => {
    expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 0 })).toThrow(/maxRequestsPerAddress/);
    expect(() => new SellerFreeTierLimiter({ maxRequestsPerIp: 0 })).toThrow(/maxRequestsPerIp/);
    expect(() => new SellerFreeTierLimiter({})).toThrow(/maxRequestsPerAddress and\/or maxRequestsPerIp/);
    expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, windowMs: 999 })).toThrow(/windowMs/);
  });

  it('describes the configured policy', () => {
    expect(new SellerFreeTierLimiter({ maxRequestsPerAddress: 100, maxRequestsPerIp: 300, stakeTiers: [] }).describe())
      .toBe('free models: free requests a day: 100 per buyer address, 300 per IP');
    expect(new SellerFreeTierLimiter({ maxRequestsPerIp: 5, windowMs: 60_000, stakeTiers: [] }).describe())
      .toBe('free models: free requests per 1 min: 5 per IP');
    expect(new SellerFreeTierLimiter({ maxRequestsPerAddress: 10, stakeTiers: [{ minPower: 100, multiplier: 'unlimited' }] }).describe())
      .toBe('free models: free requests a day: 10 per buyer address; staked (a day): 100 power → unlimited');
    const perModel = new SellerFreeTierLimiter({
      services: {
        'flash-5.3': { maxRequestsPerAddress: 100, stakeTiers: [{ minPower: 1_000_000, multiplier: 10 }, { minPower: 10_000_000, multiplier: 'unlimited' }] },
        k3: { maxRequestsPerAddress: 200, stakersOnly: true, stakeTiers: [{ minPower: 45_000_000, multiplier: 1 }] },
      },
    });
    perModel.setPaidServices(['k3']);
    expect(perModel.describePrograms()).toEqual([
      'flash-5.3: free requests a day: 100 per buyer address; staked (a day): 1,000,000 power → 1,000, 10,000,000 power → unlimited',
      'k3: free only for stakers, others pay; staked (a day): 45,000,000 power → 200',
    ]);
  });

  describe('staked tiers', () => {
    const OWNER = '0x' + 'aa'.repeat(20);
    const NEW_OWNER = '0x' + 'bb'.repeat(20);
    const tier5x = { minPower: 100, multiplier: 5 } as const;
    const unlimited = { minPower: 1_000, multiplier: 'unlimited' } as const;
    const standing = (tier: typeof tier5x | typeof unlimited, positionIds = [1], staker = OWNER) =>
      ({ stakers: [staker], power: BigInt(tier.minPower) * 10n ** 18n, positionIds });

    it('shares one multiplied allowance across every buyer counted on the same positions and skips the IP limit', () => {
      const storage = persistentStorage();
      const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, maxRequestsPerIp: 1, windowMs: 60_000, stakeTiers: [tier5x] }, storage);
      const staked = standing(tier5x);
      const buyers = [BUYER, OTHER_BUYER, THIRD_BUYER, BUYER, OTHER_BUYER];
      buyers.forEach((buyer, index) => {
        expect(limiter.consume({ buyerPeerId: buyer, service: 'free', remoteIp: IP, standing: staked, nowMs: 1_000 + index }))
          .toMatchObject({ allowed: true, remaining: 4 - index, limit: 5 });
      });
      expect(limiter.consume({ buyerPeerId: THIRD_BUYER, service: 'free', remoteIp: OTHER_IP, standing: staked, nowMs: 2_000 }))
        .toMatchObject({ allowed: false, limitedBy: 'stake', limit: 5, retryAfterMs: 59_000 });
      storage.close();
    });

    it('keeps a transferred position’s used allowance with the position', () => {
      for (const storage of [persistentStorage(), null]) {
        const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, windowMs: 60_000, stakeTiers: [tier5x] }, storage);
        for (let i = 0; i < 5; i += 1) {
          expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', standing: standing(tier5x, [7, 8]), nowMs: 1_000 + i }).allowed).toBe(true);
        }
        // Position 8 moves to a fresh wallet: its new owner inherits the used allowance.
        expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free', standing: standing(tier5x, [8], NEW_OWNER), nowMs: 2_000 }))
          .toMatchObject({ allowed: false, limitedBy: 'stake' });
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', standing: standing(tier5x, [7]), nowMs: 2_000 }))
          .toMatchObject({ allowed: false, limitedBy: 'stake' });
        // Fresh stake brings its own allowance.
        expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free', standing: standing(tier5x, [9], NEW_OWNER), nowMs: 2_000 }).allowed).toBe(true);
        storage?.close();
      }
    });

    it('keeps staked traffic out of the base IP and address counters', () => {
      for (const storage of [persistentStorage(), null]) {
        const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, maxRequestsPerIp: 1, windowMs: 60_000, stakeTiers: [tier5x, unlimited] }, storage);
        for (let i = 0; i < 3; i += 1) {
          expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', remoteIp: IP, standing: standing(unlimited), nowMs: 1_000 + i }))
            .toMatchObject({ allowed: true, limit: null });
        }
        // An unstaked buyer on the same network still has its whole base allowance.
        expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'free', remoteIp: IP, nowMs: 2_000 }).allowed).toBe(true);
        // So does the staked buyer once its stake lapses.
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'free', remoteIp: OTHER_IP, nowMs: 2_000 }).allowed).toBe(true);
        storage?.close();
      }
    });

    it('advertises tiers only while a stake resolver enforces them', () => {
      const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1000, maxRequestsPerIp: 2000 });
      expect(limiter.capabilities()).toEqual(['free-tier.v1.base.a1000.i2000.w86400000']);
      limiter.setStakeResolver({ resolve: async () => null } as never);
      expect(limiter.capabilities()).toEqual([
        'free-tier.v1.base.a1000.i2000.w86400000',
        'free-tier.v1.tier.p520000.x5',
        'free-tier.v1.tier.p2600000.x20',
        'free-tier.v1.tier.p10400000.x0',
      ]);
    });

    it('forgets remembered delegations once requests stop sending them, but keeps them for channel admission', async () => {
      const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, windowMs: 60_000, stakeTiers: [tier5x] });
      const resolve = vi.fn(async () => null);
      limiter.setStakeResolver({ resolve } as unknown as FreeTierStakeResolver, 8453);
      const staker = Wallet.createRandom();
      const delegation = { staker: staker.address, buyer: `0x${BUYER}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      const signature = await staker.signTypedData(makeFreeTierDelegationDomain(8453), FREE_TIER_DELEGATION_TYPES, freeTierDelegationMessage(delegation));
      const stakersLooked = () => resolve.mock.calls.at(-1)![1];

      await limiter.resolveStanding(BUYER, encodeFreeTierDelegationsHeader([{ ...delegation, signature }]));
      expect(stakersLooked()).toEqual([staker.address.toLowerCase()]);
      await limiter.resolveStanding(BUYER);
      expect(stakersLooked()).toEqual([staker.address.toLowerCase()]);
      await limiter.resolveStanding(BUYER, '');
      expect(stakersLooked()).toEqual([]);
    });

    it('gives a service its own program and counters, and the rest the seller-wide one', () => {
      for (const storage of [persistentStorage(), null]) {
        const limiter = new SellerFreeTierLimiter({
          maxRequestsPerAddress: 1,
          windowMs: 60_000,
          stakeTiers: [tier5x],
          services: { 'big-model': { maxRequestsPerAddress: 2, windowMs: 120_000, stakeTiers: [unlimited] } },
        }, storage);
        expect(limiter.appliesTo('small-model')).toBe(true);
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'small-model', nowMs: 1_000 }).allowed).toBe(true);
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'other-model', nowMs: 1_001 }))
          .toMatchObject({ allowed: false, limitedBy: 'address', limit: 1 });
        // The seller-wide allowance is used up, but big-model counts on its own.
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'big-model', nowMs: 1_002 })).toMatchObject({ allowed: true, limit: 2 });
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'big-model', nowMs: 1_003 }).allowed).toBe(true);
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'big-model', nowMs: 1_004 }))
          .toMatchObject({ allowed: false, limit: 2, retryAfterMs: 120_000 - 2 });
        // Each program picks its own tier from the same stake: 5x below, nothing on big-model's unlimited-only program.
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'small-model', standing: standing(tier5x), nowMs: 1_005 }))
          .toMatchObject({ allowed: true, tier: tier5x, limit: 5 });
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'big-model', standing: standing(tier5x), nowMs: 1_006 }))
          .toMatchObject({ allowed: false, tier: null, standing: null, limitedBy: 'address' });
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'big-model', standing: standing(unlimited, [2]), nowMs: 1_007 }))
          .toMatchObject({ allowed: true, tier: unlimited, limit: null });
        // Rows of the 120 s program survive pruning by the 60 s seller-wide window.
        expect(limiter.consume({ buyerPeerId: OTHER_BUYER, service: 'small-model', nowMs: 100_000 }).allowed).toBe(true);
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'big-model', nowMs: 100_001 }).allowed).toBe(false);
        storage?.close();
      }
    });

    it('limits only services that have a program when there is no seller-wide one', () => {
      const limiter = new SellerFreeTierLimiter({ services: { 'big-model': { maxRequestsPerAddress: 1 } } });
      expect(limiter.appliesTo('big-model')).toBe(true);
      expect(limiter.appliesTo('small-model')).toBe(false);
      expect(limiter.program()).toBeNull();
      expect(() => limiter.consume({ buyerPeerId: BUYER, service: 'small-model' })).toThrow(/no free-tier program/);
      // Some free service is unlimited, so channel admission never blocks.
      expect(limiter.check({ buyerPeerId: BUYER })).toBeNull();
    });

    it('serves a stakers-only program only to buyers whose stake reaches a tier', () => {
      for (const storage of [persistentStorage(), null]) {
        const limiter = new SellerFreeTierLimiter({
          services: { 'staked-model': { maxRequestsPerAddress: 2, windowMs: 60_000, stakeTiers: [tier5x], stakersOnly: true } },
        }, storage);
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'staked-model', nowMs: 1_000 })).toMatchObject({
          allowed: false,
          limitedBy: 'stake_required',
          limit: 0,
          program: { base: { stakersOnly: true } },
        });
        // Stake below the lowest tier does not qualify either.
        const weak = { stakers: [OWNER], power: 99n * 10n ** 18n, positionIds: [1] };
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'staked-model', standing: weak, nowMs: 1_001 }))
          .toMatchObject({ allowed: false, limitedBy: 'stake_required', standing: weak });
        expect(limiter.consume({ buyerPeerId: BUYER, service: 'staked-model', standing: standing(tier5x), nowMs: 1_002 }))
          .toMatchObject({ allowed: true, limit: 10 });
        storage?.close();
      }
    });

    it('admits a free-usage channel when any program would still serve the buyer', () => {
      const limiter = new SellerFreeTierLimiter({
        maxRequestsPerAddress: 1,
        windowMs: 60_000,
        services: {
          'staked-model': { maxRequestsPerAddress: 1, stakeTiers: [tier5x], stakersOnly: true },
          'big-model': { maxRequestsPerAddress: 1 },
        },
      });
      limiter.consume({ buyerPeerId: BUYER, service: 'small-model', nowMs: 1_000 });
      expect(limiter.check({ buyerPeerId: BUYER, nowMs: 1_001 })).toMatchObject({ allowed: true });
      limiter.consume({ buyerPeerId: BUYER, service: 'big-model', nowMs: 1_002 });
      // Every program refuses: the seller-wide refusal is the one reported.
      expect(limiter.check({ buyerPeerId: BUYER, nowMs: 1_003 })).toMatchObject({ allowed: false, limitedBy: 'address' });
    });

    it('applies only a priced service\'s own program, and keeps it out of free-usage channel admission', () => {
      const limiter = new SellerFreeTierLimiter({
        maxRequestsPerAddress: 1,
        windowMs: 60_000,
        services: {
          k3: { maxRequestsPerAddress: 2, stakeTiers: [tier5x], stakersOnly: true },
          flash: { maxRequestsPerAddress: 2 },
        },
      });
      limiter.setPaidServices(['k3', 'flash', 'paid-model']);
      // The seller-wide program covers free services only.
      expect(limiter.appliesTo('paid-model', { paid: true })).toBe(false);
      expect(limiter.program('paid-model', { paid: true })).toBeNull();
      expect(limiter.appliesTo('k3', { paid: true })).toBe(true);
      expect(limiter.consume({ buyerPeerId: BUYER, service: 'k3', paid: true, nowMs: 1_000 }))
        .toMatchObject({ allowed: false, limitedBy: 'stake_required' });
      expect(limiter.consume({ buyerPeerId: BUYER, service: 'k3', paid: true, standing: standing(tier5x), nowMs: 1_001 }))
        .toMatchObject({ allowed: true, limit: 10 });
      limiter.consume({ buyerPeerId: BUYER, service: 'small-model', nowMs: 1_002 });
      // flash's allowance is left, but it never admits a channel for free services.
      expect(limiter.check({ buyerPeerId: BUYER, nowMs: 1_003 })).toMatchObject({ allowed: false, limitedBy: 'address' });
      expect(limiter.consume({ buyerPeerId: BUYER, service: 'flash', paid: true, nowMs: 1_004 }).allowed).toBe(true);
    });

    it('advertises service programs scoped by service, inheriting identical seller-wide tiers', () => {
      const limiter = new SellerFreeTierLimiter({
        maxRequestsPerAddress: 10,
        services: {
          'z-model': { maxRequestsPerAddress: 5, stakersOnly: true },
          'a-model': { maxRequestsPerIp: 3, windowMs: 3_600_000, stakeTiers: [tier5x] },
        },
      });
      limiter.setStakeResolver({ resolve: async () => null } as never);
      const a = freeTierServiceScope('a-model');
      const z = freeTierServiceScope('z-model');
      expect(limiter.capabilities()).toEqual([
        'free-tier.v1.base.a10.w86400000',
        'free-tier.v1.tier.p520000.x5',
        'free-tier.v1.tier.p2600000.x20',
        'free-tier.v1.tier.p10400000.x0',
        `free-tier.v1.${a}.base.i3.w3600000`,
        `free-tier.v1.${a}.tier.p100.x5`,
        `free-tier.v1.${z}.base.a5.w86400000.s1.t1`,
      ]);
      // A program never goes out in part: a-model does not fit in 5 strings, z-model still does.
      expect(limiter.capabilities(5)).toEqual([...limiter.capabilities().slice(0, 4), `free-tier.v1.${z}.base.a5.w86400000.s1.t1`]);
      const advertised = limiter.capabilities();
      expect(parseFreeTierProgram(advertised, 'z-model')).toEqual(limiter.program('z-model'));
      expect(parseFreeTierProgram(advertised, 'a-model')).toEqual(limiter.program('a-model'));
      expect(parseFreeTierProgram(advertised, 'other-model')).toEqual(limiter.program());
      expect(parseFreeTierProgram(advertised)).toEqual(limiter.program());
    });

    it('never advertises inherited tiers without the seller-wide program they point at', () => {
      const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 10, services: { 'z-model': { maxRequestsPerAddress: 5, stakersOnly: true } } });
      limiter.setStakeResolver({ resolve: async () => null } as never);
      for (let budget = 1; budget <= 8; budget++) {
        const advertised = limiter.capabilities(budget);
        // Whatever fits, every advertised program reads back whole.
        if (advertised.some((capability) => capability.includes(freeTierServiceScope('z-model')))) {
          expect(parseFreeTierProgram(advertised, 'z-model')).toEqual(limiter.program('z-model'));
        }
      }
      // Seller-wide needs 4 strings. With 3 it is skipped, and z-model then needs its 4 explicit strings too,
      // so nothing goes out rather than an inherited base that buyers could not read.
      expect(limiter.capabilities(3)).toEqual([]);
      expect(limiter.capabilities(4)).toHaveLength(4);
    });

    it('rejects a stakers-only program without tiers and a service program without base limits', () => {
      expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, stakeTiers: [], stakersOnly: true })).toThrow(/stakersOnly requires/);
      expect(() => new SellerFreeTierLimiter({ services: { m: { windowMs: 60_000 } } })).toThrow(/freeTier\.services\.m requires/);
      expect(() => new SellerFreeTierLimiter({ stakeTiers: [], services: { m: { maxRequestsPerAddress: 1 } } })).toThrow(/^freeTier requires/);
      expect(() => new SellerFreeTierLimiter({})).toThrow(/requires/);
    });

    it('rejects invalid tier programs', () => {
      expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, stakeTiers: [{ minPower: 0, multiplier: 2 }] })).toThrow(/minPower/);
      expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, stakeTiers: [{ minPower: 10, multiplier: 0 }] })).toThrow(/multiplier/);
      expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, stakeTiers: [{ minPower: 10, multiplier: 2 }, { minPower: 20, multiplier: 2 }] })).toThrow(/multiplier/);
      expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, stakersOnly: true, stakeTiers: [{ minPower: 10, multiplier: 1 }] })).not.toThrow();
      expect(() => new SellerFreeTierLimiter({
        maxRequestsPerAddress: 1,
        stakeTiers: [{ minPower: 10, multiplier: 'unlimited' }, { minPower: 20, multiplier: 5 }],
      })).toThrow(/unlimited/);
      expect(() => new SellerFreeTierLimiter({
        maxRequestsPerAddress: 1,
        stakeTiers: [{ minPower: 20, multiplier: 2 }, { minPower: 10, multiplier: 5 }],
      })).toThrow(/greater/);
    });
  });
});
