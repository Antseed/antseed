import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeteringStorage } from '../src/metering/storage.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { SellerFreeTierLimiter } from '../src/payments/seller-free-tier-limiter.js';
import { SellerFreeUsageManager } from '../src/payments/seller-free-usage-manager.js';
import {
  computeFreeUsageChannelId,
  FREE_USAGE_OPEN_TYPES,
  makeFreeUsageDomain,
} from '../src/payments/evm/signatures.js';

const buyer = identityFromPrivateKeyHex('22'.repeat(32));
const otherBuyer = identityFromPrivateKeyHex('33'.repeat(32));
const seller = identityFromPrivateKeyHex('11'.repeat(32));
const remoteIp = '192.0.2.10';
const config = {
  rpcUrl: 'http://127.0.0.1:8545',
  freeUsageContractAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  chainId: 31337,
};

async function signedOpen(saltByte = '44') {
  const salt = '0x' + saltByte.repeat(32);
  const channelId = computeFreeUsageChannelId(buyer.wallet.address, seller.wallet.address, salt);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const openSig = await buyer.wallet.signTypedData(
    makeFreeUsageDomain(config.chainId, config.freeUsageContractAddress),
    FREE_USAGE_OPEN_TYPES,
    { channelId, deadline: BigInt(deadline) },
  );
  return { channelId, salt, deadline, openSig };
}

function harness(limiter: SellerFreeTierLimiter | null) {
  const manager = new SellerFreeUsageManager(seller, config, limiter);
  const open = vi.spyOn(manager.client, 'open').mockResolvedValue('0xopen');
  const send = vi.fn();
  const mux = new PaymentMux({ send } as unknown as ConstructorParameters<typeof PaymentMux>[0]);
  return { manager, open, send, mux };
}

// handleOpen deliberately queues work and handles failures internally.
async function drainOpenQueue() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => vi.restoreAllMocks());

for (const persistent of [false, true]) {
  describe(`free channel admission (${persistent ? 'SQLite' : 'in-memory'})`, () => {
    let storage: MeteringStorage | null = null;
    afterEach(() => { storage?.close(); storage = null; });

    function limiter() {
      storage = persistent ? new MeteringStorage(':memory:') : null;
      return new SellerFreeTierLimiter({ maxRequestsPerAddress: 2, maxRequestsPerIp: 2, windowMs: 1000 }, storage);
    }

    it('blocks an exhausted IP even when the opening buyer has unused quota', async () => {
      const limit = limiter();
      const usage = { buyerPeerId: otherBuyer.peerId, remoteIp, service: 'free-model' };
      limit.consume(usage);
      limit.consume(usage);
      const { manager, open, send, mux } = harness(limit);
      manager.handleOpen(buyer.peerId, await signedOpen(), mux, '::ffff:' + remoteIp);
      await drainOpenQueue();
      expect(open).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      manager.reportUsageRequest(buyer.peerId, mux, { inputTokens: 1, outputTokens: 1 });
      expect(send).not.toHaveBeenCalled();
      expect(limit.check({ buyerPeerId: buyer.peerId, remoteIp }).limitedBy).toBe('ip');
    });

    it('blocks an exhausted address even when it changes IP', async () => {
      const limit = limiter();
      const usage = { buyerPeerId: buyer.peerId, remoteIp, service: 'free-model' };
      limit.consume(usage);
      limit.consume(usage);
      const { manager, open, send, mux } = harness(limit);
      manager.handleOpen(buyer.peerId, await signedOpen(), mux, '192.0.2.11');
      await drainOpenQueue();
      expect(open).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('allows repeated opens and checks without consuming inference quota', async () => {
      const limit = limiter();
      const input = { buyerPeerId: buyer.peerId, remoteIp };
      const { manager, open, send, mux } = harness(limit);
      for (const salt of ['44', '55', '66']) {
        expect(limit.check(input).allowed).toBe(true);
        manager.handleOpen(buyer.peerId, await signedOpen(salt), mux, remoteIp);
        await drainOpenQueue();
      }
      expect(open).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenCalledTimes(3);
      expect(limit.consume({ ...input, service: 'free-model' }).allowed).toBe(true);
      expect(limit.consume({ ...input, service: 'free-model' }).allowed).toBe(true);
      expect(limit.consume({ ...input, service: 'free-model' }).allowed).toBe(false);
    });

    it('allows admission again after usage ages out of the sliding window', () => {
      const limit = limiter();
      const input = { buyerPeerId: buyer.peerId, remoteIp, service: 'free-model', nowMs: 1000 };
      limit.consume(input);
      limit.consume(input);
      expect(limit.check({ ...input, nowMs: 2000 }).allowed).toBe(false);
      expect(limit.check({ ...input, nowMs: 2001 }).allowed).toBe(true);
      expect(limit.consume({ ...input, nowMs: 2001 }).allowed).toBe(true);
    });
  });
}

it('fails closed on an admission accounting error', async () => {
  const limit = new SellerFreeTierLimiter({ maxRequestsPerIp: 2 });
  vi.spyOn(limit, 'check').mockImplementation(() => { throw new Error('storage unavailable'); });
  const { manager, open, send, mux } = harness(limit);
  manager.handleOpen(buyer.peerId, await signedOpen(), mux, remoteIp);
  await drainOpenQueue();
  expect(open).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('checks quota when a queued open executes, not when it arrives', async () => {
  const limit = new SellerFreeTierLimiter({ maxRequestsPerIp: 1 });
  const { manager, open, send, mux } = harness(limit);
  let release!: (tx: string) => void;
  open.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
  manager.handleOpen(buyer.peerId, await signedOpen(), mux, remoteIp);
  await drainOpenQueue();
  expect(open).toHaveBeenCalledOnce();
  manager.handleOpen(buyer.peerId, await signedOpen('55'), mux, remoteIp);
  limit.consume({ buyerPeerId: otherBuyer.peerId, remoteIp, service: 'free-model' });
  release('0xopen');
  await drainOpenQueue();
  expect(open).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
});

it('preserves unlimited opening when no limiter is configured', async () => {
  const { manager, open, send, mux } = harness(null);
  manager.handleOpen(buyer.peerId, await signedOpen(), mux);
  await drainOpenQueue();
  expect(open).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
});
