import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { SpendingAuthPayload } from '../src/types/protocol.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { Wallet } from 'ethers';
import { signSpendingAuth, signReserveAuth, makeChannelsDomain, computeMetadataHash, encodeMetadata, ZERO_METADATA, ZERO_METADATA_HASH } from '../src/payments/evm/signatures.js';
import type { SpendingAuthMessage, ReserveAuthMessage, SpendingAuthMetadata } from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

function createMockPaymentMux(): PaymentMux & {
  sentAuthAcks: unknown[];
  sentNeedAuths: unknown[];
} {
  const mux = {
    sentAuthAcks: [] as unknown[],
    sentNeedAuths: [] as unknown[],
    sendSpendingAuth() {},
    sendAuthAck(payload: unknown) { mux.sentAuthAcks.push(payload); },
    sendPaymentRequired() {},
    sendNeedAuth(payload: unknown) { mux.sentNeedAuths.push(payload); },
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & {
    sentAuthAcks: unknown[];
    sentNeedAuths: unknown[];
  };
}

/** Build a valid SpendingAuth payload signed by the buyer's EVM wallet with dual sigs. */
async function buildSpendingAuth(
  buyerIdentity: Identity,
  _sellerIdentity: Identity,
  channelId: string,
  opts: {
    cumulativeAmount?: bigint;
    cumulativeInputTokens?: bigint;
    cumulativeOutputTokens?: bigint;
    salt?: string;
    deadline?: number;
    reserveMaxAmount?: string;
    isReserve?: boolean;
  } = {},
): Promise<SpendingAuthPayload> {
  const cumulativeAmount = opts.isReserve ? 0n : (opts.cumulativeAmount ?? 1_000_000n);
  const cumulativeInputTokens = opts.cumulativeInputTokens ?? 0n;
  const cumulativeOutputTokens = opts.cumulativeOutputTokens ?? 0n;
  const salt = opts.salt ?? '0x' + '01'.repeat(32);
  const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 3600;

  const meta: SpendingAuthMetadata = {
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeRequestCount: 0n,
  };
  const metadataHashHex = computeMetadataHash(meta);
  const encodedMetadata = encodeMetadata(meta);

  const buyerWallet = buyerIdentity.wallet;
  const sessionsDomain = makeChannelsDomain(CHAIN_ID, CONTRACT_ADDR);
  const reserveMaxAmount = BigInt(opts.reserveMaxAmount ?? '10000000');

  // First auth (reserve) uses ReserveAuth; subsequent uses SpendingAuth
  const isReserve = opts.isReserve ?? false;
  let spendingAuthSig: string;
  if (isReserve) {
    const reserveMsg: ReserveAuthMessage = { channelId, maxAmount: reserveMaxAmount, deadline: BigInt(deadline) };
    spendingAuthSig = await signReserveAuth(buyerWallet, sessionsDomain, reserveMsg);
  } else {
    const metadataMsg: SpendingAuthMessage = { channelId, cumulativeAmount, metadataHash: metadataHashHex };
    spendingAuthSig = await signSpendingAuth(buyerWallet, sessionsDomain, metadataMsg);
  }

  return {
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
    metadataHash: metadataHashHex,
    metadata: encodedMetadata,
    spendingAuthSig,
    reserveSalt: salt,
    reserveMaxAmount: reserveMaxAmount.toString(),
    reserveDeadline: deadline,
  };
}

function makeChannelId(n: number): string {
  return '0x' + n.toString(16).padStart(2, '0').repeat(32);
}

function makeOnChainChannel(buyer: Identity, seller: Identity, overrides: Record<string, unknown> = {}) {
  return {
    buyer: buyer.wallet.address,
    seller: seller.wallet.address,
    deposit: 2_000_000n,
    settled: 500_000n,
    metadataHash: ZERO_METADATA_HASH,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    settledAt: 0n,
    closeRequestedAt: 0n,
    status: 1,
    ...overrides,
  };
}

function makeInFlightTxLimitError(): Error & { error: { code: number; message: string }; code: string } {
  return Object.assign(new Error('could not coalesce error'), {
    error: {
      code: -32000,
      message: 'in-flight transaction limit reached for delegated accounts',
    },
    code: 'UNKNOWN_ERROR',
  });
}

describe('SellerPaymentManager', () => {
  let tempDir: string;
  let store: ChannelStore;
  let sellerIdentity: Identity;
  let buyerIdentity: Identity;
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-pm-test-'));
    store = new ChannelStore(tempDir);
    sellerIdentity = createTestIdentity();
    buyerIdentity = createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    vi.spyOn(manager.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');
    vi.spyOn(manager.channelsClient, 'close').mockResolvedValue('0xclose-hash');
    vi.spyOn(manager.channelsClient, 'requestClose').mockResolvedValue('0xrequesttimeout-hash');
    vi.spyOn(manager.channelsClient, 'withdraw').mockResolvedValue('0xwithdraw-hash');

    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_handleSpendingAuth_firstSign: calls reserve, sends AuthAck', async () => {
    const channelId = makeChannelId(1);

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });

    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(manager.channelsClient.reserve).toHaveBeenCalledOnce();
    expect(mux.sentAuthAcks.length).toBe(1);
    const ack = mux.sentAuthAcks[0] as Record<string, unknown>;
    expect(ack.channelId).toBe(channelId);

    const session = store.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.role).toBe('seller');
    expect(session!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(session!.latestBuyerSig).toBe(payload.spendingAuthSig);
    expect(session!.latestSpendingAuthSig).toBeNull();
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('retries overlapping initial reserves after delegated account transaction backpressure', async () => {
    vi.useFakeTimers();
    try {
      const otherBuyer = createTestIdentity();
      const channelId = makeChannelId(123);
      const otherChannelId = makeChannelId(124);
      const [payload, otherPayload] = await Promise.all([
        buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true }),
        buildSpendingAuth(otherBuyer, sellerIdentity, otherChannelId, { isReserve: true }),
      ]);
      const attemptsByBuyer = new Map<string, number>();
      vi.mocked(manager.channelsClient.reserve).mockImplementation(async (_signer, buyerAddress) => {
        const attempts = (attemptsByBuyer.get(buyerAddress) ?? 0) + 1;
        attemptsByBuyer.set(buyerAddress, attempts);
        if (attempts === 1) throw makeInFlightTxLimitError();
        return '0xreserve-hash';
      });

      const resultsPromise = Promise.all([
        manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux),
        manager.handleSpendingAuth(otherBuyer.peerId, otherPayload, mux),
      ]);
      await vi.waitFor(() => expect(manager.channelsClient.reserve).toHaveBeenCalledTimes(2));
      expect(mux.sentAuthAcks).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(250);
      await expect(resultsPromise).resolves.toEqual(['reserved', 'reserved']);

      expect(manager.channelsClient.reserve).toHaveBeenCalledTimes(4);
      expect(mux.sentAuthAcks).toHaveLength(2);
      expect(store.getChannel(channelId)?.status).toBe(CHANNEL_STATUS.ACTIVE);
      expect(store.getChannel(otherChannelId)?.status).toBe(CHANNEL_STATUS.ACTIVE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an initial reserve after transaction backpressure retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const channelId = makeChannelId(125);
      const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
      vi.mocked(manager.channelsClient.reserve).mockRejectedValue(makeInFlightTxLimitError());

      const resultPromise = manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);
      await vi.waitFor(() => expect(manager.channelsClient.reserve).toHaveBeenCalledOnce());
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe('rejected');
      expect(manager.channelsClient.reserve).toHaveBeenCalledTimes(6);
      expect(mux.sentAuthAcks).toHaveLength(0);
      expect(store.getChannel(channelId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a permanent initial reserve failure', async () => {
    const channelId = makeChannelId(124);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    vi.mocked(manager.channelsClient.reserve).mockRejectedValueOnce(new Error('execution reverted: InsufficientBalance'));

    await expect(manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux)).resolves.toBe('rejected');

    expect(manager.channelsClient.reserve).toHaveBeenCalledOnce();
    expect(mux.sentAuthAcks).toHaveLength(0);
    expect(store.getChannel(channelId)).toBeNull();
  });

  it('closes a prior signed channel before reserving a replacement channel', async () => {
    const priorChannelId = makeChannelId(110);
    const replacementChannelId = makeChannelId(111);

    const priorReserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorReserve, mux);
    const priorAuth = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      cumulativeAmount: 200_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorAuth, mux);

    vi.mocked(manager.channelsClient.close)
      .mockRejectedValueOnce(new Error('temporary RPC failure'))
      .mockResolvedValue('0xclose-hash');
    manager.onBuyerDisconnect(buyerIdentity.peerId);
    await vi.waitFor(() => {
      expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    });

    // The seller retains the durable active record after a close submission
    // failure while the buyer loses its local channel ID and presents a fresh
    // ReserveAuth.
    expect(store.getChannel(priorChannelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    vi.mocked(manager.channelsClient.close).mockClear();

    const replacement = await buildSpendingAuth(buyerIdentity, sellerIdentity, replacementChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, replacement, mux);

    expect(result).toBe('reserved');
    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(manager.channelsClient.close).toHaveBeenCalledWith(
      expect.anything(),
      priorChannelId,
      200_000n,
      priorAuth.metadata,
      priorAuth.spendingAuthSig,
    );
    expect(manager.channelsClient.reserve).toHaveBeenCalledTimes(2);
    expect(store.getChannel(priorChannelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(store.getChannel(replacementChannelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
  });

  it('shares an in-flight disconnect close and preserves the replacement session', async () => {
    const priorChannelId = makeChannelId(116);
    const replacementChannelId = makeChannelId(117);

    const priorReserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorReserve, mux);
    const priorAuth = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      cumulativeAmount: 200_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorAuth, mux);

    let resolveClose!: (value: string) => void;
    const closePromise = new Promise<string>((resolve) => { resolveClose = resolve; });
    vi.mocked(manager.channelsClient.close).mockReturnValue(closePromise);

    manager.onBuyerDisconnect(buyerIdentity.peerId);
    await vi.waitFor(() => {
      expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    });

    const replacement = await buildSpendingAuth(buyerIdentity, sellerIdentity, replacementChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    const replacementPromise = manager.handleSpendingAuth(buyerIdentity.peerId, replacement, mux);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(manager.channelsClient.reserve).toHaveBeenCalledOnce();

    resolveClose('0xclose-hash');
    await expect(replacementPromise).resolves.toBe('reserved');

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(manager.channelsClient.reserve).toHaveBeenCalledTimes(2);
    expect(store.getChannel(priorChannelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(store.getChannel(replacementChannelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(manager.getChannelByPeer(buyerIdentity.peerId)?.sessionId).toBe(replacementChannelId);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('keeps the replacement session active when a superseded channel is evicted afterwards', async () => {
    const priorChannelId = makeChannelId(118);
    const replacementChannelId = makeChannelId(119);

    const priorReserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorReserve, mux);
    const priorAuth = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      cumulativeAmount: 200_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorAuth, mux);

    const replacement = await buildSpendingAuth(buyerIdentity, sellerIdentity, replacementChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });

    // checkTimeouts snapshots the active channels before it awaits getSession.
    // Negotiate the replacement inside that await so the eviction below runs
    // against a channel the buyer has already moved off of.
    let negotiated = false;
    vi.spyOn(manager.channelsClient, 'getSession').mockImplementation(async () => {
      if (!negotiated) {
        negotiated = true;
        await manager.handleSpendingAuth(buyerIdentity.peerId, replacement, mux);
      }
      // Prior channel is already closed on-chain — checkTimeouts evicts it locally.
      return makeOnChainChannel(buyerIdentity, sellerIdentity, { status: 2 });
    });

    await manager.checkTimeouts();

    // Evicting the superseded channel must not deactivate the buyer, who now
    // belongs to the replacement channel.
    expect(store.getChannel(priorChannelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(store.getChannel(replacementChannelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(manager.getChannelByPeer(buyerIdentity.peerId)?.sessionId).toBe(replacementChannelId);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('closes a zero-spend prior channel before reserving a replacement channel', async () => {
    const priorChannelId = makeChannelId(112);
    const replacementChannelId = makeChannelId(113);

    const priorReserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorReserve, mux);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );

    const replacement = await buildSpendingAuth(buyerIdentity, sellerIdentity, replacementChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, replacement, mux);

    expect(result).toBe('reserved');
    expect(manager.channelsClient.close).toHaveBeenCalledWith(
      expect.anything(), priorChannelId, 0n, '0x', '0x',
    );
    expect(manager.channelsClient.reserve).toHaveBeenCalledTimes(2);
    expect(store.getChannel(priorChannelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(store.getChannel(replacementChannelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
  });

  it('keeps the prior channel active and rejects replacement reserve when close fails', async () => {
    const priorChannelId = makeChannelId(114);
    const replacementChannelId = makeChannelId(115);

    const priorReserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, priorChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, priorReserve, mux);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );
    vi.mocked(manager.channelsClient.close).mockRejectedValue(new Error('temporary RPC failure'));

    const replacement = await buildSpendingAuth(buyerIdentity, sellerIdentity, replacementChannelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, replacement, mux);

    expect(result).toBe('rejected');
    expect(manager.channelsClient.reserve).toHaveBeenCalledOnce();
    expect(store.getChannel(priorChannelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(store.getChannel(replacementChannelId)).toBeNull();
  });

  it('test_handleSpendingAuth_subsequent: validates monotonic increase', async () => {

    const channelId = makeChannelId(2);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);

    expect(mux.sentAuthAcks.length).toBe(1);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  it('accepts first reserve with zero metadata', async () => {
    const channelId = makeChannelId(24);

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    payload.metadata = encodeMetadata(ZERO_METADATA);
    payload.metadataHash = ZERO_METADATA_HASH;

    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(result).toBe('reserved');
    expect(manager.channelsClient.reserve).toHaveBeenCalledOnce();
    expect(mux.sentAuthAcks.length).toBe(1);
    expect(store.getChannel(channelId)!.latestMetadata).toBe(encodeMetadata(ZERO_METADATA));
  });

  it('rejects SpendingAuth when raw metadata does not match signed metadataHash', async () => {
    const channelId = makeChannelId(22);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
      cumulativeInputTokens: 100n,
      cumulativeOutputTokens: 50n,
    });
    payload.metadata = encodeMetadata({
      cumulativeInputTokens: 999n,
      cumulativeOutputTokens: 50n,
      cumulativeRequestCount: 0n,
    });

    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(result).toBe('rejected');
    expect(manager.getAcceptedCumulative(channelId)).toBe(0n);
    expect(store.getChannel(channelId)!.latestMetadata).toBe(reservePayload.metadata);
  });

  it('rejects SpendingAuth when raw metadata is malformed non-hex', async () => {
    const channelId = makeChannelId(25);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
    });
    payload.metadata = 'not-hex';

    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(result).toBe('rejected');
    expect(manager.getAcceptedCumulative(channelId)).toBe(0n);
    expect(store.getChannel(channelId)!.latestMetadata).toBe(reservePayload.metadata);
  });

  it('waitForPendingAuths drains queued SpendingAuths while an on-chain top-up is in flight', async () => {
    const channelId = makeChannelId(99);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);
    expect(manager.getAcceptedCumulative(channelId)).toBe(900_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(900_000n);

    let releaseTopUp!: () => void;
    const topUpBlocker = new Promise<void>((resolve) => { releaseTopUp = resolve; });
    const topUpSpy = vi.spyOn(manager.channelsClient, 'topUp').mockImplementation(async () => {
      await topUpBlocker;
      return '0xtopup-hash';
    });

    const topUpPayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '02'.repeat(32),
    });
    const topUpPromise = manager.handleSpendingAuth(buyerIdentity.peerId, topUpPayload, mux);

    while (topUpSpy.mock.calls.length === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }

    const followUpPayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 1_500_000n,
      reserveMaxAmount: '2000000',
    });
    const followUpPromise = manager.handleSpendingAuth(buyerIdentity.peerId, followUpPayload, mux);
    await new Promise<void>((r) => setImmediate(r));

    expect(manager.getAcceptedCumulative(channelId)).toBe(900_000n);

    let waitResolved = false;
    const waitPromise = manager
      .waitForPendingAuths(buyerIdentity.peerId)
      .then(() => { waitResolved = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(waitResolved).toBe(false);

    releaseTopUp();
    await Promise.all([topUpPromise, followUpPromise, waitPromise]);

    expect(waitResolved).toBe(true);
    expect(manager.getAcceptedCumulative(channelId)).toBe(1_500_000n);
    expect(manager.getCumulativeSpend(channelId) >= manager.getAcceptedCumulative(channelId)).toBe(false);
  });

  it('tracks the largest pending top-up ceiling while retries are deferred', async () => {
    const channelId = makeChannelId(100);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);

    const topUpSpy = vi.spyOn(manager.channelsClient, 'topUp')
      .mockRejectedValue(new Error('TopUpThresholdNotMet'));

    const topUp2m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '02'.repeat(32),
    });
    const topUp3m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '3000000',
      salt: '0x' + '03'.repeat(32),
    });

    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp2m, mux)).toBe('accepted');
    expect(manager.hasPendingTopUp(channelId)).toBe(true);
    expect(manager.getEffectiveReserveMax(channelId)).toBe(1_000_000n);

    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp3m, mux)).toBe('accepted');
    expect(manager.hasPendingTopUp(channelId)).toBe(true);
    expect(manager.getEffectiveReserveMax(channelId)).toBe(1_000_000n);
    expect(manager.getReserveMax(channelId)).toBe(1_000_000n);
    expect(topUpSpy).toHaveBeenCalledTimes(2);
    expect(topUpSpy.mock.calls[1]?.[5]).toBe(3_000_000n);
  });

  it('defers top-up when delegated account tx backpressure rejects submission', async () => {
    const channelId = makeChannelId(106);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);

    const topUpSpy = vi.spyOn(manager.channelsClient, 'topUp')
      .mockRejectedValue(makeInFlightTxLimitError());

    const topUp2m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '08'.repeat(32),
    });

    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp2m, mux)).toBe('accepted');
    expect(topUpSpy).toHaveBeenCalledOnce();
    expect(manager.hasPendingTopUp(channelId)).toBe(true);
    expect(manager.getReserveMax(channelId)).toBe(1_000_000n);
    expect(manager.isChannelBlocked(channelId)).toBe(false);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(manager.channelsClient.close).not.toHaveBeenCalled();
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
  });

  it('rejects a top-up that fails because buyer deposits are insufficient', async () => {
    const channelId = makeChannelId(103);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);

    vi.spyOn(manager.channelsClient, 'topUp').mockRejectedValue(new Error('execution reverted: InsufficientBalance'));

    const topUp2m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '05'.repeat(32),
    });

    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp2m, mux)).toBe('rejected');
    expect(manager.channelsClient.settle).not.toHaveBeenCalled();
    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeArgs[1]).toBe(channelId);
    expect(closeArgs[2]).toBe(900_000n);
    expect(closeArgs[4]).toBe(auth900k.spendingAuthSig);
    expect(manager.hasPendingTopUp(channelId)).toBe(false);
    expect(manager.isChannelBlocked(channelId)).toBe(false);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
  });

  it('blocks the channel if permanent top-up failure cannot close immediately', async () => {
    const channelId = makeChannelId(105);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);

    vi.spyOn(manager.channelsClient, 'topUp').mockRejectedValue(new Error('execution reverted: InsufficientBalance'));
    vi.spyOn(manager.channelsClient, 'close').mockRejectedValue(new Error('close estimate failed'));

    const topUp2m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '07'.repeat(32),
    });

    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp2m, mux)).toBe('rejected');
    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(manager.hasPendingTopUp(channelId)).toBe(false);
    expect(manager.isChannelBlocked(channelId)).toBe(true);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
  });

  it('keeps a deferred top-up pending when retry hits delegated account tx backpressure', async () => {
    const channelId = makeChannelId(107);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);

    const topUpSpy = vi.spyOn(manager.channelsClient, 'topUp')
      .mockRejectedValueOnce(new Error('TopUpThresholdNotMet'))
      .mockRejectedValueOnce(makeInFlightTxLimitError());

    const topUp2m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '09'.repeat(32),
    });
    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp2m, mux)).toBe('accepted');
    expect(manager.hasPendingTopUp(channelId)).toBe(true);

    const withinReserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 950_000n,
      reserveMaxAmount: '1000000',
    });
    delete withinReserve.reserveSalt;
    delete withinReserve.reserveMaxAmount;
    delete withinReserve.reserveDeadline;
    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, withinReserve, mux)).toBe('accepted');

    expect(topUpSpy).toHaveBeenCalledTimes(2);
    expect(manager.hasPendingTopUp(channelId)).toBe(true);
    expect(manager.getReserveMax(channelId)).toBe(1_000_000n);
    expect(manager.isChannelBlocked(channelId)).toBe(false);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(manager.channelsClient.close).not.toHaveBeenCalled();
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
  });

  it('closes the channel if a deferred top-up retry fails permanently', async () => {
    const channelId = makeChannelId(104);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);

    const topUpSpy = vi.spyOn(manager.channelsClient, 'topUp')
      .mockRejectedValueOnce(new Error('TopUpThresholdNotMet'))
      .mockRejectedValueOnce(new Error('execution reverted: InsufficientBalance'));

    const topUp2m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '06'.repeat(32),
    });
    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp2m, mux)).toBe('accepted');
    expect(manager.hasPendingTopUp(channelId)).toBe(true);

    const withinReserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 950_000n,
      reserveMaxAmount: '1000000',
    });
    delete withinReserve.reserveSalt;
    delete withinReserve.reserveMaxAmount;
    delete withinReserve.reserveDeadline;
    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, withinReserve, mux)).toBe('accepted');

    expect(topUpSpy).toHaveBeenCalledTimes(2);
    expect(manager.channelsClient.settle).not.toHaveBeenCalled();
    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeArgs[1]).toBe(channelId);
    expect(closeArgs[2]).toBe(950_000n);
    expect(closeArgs[4]).toBe(withinReserve.spendingAuthSig);
    expect(manager.hasPendingTopUp(channelId)).toBe(false);
    expect(manager.isChannelBlocked(channelId)).toBe(false);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
  });

  it('serializes a burst of concurrent SpendingAuth updates and ends at the latest cumulative amount', async () => {
    const channelId = makeChannelId(101);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '3000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const cumulatives = [
      1_100_000n,
      1_200_000n,
      1_300_000n,
      1_400_000n,
      1_500_000n,
      1_600_000n,
      1_700_000n,
      1_800_000n,
      1_900_000n,
      2_000_000n,
    ];

    const payloads = await Promise.all(cumulatives.map((amount) =>
      buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
        cumulativeAmount: amount,
        reserveMaxAmount: '3000000',
      })
    ));

    const results = await Promise.all(payloads.map((payload) =>
      manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux)
    ));

    expect(results.every((result) => result === 'accepted')).toBe(true);
    expect(manager.getAcceptedCumulative(channelId)).toBe(2_000_000n);
  });

  it('handleSpendingAuth ignores pending top-up headroom until on-chain reserve max is updated', async () => {
    const channelId = makeChannelId(102);

    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);

    vi.spyOn(manager.channelsClient, 'topUp').mockRejectedValue(new Error('TopUpThresholdNotMet'));

    const topUp2m = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '04'.repeat(32),
    });
    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, topUp2m, mux)).toBe('accepted');
    expect(manager.hasPendingTopUp(channelId)).toBe(true);
    expect(manager.getReserveMax(channelId)).toBe(1_000_000n);
    expect(manager.getEffectiveReserveMax(channelId)).toBe(1_000_000n);

    const followUp = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 1_500_000n,
      reserveMaxAmount: '2000000',
    });

    expect(await manager.handleSpendingAuth(buyerIdentity.peerId, followUp, mux)).toBe('rejected');
    expect(manager.getAcceptedCumulative(channelId)).toBe(900_000n);
  });

  it('recovers an active on-chain channel when local seller session is missing', async () => {
    const channelId = makeChannelId(21);
    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue({
      buyer: buyerIdentity.wallet.address,
      seller: sellerIdentity.wallet.address,
      deposit: 1_000_000n,
      settled: 50_000n,
      metadataHash: ZERO_METADATA_HASH,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      settledAt: 0n,
      closeRequestedAt: 0n,
      status: 1,
    });

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
      reserveMaxAmount: undefined,
    });
    delete payload.reserveSalt;
    delete payload.reserveMaxAmount;
    delete payload.reserveDeadline;

    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(result).toBe('accepted');
    expect(manager.channelsClient.reserve).not.toHaveBeenCalled();
    expect(manager.channelsClient.getSession).toHaveBeenCalledWith(channelId);
    expect(mux.sentAuthAcks.length).toBe(1);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(50_000n);

    const session = store.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(session!.previousConsumption).toBe('1000000');
    expect(session!.tokensDelivered).toBe('50000');
  });

  it('rejects recovered on-chain session when raw metadata does not match signed metadataHash', async () => {
    const channelId = makeChannelId(23);
    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue({
      buyer: buyerIdentity.wallet.address,
      seller: sellerIdentity.wallet.address,
      deposit: 1_000_000n,
      settled: 50_000n,
      metadataHash: ZERO_METADATA_HASH,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      settledAt: 0n,
      closeRequestedAt: 0n,
      status: 1,
    });

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
      cumulativeInputTokens: 100n,
      cumulativeOutputTokens: 50n,
      reserveMaxAmount: undefined,
    });
    delete payload.reserveSalt;
    delete payload.reserveMaxAmount;
    delete payload.reserveDeadline;
    payload.metadata = encodeMetadata({
      cumulativeInputTokens: 999n,
      cumulativeOutputTokens: 50n,
      cumulativeRequestCount: 0n,
    });

    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(result).toBe('rejected');
    expect(manager.channelsClient.reserve).not.toHaveBeenCalled();
    expect(manager.channelsClient.getSession).not.toHaveBeenCalled();
    expect(mux.sentAuthAcks.length).toBe(0);
    expect(store.getChannel(channelId)).toBeNull();
  });

  it('awaitAcceptedAtLeast resolves when a SpendingAuth raises accepted to the target', async () => {
    const channelId = makeChannelId(77);
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    // Simulate the race: the request handler is waiting for accepted >= spent
    // while the buyer's catch-up SpendingAuth is still on the wire.
    const waitPromise = manager.awaitAcceptedAtLeast(channelId, 500_000n, 2_000);

    // A late-arriving SpendingAuth unblocks the waiter in a single tick — the
    // request handler resumes instead of emitting a spurious 402.
    const catchUp = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 500_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, catchUp, mux);

    await expect(waitPromise).resolves.toBe(true);
    expect(manager.getAcceptedCumulative(channelId)).toBe(500_000n);
  });

  it('awaitAcceptedAtLeast returns true immediately when the target is already satisfied', async () => {
    const channelId = makeChannelId(78);
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);
    const authPayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 300_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, authPayload, mux);

    await expect(manager.awaitAcceptedAtLeast(channelId, 200_000n, 1_000)).resolves.toBe(true);
  });

  it('awaitAcceptedAtLeast times out with false when the SpendingAuth never arrives', async () => {
    const channelId = makeChannelId(79);
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    await expect(manager.awaitAcceptedAtLeast(channelId, 500_000n, 50)).resolves.toBe(false);
  });

  it('awaitAcceptedAtLeast resolves false when the channel is closed before the target is reached', async () => {
    const channelId = makeChannelId(80);
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    const waitPromise = manager.awaitAcceptedAtLeast(channelId, 500_000n, 5_000);

    // Channel eviction (CloseRequested, settle, timeout) must wake waiters
    // with `false` so the request handler correctly 402s instead of being
    // told the target was reached when it wasn't.
    await manager.handleCloseRequested(channelId);

    await expect(waitPromise).resolves.toBe(false);
  });

  it('test_recordSpend: tracks cumulative spend', async () => {

    const channelId = makeChannelId(3);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    manager.recordSpend(channelId, 50_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(50_000n);

    manager.recordSpend(channelId, 30_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(80_000n);
  });

  it('test_getChannelByPeer: returns active channel', async () => {

    const channelId = makeChannelId(4);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    const channel = manager.getChannelByPeer(buyerIdentity.peerId);
    expect(channel).not.toBeNull();
    expect(channel!.sessionId).toBe(channelId);
  });

  describe('retained channel reconnect', () => {
    let channelId: string;

    beforeEach(async () => {
      manager = new SellerPaymentManager(sellerIdentity, {
        rpcUrl: 'http://127.0.0.1:1', channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID, dataDir: tempDir, settleOnDisconnect: false,
      }, store);
      vi.spyOn(manager.channelsClient, 'reserve').mockResolvedValue('0xreserve');
      vi.spyOn(manager.channelsClient, 'close').mockResolvedValue('0xclose');
      vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(makeOnChainChannel(buyerIdentity, sellerIdentity, {
        buyer: buyerIdentity.wallet.address, seller: sellerIdentity.wallet.address,
        deposit: 10_000_000n, settled: 0n,
      }));
      channelId = makeChannelId(90);
      const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
      expect(await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux)).toBe('reserved');
      mux.sentAuthAcks.length = 0;
    });

    it.each([0n, 25_000n])('acknowledges a replay at %s without changing earned spend', async (amount) => {
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: amount });
      await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
      manager.recordSpend(channelId, amount);
      const stored = store.getChannel(channelId);
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      mux.sentAuthAcks.length = 0;
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

      expect(await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux)).toBe('accepted');
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(mux.sentAuthAcks).toEqual([{ channelId }]);
      expect(manager.getAcceptedCumulative(channelId)).toBe(amount);
      expect(manager.getCumulativeSpend(channelId)).toBe(amount);
      expect(store.getChannel(channelId)).toEqual(stored);
    });

    it('acknowledges a higher catch-up authorization on reconnect', async () => {
      manager.recordSpend(channelId, 25_000n);
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 25_000n });
      expect(await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux)).toBe('accepted');
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(mux.sentAuthAcks).toEqual([{ channelId }]);
      expect(manager.getCumulativeSpend(channelId)).toBe(25_000n);
      expect(store.getChannel(channelId)?.latestSpendingAuthSig).toBe(auth.spendingAuthSig);
    });

    it('re-acknowledges a duplicate if the previous acknowledgment was lost', async () => {
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 0n });
      await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
      await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
      expect(mux.sentAuthAcks).toEqual([{ channelId }, { channelId }]);
      expect(manager.channelsClient.getSession).not.toHaveBeenCalled();
    });

    it('retains earned authorization queued before a disconnect without reactivating the buyer', async () => {
      manager.recordSpend(channelId, 25_000n);
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 25_000n });
      const acceptance = manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      expect(await acceptance).toBe('accepted');
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(mux.sentAuthAcks).toEqual([]);
      expect(store.getChannel(channelId)?.latestSpendingAuthSig).toBe(auth.spendingAuthSig);
      expect(manager.getCumulativeSpend(channelId)).toBe(25_000n);
      await manager.checkTimeouts();
      expect(manager.channelsClient.close).toHaveBeenCalledWith(
        expect.anything(), channelId, 25_000n, auth.metadata, auth.spendingAuthSig,
      );
    });

    it('retains earned authorization when reconnect validation cannot read the chain', async () => {
      manager.recordSpend(channelId, 25_000n);
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      vi.mocked(manager.channelsClient.getSession).mockRejectedValue(new Error('RPC unavailable'));
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 25_000n });
      expect(await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux)).toBe('accepted');
      expect(store.getChannel(channelId)?.latestSpendingAuthSig).toBe(auth.spendingAuthSig);
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(mux.sentAuthAcks).toEqual([]);
    });

    it('does not reactivate after a disconnect close fails during a pending top-up', async () => {
      manager.recordSpend(channelId, 25_000n);
      manager['_pendingTopUp'].set(channelId, {
        newMaxAmount: 20_000_000n, deadline: Math.floor(Date.now() / 1000) + 3600, reserveAuthSig: '0x',
      });
      let release!: () => void;
      let started!: () => void;
      const toppingUp = new Promise<void>((resolve) => { started = resolve; });
      vi.spyOn(manager.channelsClient, 'topUp').mockImplementation(async () => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return '0xtopup';
      });
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 25_000n });
      const acceptance = manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
      await toppingUp;
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      vi.mocked(manager.channelsClient.close).mockRejectedValue(makeInFlightTxLimitError());
      await manager.settleSession(buyerIdentity.peerId, { cleanupOnFailure: true });
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      release();
      expect(await acceptance).toBe('accepted');
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(mux.sentAuthAcks).toEqual([]);
      expect(store.getChannel(channelId)?.latestSpendingAuthSig).toBe(auth.spendingAuthSig);
    });

    it('validates hydrated channels before acknowledging their authorization', async () => {
      const restored = new SellerPaymentManager(sellerIdentity, {
        rpcUrl: 'http://127.0.0.1:1', channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID, dataDir: tempDir,
      }, store);
      vi.spyOn(restored.channelsClient, 'getSession').mockResolvedValue(makeOnChainChannel(buyerIdentity, sellerIdentity, { status: 2 }));
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 0n });
      expect(await restored.handleSpendingAuth(buyerIdentity.peerId, auth, mux)).toBe('rejected');
      expect(restored.channelsClient.getSession).toHaveBeenCalledOnce();
      expect(mux.sentAuthAcks).toEqual([]);
    });

    it.each([
      { name: 'closed', override: { status: 2 } },
      { name: 'withdrawn', override: { status: 3 } },
      { name: 'wrong buyer', override: { buyer: '0x' + '11'.repeat(20) } },
      { name: 'wrong seller', override: { seller: '0x' + '22'.repeat(20) } },
      { name: 'close requested', override: { closeRequestedAt: 1n } },
      { name: 'already settled above the replay', override: { settled: 1n } },
    ])('does not reactivate a channel that is $name', async ({ override }) => {
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      vi.mocked(manager.channelsClient.getSession).mockResolvedValue(makeOnChainChannel(buyerIdentity, sellerIdentity, {
        buyer: buyerIdentity.wallet.address, seller: sellerIdentity.wallet.address,
        deposit: 10_000_000n, settled: 0n, ...override,
      }));
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 0n });
      expect(await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux)).toBe('rejected');
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(mux.sentAuthAcks).toEqual([]);
    });

    it('does not reactivate on an invalid signature or an unavailable chain read', async () => {
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 0n });
      expect(await manager.handleSpendingAuth(buyerIdentity.peerId, { ...auth, spendingAuthSig: '0x' }, mux)).toBe('rejected');
      expect(manager.channelsClient.getSession).not.toHaveBeenCalled();
      vi.mocked(manager.channelsClient.getSession).mockRejectedValue(new Error('RPC unavailable'));
      expect(await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux)).toBe('rejected');
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(mux.sentAuthAcks).toEqual([]);
    });

    it.each(['close', 'disconnect'] as const)('does not reactivate when another %s occurs during validation', async (event) => {
      manager.onBuyerDisconnect(buyerIdentity.peerId);
      const state = await manager.channelsClient.getSession(channelId);
      let release!: () => void;
      let started!: () => void;
      const reading = new Promise<void>((resolve) => { started = resolve; });
      vi.mocked(manager.channelsClient.getSession).mockImplementation(async () => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return state;
      });
      const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 0n });
      const result = manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
      await reading;
      if (event === 'close') await manager.settleSession(buyerIdentity.peerId);
      else manager.onBuyerDisconnect(buyerIdentity.peerId);
      release();
      expect(await result).toBe('rejected');
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(mux.sentAuthAcks).toEqual([]);
    });
  });

  it('test_onBuyerDisconnect: session persisted, not closed when settleOnDisconnect=false', async () => {
    const config2: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
      settleOnDisconnect: false,
    };
    const manager2 = new SellerPaymentManager(sellerIdentity, config2, store);
    vi.spyOn(manager2.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager2.channelsClient, 'close').mockResolvedValue('0xclose-hash');


    const channelId = makeChannelId(5);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager2.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(true);
    manager2.onBuyerDisconnect(buyerIdentity.peerId);
    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(false);

    const session = store.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(manager2.channelsClient.close).not.toHaveBeenCalled();
  });

  it('test_onBuyerDisconnect_close: calls close with valid metadata from latest auth', async () => {
    const channelId = makeChannelId(10);

    // Reserve
    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Accept a SpendingAuth with real metadata
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
      cumulativeInputTokens: 100n,
      cumulativeOutputTokens: 500n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);

    // Record some spend so close() is attempted (not zero-cumulative deferral)
    manager.recordSpend(channelId, 50_000n);

    manager.onBuyerDisconnect(buyerIdentity.peerId);

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0];
    // closeArgs: [signer, channelId, cumulativeAmount, metadata, buyerSig]
    const metadata = closeArgs[3] as string;
    expect(metadata).not.toBe('');
    expect(metadata.startsWith('0x')).toBe(true);
  });

  it('test_onBuyerDisconnect_close_empty_metadata: normalizes empty zero-metadata auth before settling', async () => {
    const channelId = makeChannelId(11);

    // Reserve
    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Empty metadata is accepted only when paired with the zero metadata hash;
    // settle params mirror the contract-facing fallback to encoded zero metadata.
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    payload2.metadata = '';
    payload2.metadataHash = ZERO_METADATA_HASH;
    payload2.spendingAuthSig = await signSpendingAuth(buyerIdentity.wallet, makeChannelsDomain(CHAIN_ID, CONTRACT_ADDR), {
      channelId,
      cumulativeAmount: 200_000n,
      metadataHash: ZERO_METADATA_HASH,
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);

    expect(result).toBe('accepted');
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);

    manager.recordSpend(channelId, 50_000n);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeArgs[1]).toBe(channelId);
    expect(closeArgs[2]).toBe(200_000n);
    expect(closeArgs[3]).toBe(encodeMetadata(ZERO_METADATA));
    expect(closeArgs[4]).toBe(payload2.spendingAuthSig);
  });

  it('keeps session state when close hits delegated account tx backpressure on disconnect', async () => {
    const channelId = makeChannelId(13);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);
    manager.recordSpend(channelId, 50_000n);

    vi.spyOn(manager.channelsClient, 'close').mockRejectedValue(makeInFlightTxLimitError());

    manager.onBuyerDisconnect(buyerIdentity.peerId);
    while ((manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    await new Promise<void>((r) => setImmediate(r));

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );
    (manager.channelsClient.close as ReturnType<typeof vi.fn>).mockResolvedValue('0xclose-hash');

    await manager.checkTimeouts();

    expect(manager.channelsClient.close).toHaveBeenCalledTimes(2);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
  });

  it('settleSession suppresses duplicate in-flight close attempts for the same channel', async () => {
    const channelId = makeChannelId(12);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);
    manager.recordSpend(channelId, 50_000n);

    let resolveClose!: (value: string) => void;
    const closePromise = new Promise<string>((resolve) => { resolveClose = resolve; });
    vi.spyOn(manager.channelsClient, 'close').mockReturnValue(closePromise);

    const first = manager.settleSession(buyerIdentity.peerId);
    const second = manager.settleSession(buyerIdentity.peerId);

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    resolveClose('0xclose-hash');
    await Promise.all([first, second]);
  });

  it('records the amount actually submitted when joining an in-flight close', async () => {
    const channelId = makeChannelId(120);

    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
    const firstAuth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, firstAuth, mux);

    let resolveClose!: (value: string) => void;
    const closePromise = new Promise<string>((resolve) => { resolveClose = resolve; });
    vi.mocked(manager.channelsClient.close).mockReturnValue(closePromise);

    const first = manager.settleSession(buyerIdentity.peerId);
    expect(manager.channelsClient.close).toHaveBeenCalledWith(
      expect.anything(), channelId, 200_000n, expect.anything(), expect.anything(),
    );

    // A later auth raises the local cumulative while the close is still in flight.
    const laterAuth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 400_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, laterAuth, mux);

    const second = manager.settleSession(buyerIdentity.peerId);
    resolveClose('0xclose-hash');
    await Promise.all([first, second]);

    // The joiner must not claim its own (higher) cumulative was settled — only
    // 200_000 was ever submitted on-chain.
    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(store.getChannel(channelId)!.settledAmount).toBe('200000');
  });

  it('rejects SpendingAuth when cumulative exceeds on-chain deposit', async () => {
    const channelId = makeChannelId(40);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Accept a SpendingAuth within deposit (reserveMax defaults to 10,000,000)
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);

    // Set reserveMax to 300,000 to simulate a small deposit
    (manager as unknown as { _reserveMax: Map<string, bigint> })._reserveMax.set(channelId, 300_000n);

    // Try to accept a SpendingAuth that exceeds the deposit — should be rejected
    const payload3 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 500_000n,
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload3, mux);
    expect(result).toBe('rejected');

    // Cumulative should remain at the last valid value
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  it('accepts SpendingAuth within deposit ceiling', async () => {
    const channelId = makeChannelId(41);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Accept SpendingAuth within default deposit (10,000,000)
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);
    expect(result).toBe('accepted');
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  it('test_hasSession: returns true/false correctly', async () => {

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

    const channelId = makeChannelId(7);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(manager.hasSession('nonexistent-peer')).toBe(false);
  });

  it('checkTimeouts retries the latest SpendingAuth after a disconnect close failure', async () => {
    const channelId = makeChannelId(69);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);

    const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 300_000n,
      cumulativeInputTokens: 10n,
      cumulativeOutputTokens: 20n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
    manager.recordSpend(channelId, 300_000n);

    const closeSpy = manager.channelsClient.close as ReturnType<typeof vi.fn>;
    closeSpy.mockRejectedValueOnce(new Error('estimate failed')).mockResolvedValue('0xclose-hash');

    manager.onBuyerDisconnect(buyerIdentity.peerId);
    while (closeSpy.mock.calls.length === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    await new Promise<void>((r) => setImmediate(r));

    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
    expect(manager.getAcceptedCumulative(channelId)).toBe(300_000n);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );

    await manager.checkTimeouts();

    expect(closeSpy).toHaveBeenCalledTimes(2);
    const retryArgs = closeSpy.mock.calls[1]!;
    expect(retryArgs[1]).toBe(channelId);
    expect(retryArgs[2]).toBe(300_000n);
    expect(retryArgs[3]).toBe(auth.metadata);
    expect(retryArgs[4]).toBe(auth.spendingAuthSig);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(store.getChannel(channelId)!.settledAmount).toBe('300000');
  });

  it('stops retrying and persists timeout after signed close retries are exhausted', async () => {
    const channelId = makeChannelId(76);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);

    const auth = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 300_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);
    manager.recordSpend(channelId, 300_000n);

    const closeSpy = manager.channelsClient.close as ReturnType<typeof vi.fn>;
    closeSpy.mockRejectedValue(new Error('execution reverted: InvalidSignature'));

    await manager.settleSession(buyerIdentity.peerId);
    await manager.settleSession(buyerIdentity.peerId);
    await manager.settleSession(buyerIdentity.peerId);
    await manager.settleSession(buyerIdentity.peerId);

    expect(closeSpy).toHaveBeenCalledTimes(3);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.TIMEOUT);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

    const restarted = new SellerPaymentManager(sellerIdentity, {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    }, store);
    const restartedCloseSpy = vi.spyOn(restarted.channelsClient, 'close').mockResolvedValue('0xclose-hash');

    await restarted.checkTimeouts();

    expect(restarted.hasSession(buyerIdentity.peerId)).toBe(false);
    expect(restartedCloseSpy).not.toHaveBeenCalled();
  });

  it('checkTimeouts closes zombie channels on-chain without a SpendingAuth', async () => {
    const channelId = makeChannelId(70);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );

    await manager.checkTimeouts();

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeArgs[1]).toBe(channelId);
    expect(closeArgs[2]).toBe(0n);
    expect(closeArgs[3]).toBe('0x');
    expect(closeArgs[4]).toBe('0x');
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
  });

  it('checkTimeouts closes hydrated zombie channels after restart', async () => {
    const channelId = makeChannelId(71);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);

    const restarted = new SellerPaymentManager(sellerIdentity, {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    }, store);
    vi.spyOn(restarted.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );
    vi.spyOn(restarted.channelsClient, 'close').mockResolvedValue('0xclose-hash');

    expect(restarted.hasSession(buyerIdentity.peerId)).toBe(true);

    await restarted.checkTimeouts();

    expect(restarted.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (restarted.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeArgs[1]).toBe(channelId);
    expect(closeArgs[2]).toBe(0n);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    expect(restarted.hasSession(buyerIdentity.peerId)).toBe(false);
  });

  it('checkTimeouts retries zombie close failures without local eviction', async () => {
    const channelId = makeChannelId(72);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );
    vi.spyOn(manager.channelsClient, 'close').mockRejectedValue(new Error('estimate failed'));

    await manager.checkTimeouts();

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
  });

  it('checkTimeouts keeps retrying zombie close when delegated account tx backpressure persists', async () => {
    const channelId = makeChannelId(75);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );
    vi.spyOn(manager.channelsClient, 'close').mockRejectedValue(makeInFlightTxLimitError());

    await manager.checkTimeouts();
    await manager.checkTimeouts();
    await manager.checkTimeouts();
    await manager.checkTimeouts();

    expect(manager.channelsClient.close).toHaveBeenCalledTimes(4);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
  });

  it('checkTimeouts evicts zombie channels after close retries are exhausted', async () => {
    const channelId = makeChannelId(73);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );
    vi.spyOn(manager.channelsClient, 'close').mockRejectedValue(new Error('estimate failed'));

    await manager.checkTimeouts();
    await manager.checkTimeouts();
    await manager.checkTimeouts();
    await manager.checkTimeouts();

    expect(manager.channelsClient.close).toHaveBeenCalledTimes(3);
    expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.TIMEOUT);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
  });

  it('checkTimeouts deduplicates concurrent zombie close attempts', async () => {
    const channelId = makeChannelId(74);
    const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
    manager.onBuyerDisconnect(buyerIdentity.peerId);

    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
      makeOnChainChannel(buyerIdentity, sellerIdentity, {
        deposit: 1_000_000n,
        settled: 0n,
        status: 1,
      }),
    );
    let resolveClose!: (value: string) => void;
    const closePromise = new Promise<string>((resolve) => { resolveClose = resolve; });
    vi.spyOn(manager.channelsClient, 'close').mockReturnValue(closePromise);

    const first = manager.checkTimeouts();
    while ((manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    const second = manager.checkTimeouts();

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    resolveClose('0xclose-hash');
    await Promise.all([first, second]);
    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
  });

  it('test_getPaymentRequirements: returns payment requirements payload', () => {
    const req = manager.getPaymentRequirements('test-req-1');
    expect(req).not.toBeNull();
    expect(req.suggestedAmount).toBe('1000000');
    expect(req.requestId).toBe('test-req-1');
    expect(req.minBudgetPerRequest).toBeDefined();
  });

  it('test_getPaymentRequirements_includes_requestId: correlates with the triggering request', () => {
    const req1 = manager.getPaymentRequirements('req-aaa');
    const req2 = manager.getPaymentRequirements('req-bbb');
    expect(req1.requestId).toBe('req-aaa');
    expect(req2.requestId).toBe('req-bbb');
  });

  describe('validateHydratedChannels', () => {
    function seedChannel(
      channelStore: ChannelStore,
      channelId: string,
      buyer: Identity,
      seller: Identity,
      opts: Partial<StoredChannel> = {},
    ): StoredChannel {
      const now = Date.now();
      const channel: StoredChannel = {
        sessionId: channelId,
        peerId: buyer.peerId,
        role: CHANNEL_ROLE.SELLER,
        sellerEvmAddr: seller.wallet.address,
        buyerEvmAddr: buyer.wallet.address,
        nonce: 0,
        authMax: '1000000',
        previousConsumption: '2000000',
        tokensDelivered: '500000',
        deadline: Math.floor(now / 1000) + 3600,
        previousSessionId: '',
        requestCount: 0,
        reservedAt: now,
        settledAt: null,
        settledAmount: null,
        status: CHANNEL_STATUS.ACTIVE,
        latestBuyerSig: '0xdead',
        latestSpendingAuthSig: '0xdead',
        latestMetadata: null,
        createdAt: now,
        updatedAt: now,
        ...opts,
      };
      channelStore.upsertChannel(channel);
      return channel;
    }

    const ZERO_CHANNEL = {
      buyer: '0x0000000000000000000000000000000000000000',
      seller: '0x0000000000000000000000000000000000000000',
      deposit: 0n,
      settled: 0n,
      metadataHash: ZERO_METADATA_HASH,
      deadline: 0n,
      settledAt: 0n,
      closeRequestedAt: 0n,
      status: 0,
    };

    function makeFreshManager(overrides: Partial<SellerPaymentConfig> = {}) {
      const config: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        ...overrides,
      };
      return new SellerPaymentManager(sellerIdentity, config, store);
    }

    it('evicts channel that no longer exists on-chain', async () => {
      const channelId = makeChannelId(30);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(ZERO_CHANNEL);

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    });

    it('evicts channel with settled on-chain status', async () => {
      const channelId = makeChannelId(31);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { status: 2 }),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    });

    it('keeps channel and reconciles when active on-chain with higher settled', async () => {
      const channelId = makeChannelId(32);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, { tokensDelivered: '100000' });

      const mgr = makeFreshManager();
      expect(mgr.getCumulativeSpend(channelId)).toBe(100_000n);

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 800_000n }),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(mgr.getCumulativeSpend(channelId)).toBe(800_000n);
    });

    it('clears stale auth when authMax <= on-chain settled', async () => {
      const channelId = makeChannelId(36);
      // authMax=600000 < on-chain settled=800000 → auth is stale
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, {
        authMax: '600000',
        tokensDelivered: '100000',
        latestSpendingAuthSig: '0xoldauth',
      });

      const mgr = makeFreshManager();

      // Verify auth was hydrated
      const settleParams = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParams.amount).toBeGreaterThan(0n);

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 800_000n }),
      );

      await mgr.validateHydratedChannels();

      // Auth should be cleared — settle(600000) would revert since 600000 <= 800000
      const settleParamsAfter = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParamsAfter.amount).toBe(0n);
    });

    it('preserves valid auth when authMax > on-chain settled', async () => {
      const channelId = makeChannelId(37);
      // authMax=1000000 > on-chain settled=800000 → auth is still valid
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, {
        authMax: '1000000',
        tokensDelivered: '100000',
        latestSpendingAuthSig: '0xvalidauth',
      });

      const mgr = makeFreshManager();

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 800_000n }),
      );

      await mgr.validateHydratedChannels();

      // Auth should remain — settle(1000000) would succeed since 1000000 > 800000
      const settleParams = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParams.amount).toBeGreaterThan(0n);
    });

    it('does NOT clear auth when no reconciliation needed', async () => {
      const channelId = makeChannelId(38);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, {
        tokensDelivered: '800000',
        latestSpendingAuthSig: '0xvalidauth',
      });

      const mgr = makeFreshManager();

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 500_000n }),
      );

      await mgr.validateHydratedChannels();

      // No reconciliation (local 800k > on-chain 500k), auth should remain
      const settleParams = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParams.amount).toBeGreaterThan(0n);
    });

    it('keeps channel hydrated on RPC failure', async () => {
      const channelId = makeChannelId(33);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockRejectedValue(new Error('RPC timeout'));

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    });

    it('evicts channel with mismatched parties', async () => {
      const channelId = makeChannelId(34);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      const otherBuyer = createTestIdentity();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(otherBuyer, sellerIdentity),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
    });

    it('keeps channel with unknown on-chain status', async () => {
      const channelId = makeChannelId(35);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { status: 99 }),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
    });

    it('closes channel with stored voucher when close was requested while offline', async () => {
      const channelId = makeChannelId(121);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { closeRequestedAt: 12345n }),
      );
      const closeSpy = vi.spyOn(mgr.channelsClient, 'close').mockResolvedValue('0xclose-hash');

      await mgr.validateHydratedChannels();

      expect(closeSpy).toHaveBeenCalledOnce();
      const closeArgs = closeSpy.mock.calls[0]!;
      expect(closeArgs[1]).toBe(channelId);
      expect(closeArgs[2]).toBe(1_000_000n);
      expect(closeArgs[4]).toBe('0xdead');
      expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.SETTLED);
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
    });

    it('cleans up close-pending channel without a voucher instead of closing', async () => {
      const channelId = makeChannelId(122);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, {
        authMax: '0',
        latestSpendingAuthSig: null,
      });

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { closeRequestedAt: 12345n }),
      );
      const closeSpy = vi.spyOn(mgr.channelsClient, 'close').mockResolvedValue('0xclose-hash');

      await mgr.validateHydratedChannels();

      expect(closeSpy).not.toHaveBeenCalled();
      expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.TIMEOUT);
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
    });

    it('keeps close-pending channel when serveWhileClosePending is set', async () => {
      const channelId = makeChannelId(123);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager({ serveWhileClosePending: true });
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { closeRequestedAt: 12345n }),
      );
      const closeSpy = vi.spyOn(mgr.channelsClient, 'close').mockResolvedValue('0xclose-hash');

      await mgr.validateHydratedChannels();

      expect(closeSpy).not.toHaveBeenCalled();
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(store.getChannel(channelId)!.status).toBe(CHANNEL_STATUS.ACTIVE);
    });
  });

  describe('settleSession idle-settle skip logic', () => {
    async function seedAcceptedAuth(
      mgr: SellerPaymentManager,
      channelId: string,
      cumulativeAmount: bigint,
    ): Promise<void> {
      const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
      await mgr.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
      const spend = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount });
      await mgr.handleSpendingAuth(buyerIdentity.peerId, spend, mux);
    }

    it('skips idle settle when localAmount equals on-chain settled (stale re-settle)', async () => {
      const channelId = makeChannelId(50);
      await seedAcceptedAuth(manager, channelId, 100_000n);

      vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 100_000n }),
      );
      const settleSpy = vi.spyOn(manager.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');

      await manager.settleSession(buyerIdentity.peerId, { settleOnly: true });

      expect(manager.channelsClient.getSession).toHaveBeenCalledWith(channelId);
      expect(settleSpy).not.toHaveBeenCalled();
      // Channel stays alive so the buyer can resume
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    });

    it('skips idle settle when delta is below minSettleDelta', async () => {
      const channelId = makeChannelId(51);
      const customConfig: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        minSettleDelta: '5000',
      };
      const mgr = new SellerPaymentManager(sellerIdentity, customConfig, store);
      vi.spyOn(mgr.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');

      await seedAcceptedAuth(mgr, channelId, 104_000n);
      const getSessionSpy = vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        // delta = 104000 - 100000 = 4000 < 5000 → skip
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 100_000n }),
      );
      const settleSpy = vi.spyOn(mgr.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');

      await mgr.settleSession(buyerIdentity.peerId, { settleOnly: true });
      // Second tick with no new requests: cache must short-circuit so we
      // don't burn an RPC every idle interval until the delta crosses the
      // threshold. Regression guard for the dust-skip caching gap.
      await mgr.settleSession(buyerIdentity.peerId, { settleOnly: true });

      expect(settleSpy).not.toHaveBeenCalled();
      expect(getSessionSpy).toHaveBeenCalledOnce();
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
    });

    it('proceeds with idle settle when delta is at or above minSettleDelta', async () => {
      const channelId = makeChannelId(52);
      const customConfig: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        minSettleDelta: '5000',
      };
      const mgr = new SellerPaymentManager(sellerIdentity, customConfig, store);
      vi.spyOn(mgr.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');

      await seedAcceptedAuth(mgr, channelId, 105_000n);
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        // delta = 105000 - 100000 = 5000 == min → settle proceeds
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 100_000n }),
      );
      const settleSpy = vi.spyOn(mgr.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');

      await mgr.settleSession(buyerIdentity.peerId, { settleOnly: true });

      expect(settleSpy).toHaveBeenCalledOnce();
      const [, calledChannelId, calledAmount] = settleSpy.mock.calls[0]!;
      expect(calledChannelId).toBe(channelId);
      expect(calledAmount).toBe(105_000n);
    });

    it('close path ignores minSettleDelta and still settles tiny deltas', async () => {
      const channelId = makeChannelId(53);
      const customConfig: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        minSettleDelta: '1000000', // absurdly high
      };
      const mgr = new SellerPaymentManager(sellerIdentity, customConfig, store);
      vi.spyOn(mgr.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');
      const closeSpy = vi.spyOn(mgr.channelsClient, 'close').mockResolvedValue('0xclose-hash');
      const getSessionSpy = vi.spyOn(mgr.channelsClient, 'getSession');

      await seedAcceptedAuth(mgr, channelId, 101_000n);

      // Not settleOnly — close path
      await mgr.settleSession(buyerIdentity.peerId, {});

      expect(closeSpy).toHaveBeenCalledOnce();
      // close path never consults on-chain state for the dust check
      expect(getSessionSpy).not.toHaveBeenCalled();
    });
  });

  describe('on-chain session recovery with a pending close request', () => {
    // Reserve fields absent is what routes handleSpendingAuth into recovery.
    async function buildRecoveryAuth(channelId: string, cumulativeAmount: bigint) {
      const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount });
      delete (payload as Record<string, unknown>).reserveSalt;
      delete (payload as Record<string, unknown>).reserveMaxAmount;
      delete (payload as Record<string, unknown>).reserveDeadline;
      return payload;
    }

    it('recovers a clean active channel', async () => {
      const channelId = makeChannelId(0x41);
      vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity) as never,
      );

      await manager.handleSpendingAuth(buyerIdentity.peerId, await buildRecoveryAuth(channelId, 900_000n), mux);

      expect(mux.sentAuthAcks.length).toBe(1);
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    });

    it('refuses recovery when the buyer has requested close on-chain', async () => {
      const channelId = makeChannelId(0x42);
      vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, {
          closeRequestedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        }) as never,
      );

      await manager.handleSpendingAuth(buyerIdentity.peerId, await buildRecoveryAuth(channelId, 900_000n), mux);

      expect(mux.sentAuthAcks.length).toBe(0);
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(store.getChannel(channelId)).toBeNull();
    });

    it('refuses recovery even while the grace period is still running', async () => {
      const channelId = makeChannelId(0x43);
      vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, {
          closeRequestedAt: BigInt(Math.floor(Date.now() / 1000)),
        }) as never,
      );

      await manager.handleSpendingAuth(buyerIdentity.peerId, await buildRecoveryAuth(channelId, 900_000n), mux);

      expect(mux.sentAuthAcks.length).toBe(0);
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
    });

    it('recovers a close-pending channel when serveWhileClosePending is set', async () => {
      const channelId = makeChannelId(0x44);
      const optInConfig: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        serveWhileClosePending: true,
      };
      const mgr = new SellerPaymentManager(sellerIdentity, optInConfig, store);
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, {
          closeRequestedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        }) as never,
      );

      await mgr.handleSpendingAuth(buyerIdentity.peerId, await buildRecoveryAuth(channelId, 900_000n), mux);

      expect(mux.sentAuthAcks.length).toBe(1);
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
    });
  });
});
