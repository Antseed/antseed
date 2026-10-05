import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeteringStorage } from '../src/metering/storage.js';
import { SellerFreeTierLimiter, normalizeRemoteIp } from '../src/payments/seller-free-tier-limiter.js';

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
    expect(new SellerFreeTierLimiter({ maxRequestsPerAddress: 100, maxRequestsPerIp: 300 }).describe())
      .toBe('100 per buyer address, 300 per IP every 86400000ms');
    expect(new SellerFreeTierLimiter({ maxRequestsPerIp: 5, windowMs: 60_000 }).describe()).toBe('5 per IP every 60000ms');
  });
});
