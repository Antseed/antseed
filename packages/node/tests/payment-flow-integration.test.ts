import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { SpendingAuthPayload, AuthAckPayload } from '../src/types/protocol.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { AbiCoder, Wallet } from 'ethers';
import { encodeSpendingAuth, decodeSpendingAuth } from '@antseed/protocol';

const enc = new TextEncoder();

function decodeMetadataTokens(metadata: string): { inputTokens: bigint; outputTokens: bigint } {
  const coder = AbiCoder.defaultAbiCoder();
  const [, inputTokens, outputTokens] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], metadata);
  return { inputTokens, outputTokens };
}

// ── Helpers ──────────────────────────────────────────────────

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

function createMockPaymentMux(): PaymentMux & {
  sentSpendingAuths: SpendingAuthPayload[];
  sentAuthAcks: AuthAckPayload[];
} {
  const mux = {
    sentSpendingAuths: [] as SpendingAuthPayload[],
    sentAuthAcks: [] as AuthAckPayload[],
    sendSpendingAuth(payload: SpendingAuthPayload) { mux.sentSpendingAuths.push(payload); },
    sendAuthAck(payload: AuthAckPayload) { mux.sentAuthAcks.push(payload); },
    sendPaymentRequired() {},
    sendNeedAuth() {},
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & {
    sentSpendingAuths: SpendingAuthPayload[];
    sentAuthAcks: AuthAckPayload[];
  };
}

const CHAIN_ID = 31337;
const SESSIONS_CONTRACT = '0x' + 'cc'.repeat(20);

const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

/** Realistic test content for tokenx estimation. */
const SAMPLE_INPUT = enc.encode('What is the capital of France? Please provide a detailed historical answer.');
const SAMPLE_OUTPUT = enc.encode('The capital of France is Paris, located on the Seine River. It has been the capital since the 10th century.');

function makeBuyerConfig(dataDir: string): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    channelsContractAddress: SESSIONS_CONTRACT,
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    chainId: CHAIN_ID,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 500_000n, // $0.50
    maxReserveAmountUsdc: 10_000_000n, // $10.00
    dataDir,
  };
}

function makeSellerConfig(dataDir: string): SellerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    channelsContractAddress: SESSIONS_CONTRACT,
    chainId: CHAIN_ID,
    dataDir,
    minBudgetPerRequest: '50000', // $0.05
  };
}

// ═══════════════════════════════════════════════════════════════
// Full Payment Flow Integration Tests
// ═══════════════════════════════════════════════════════════════

describe('Full Payment Flow Integration', () => {
  let buyerDir: string;
  let sellerDir: string;
  let buyerStore: ChannelStore;
  let sellerStore: ChannelStore;
  let buyerIdentity: Identity;
  let sellerIdentity: Identity;
  let buyer: BuyerPaymentManager;
  let seller: SellerPaymentManager;
  let buyerMux: ReturnType<typeof createMockPaymentMux>;
  let sellerMux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    buyerDir = mkdtempSync(join(tmpdir(), 'flow-buyer-'));
    sellerDir = mkdtempSync(join(tmpdir(), 'flow-seller-'));
    buyerStore = new ChannelStore(buyerDir);
    sellerStore = new ChannelStore(sellerDir);

    buyerIdentity = createTestIdentity();
    sellerIdentity = createTestIdentity();

    buyer = new BuyerPaymentManager(buyerIdentity, makeBuyerConfig(buyerDir), buyerStore);
    buyer.setSigner(buyerIdentity.wallet);

    seller = new SellerPaymentManager(sellerIdentity, makeSellerConfig(sellerDir), sellerStore);
    vi.spyOn(seller.channelsClient, 'reserve').mockResolvedValue('0xreservehash');
    vi.spyOn(seller.channelsClient, 'close').mockResolvedValue('0xclosehash');
    vi.spyOn(seller.channelsClient, 'requestClose').mockResolvedValue('0xrequestclosehash');
    vi.spyOn(seller.channelsClient, 'withdraw').mockResolvedValue('0xwithdrawhash');

    buyerMux = createMockPaymentMux();
    sellerMux = createMockPaymentMux();
  });

  afterEach(() => {
    buyerStore.close();
    sellerStore.close();
    rmSync(buyerDir, { recursive: true, force: true });
    rmSync(sellerDir, { recursive: true, force: true });
  });

  async function doInitialHandshake(minBudget: bigint): Promise<{ sessionId: string }> {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const sessionId = await buyer.authorizeSpending(sellerPeerId, buyerMux, minBudget, TEST_PRICING);
    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(buyerMux.sentSpendingAuths).toHaveLength(1);

    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    const result = await seller.handleSpendingAuth(buyerPeerId, initialAuth, sellerMux);
    expect(result).toBe('reserved');
    expect(sellerMux.sentAuthAcks).toHaveLength(1);

    buyer.handleAuthAck(sellerPeerId, sellerMux.sentAuthAcks[0]!);
    expect(buyer.isAuthorized(sellerPeerId)).toBe(true);

    return { sessionId };
  }

  it.each(['success', 'insufficient-balance'] as const)('video reserve and credit exchange: %s', async (outcome) => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;
    const channelId = await buyer.authorizeSpending(sellerPeerId, buyerMux, 0n, 1_000_000n, TEST_PRICING);
    await seller.handleSpendingAuth(buyerPeerId, buyerMux.sentSpendingAuths[0]!, sellerMux);
    await buyer.handleAuthAck(sellerPeerId, sellerMux.sentAuthAcks[0]!);
    buyer.trackRequestBilling('video-request', {
      context: { sellerPeerId, service: 'video-model', provider: 'venice', serviceApiProtocol: 'venice-video', unitLimits: { video_generations: 1 } },
      requestFacts: { video: { protocol: 'venice-video', action: 'create', count: 1 } },
      unitModel: { version: 1, components: [{ unit: 'video_generations', priceUsd: 4.2 }] },
      estimatedCostUsdc: 4_200_000n,
    });
    vi.spyOn(buyer, 'getBalance').mockResolvedValue({ available: 10_000_000n, reserved: 1_000_000n });
    buyerMux.sentSpendingAuths.length = 0;
    await buyer.signVideoDownPayment(sellerPeerId, 'video-request', 850_000n, 4_200_000n, 1_000_000n);
    expect(buyerMux.sentSpendingAuths).toHaveLength(0);
    await buyer.topUpReserve(sellerPeerId, buyerMux, 5_000_000n);
    const topUp = decodeSpendingAuth(encodeSpendingAuth(buyerMux.sentSpendingAuths[0]!));
    const topUpSpy = vi.spyOn(seller.channelsClient, 'topUp');
    if (outcome === 'success') topUpSpy.mockResolvedValue('0xtopup');
    else {
      topUpSpy.mockRejectedValue(new Error('InsufficientBalance'));
      vi.spyOn(seller.channelsClient, 'getSession').mockResolvedValue({
        buyer: buyerIdentity.wallet.address, seller: sellerIdentity.wallet.address,
        deposit: 1_000_000n, settled: 0n, metadataHash: topUp.metadataHash,
        deadline: BigInt(topUp.reserveDeadline!), settledAt: 0n, closeRequestedAt: 0n, status: 1,
      });
    }
    expect(await seller.handleSpendingAuth(buyerPeerId, topUp, sellerMux)).toBe(outcome === 'success' ? 'accepted' : 'rejected');
    expect(topUpSpy.mock.calls[0]?.[2]).toBe(850_000n);
    await buyer.reconcileReserveAmount(sellerPeerId, outcome === 'success' ? 5_000_000n : 1_000_000n);
    if (outcome === 'success') {
      seller.recordSpend(channelId, 4_200_000n);
      const { payload } = await buyer.signPerRequestAuth(sellerPeerId, {
        requestId: 'video-request', service: 'video-model', inputBytes: new Uint8Array(), outputBytes: new Uint8Array(),
        unitUsage: { units: { video_generations: 1 } },
      });
      expect(payload.cumulativeAmount).toBe('4200000');
      expect(await seller.handleSpendingAuth(buyerPeerId, decodeSpendingAuth(encodeSpendingAuth(payload)), sellerMux)).toBe('accepted');
      await seller.settleSession(buyerPeerId);
      expect(vi.mocked(seller.channelsClient.close).mock.calls[0]?.[2]).toBe(4_200_000n);
    } else {
      expect(buyer.getCumulativeAmount(sellerPeerId)).toBe(0n);
      expect(sellerStore.getChannel(channelId)?.authMax).toBe('0');
      await seller.settleSession(buyerPeerId);
      expect(seller.channelsClient.close).not.toHaveBeenCalled();
    }
  });

  it('complete flow: reserve -> 3 requests -> settle', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const { sessionId } = await doInitialHandshake(0n);

    expect(seller.channelsClient.reserve).toHaveBeenCalledOnce();
    const reserveCall = (seller.channelsClient.reserve as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(reserveCall[3] as bigint).toBe(10_000_000n);

    // Use small seller claims within tolerance of buyer's byte estimate
    // so cumulative advances by the claimed amount (not capped).
    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 200n },
    );
    // Cumulative starts at 0, so first request cumulative = accepted cost
    expect(BigInt(auth1.cumulativeAmount)).toBeGreaterThan(0n);

    expect(await seller.handleSpendingAuth(buyerPeerId, auth1, sellerMux)).toBe('accepted');
    seller.recordSpend(sessionId, 200n);

    const { payload: auth2 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 300n },
    );
    expect(BigInt(auth2.cumulativeAmount)).toBeGreaterThan(BigInt(auth1.cumulativeAmount));

    expect(await seller.handleSpendingAuth(buyerPeerId, auth2, sellerMux)).toBe('accepted');
    seller.recordSpend(sessionId, 300n);

    const { payload: auth3 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 150n },
    );
    expect(BigInt(auth3.cumulativeAmount)).toBeGreaterThan(BigInt(auth2.cumulativeAmount));

    expect(await seller.handleSpendingAuth(buyerPeerId, auth3, sellerMux)).toBe('accepted');
    seller.recordSpend(sessionId, 150n);

    expect(seller.getCumulativeSpend(sessionId)).toBe(650n);

    await seller.settleSession(buyerPeerId);

    expect(seller.channelsClient.close).toHaveBeenCalledOnce();
    const closeCall = (seller.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeCall[2] as bigint).toBe(BigInt(auth3.cumulativeAmount));
    expect((closeCall[4] as string).length).toBeGreaterThan(2);
  });

  it('cumulative amounts are strictly monotonically increasing', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(0n);

    // Cumulative starts at 0 (not the seed amount)
    const amounts: bigint[] = [0n];

    for (let i = 0; i < 5; i++) {
      const { payload: auth } = await buyer.signPerRequestAuth(
        sellerPeerId,
        { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
      );
      const amount = BigInt(auth.cumulativeAmount);
      expect(amount).toBeGreaterThan(amounts[amounts.length - 1]!);
      amounts.push(amount);
    }

    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i]!).toBeGreaterThan(amounts[i - 1]!);
    }
  });

  it('seller rejects non-monotonic cumulative amount', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(0n);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 20_000n },
    );
    expect(await seller.handleSpendingAuth(buyerPeerId, auth1, sellerMux)).toBe('accepted');

    // Mutating the signed cumulative amount invalidates the SpendingAuth.
    const fakeAuth: SpendingAuthPayload = {
      ...auth1,
      cumulativeAmount: '1',
    };
    expect(await seller.handleSpendingAuth(buyerPeerId, fakeAuth, sellerMux)).toBe('rejected');
  });

  it('token counts accumulate correctly across multiple requests', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(0n);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    const tMeta1 = decodeMetadataTokens(auth1.metadata);
    expect(tMeta1.inputTokens).toBeGreaterThan(0n);
    expect(tMeta1.outputTokens).toBeGreaterThan(0n);
    const firstInput = tMeta1.inputTokens;
    const firstOutput = tMeta1.outputTokens;

    const { payload: auth2 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    const tMeta2 = decodeMetadataTokens(auth2.metadata);
    expect(tMeta2.inputTokens).toBe(firstInput * 2n);
    expect(tMeta2.outputTokens).toBe(firstOutput * 2n);

    const { payload: auth3 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    const tMeta3 = decodeMetadataTokens(auth3.metadata);
    expect(tMeta3.inputTokens).toBe(firstInput * 3n);
    expect(tMeta3.outputTokens).toBe(firstOutput * 3n);
  });

  it('settle uses latest buyer signature (not initial)', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const { sessionId } = await doInitialHandshake(0n);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 200n },
    );
    expect(await seller.handleSpendingAuth(buyerPeerId, auth1, sellerMux)).toBe('accepted');
    seller.recordSpend(sessionId, 200n);

    const { payload: auth2 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 300n },
    );
    expect(await seller.handleSpendingAuth(buyerPeerId, auth2, sellerMux)).toBe('accepted');
    seller.recordSpend(sessionId, 300n);

    await seller.settleSession(buyerPeerId);

    const closeCall = (seller.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeCall[2] as bigint).toBe(BigInt(auth2.cumulativeAmount));
    expect(closeCall[4] as string).toBe(auth2.spendingAuthSig);
  });

  it('reserve sends reserveAmount from buyer config, not cumulativeAmount', async () => {
    await doInitialHandshake(50_000n);

    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    expect(initialAuth.reserveMaxAmount).toBe('10000000');
    expect(initialAuth.cumulativeAmount).toBe('0');
  });

  it('seller sends AuthAck only on first SpendingAuth, not subsequent', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    await doInitialHandshake(0n);
    expect(sellerMux.sentAuthAcks).toHaveLength(1);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    expect(await seller.handleSpendingAuth(buyerPeerId, auth1, sellerMux)).toBe('accepted');
    expect(sellerMux.sentAuthAcks).toHaveLength(1);
  });

  it('seller hasSession returns true for active buyer, false after settle', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    const sellerPeerId = sellerIdentity.peerId;

    expect(seller.hasSession(buyerPeerId)).toBe(false);

    const { sessionId } = await doInitialHandshake(0n);
    expect(seller.hasSession(buyerPeerId)).toBe(true);

    const { payload: auth } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 200n },
    );
    expect(await seller.handleSpendingAuth(buyerPeerId, auth, sellerMux)).toBe('accepted');
    seller.recordSpend(sessionId, 200n);

    await seller.settleSession(buyerPeerId);
    expect(seller.hasSession(buyerPeerId)).toBe(false);
  });

  it('no-spend session defers to timeout (no SpendingAuth to settle with)', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    await doInitialHandshake(50_000n);
    await seller.settleSession(buyerPeerId);
    // accepted=0 after initial reserve (no real SpendingAuth yet), so close is not called
    expect(seller.channelsClient.close).not.toHaveBeenCalled();
    expect(seller.channelsClient.requestClose).not.toHaveBeenCalled();
  });

  it('buyer handleAuthAck ignores mismatched channelId', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const sessionId = await buyer.authorizeSpending(sellerPeerId, buyerMux, 50_000n, TEST_PRICING);

    buyer.handleAuthAck(sellerPeerId, { channelId: '0x' + 'ff'.repeat(32) });
    expect(buyer.isAuthorized(sellerPeerId)).toBe(false);

    buyer.handleAuthAck(sellerPeerId, { channelId: sessionId });
    expect(buyer.isAuthorized(sellerPeerId)).toBe(true);
  });

  it('seller rejects SpendingAuth with invalid signature', async () => {
    const buyerPeerId = buyerIdentity.peerId;

    const { ZERO_METADATA_HASH, encodeMetadata, ZERO_METADATA } = await import('../src/payments/evm/signatures.js');
    const badAuth: SpendingAuthPayload = {
      channelId: '0x' + '01'.repeat(32),
      cumulativeAmount: '50000',
      metadataHash: ZERO_METADATA_HASH,
      metadata: encodeMetadata(ZERO_METADATA),
      spendingAuthSig: '0x' + 'bb'.repeat(65),
      reserveMaxAmount: '10000000',
      reserveSalt: '0x' + '01'.repeat(32),
      reserveDeadline: Math.floor(Date.now() / 1000) + 3600,
    };

    expect(await seller.handleSpendingAuth(buyerPeerId, badAuth, sellerMux)).toBe('rejected');
    expect(sellerMux.sentAuthAcks).toHaveLength(0);
  });

  it('buyer per-request auth caps cumulative at reserve ceiling', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    const tightConfig = makeBuyerConfig(buyerDir);
    tightConfig.maxReserveAmountUsdc = 100_000n;
    tightConfig.maxPerRequestUsdc = 500_000n;

    buyerStore.close();
    buyerStore = new ChannelStore(buyerDir);
    buyer = new BuyerPaymentManager(buyerIdentity, tightConfig, buyerStore);
    buyer.setSigner(buyerIdentity.wallet);

    await buyer.authorizeSpending(sellerPeerId, buyerMux, 50_000n, TEST_PRICING);
    buyer.handleAuthAck(sellerPeerId, { channelId: buyerMux.sentSpendingAuths[0]!.channelId });

    const { payload: auth } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 200_000n },
    );
    expect(BigInt(auth.cumulativeAmount)).toBeLessThanOrEqual(100_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// Settlement edge cases
// ═══════════════════════════════════════════════════════════════

describe('Settlement edge cases', () => {
  let buyerDir: string;
  let sellerDir: string;
  let buyerStore: ChannelStore;
  let sellerStore: ChannelStore;
  let buyerIdentity: Identity;
  let sellerIdentity: Identity;
  let buyer: BuyerPaymentManager;
  let seller: SellerPaymentManager;
  let buyerMux: ReturnType<typeof createMockPaymentMux>;
  let sellerMux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    buyerDir = mkdtempSync(join(tmpdir(), 'settle-buyer-'));
    sellerDir = mkdtempSync(join(tmpdir(), 'settle-seller-'));
    buyerStore = new ChannelStore(buyerDir);
    sellerStore = new ChannelStore(sellerDir);

    buyerIdentity = createTestIdentity();
    sellerIdentity = createTestIdentity();

    buyer = new BuyerPaymentManager(buyerIdentity, makeBuyerConfig(buyerDir), buyerStore);
    buyer.setSigner(buyerIdentity.wallet);

    seller = new SellerPaymentManager(sellerIdentity, makeSellerConfig(sellerDir), sellerStore);
    vi.spyOn(seller.channelsClient, 'reserve').mockResolvedValue('0xreservehash');
    vi.spyOn(seller.channelsClient, 'close').mockResolvedValue('0xclosehash');
    vi.spyOn(seller.channelsClient, 'requestClose').mockResolvedValue('0xrequestclosehash');
    vi.spyOn(seller.channelsClient, 'withdraw').mockResolvedValue('0xwithdrawhash');

    buyerMux = createMockPaymentMux();
    sellerMux = createMockPaymentMux();
  });

  afterEach(() => {
    buyerStore.close();
    sellerStore.close();
    rmSync(buyerDir, { recursive: true, force: true });
    rmSync(sellerDir, { recursive: true, force: true });
  });

  const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
  const SAMPLE_INPUT = enc.encode('What is the capital of France?');
  const SAMPLE_OUTPUT = enc.encode('The capital of France is Paris.');

  it('onBuyerDisconnect triggers settlement for active session', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const sessionId = await buyer.authorizeSpending(sellerPeerId, buyerMux, 50_000n, TEST_PRICING);
    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    await seller.handleSpendingAuth(buyerPeerId, initialAuth, sellerMux);
    buyer.handleAuthAck(sellerPeerId, sellerMux.sentAuthAcks[0]!);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 200n },
    );
    expect(await seller.handleSpendingAuth(buyerPeerId, auth1, sellerMux)).toBe('accepted');
    seller.recordSpend(sessionId, 200n);

    seller.onBuyerDisconnect(buyerPeerId);
    await new Promise((r) => setTimeout(r, 50));

    expect(seller.channelsClient.close).toHaveBeenCalledOnce();
  });

  it('settleSession is no-op for unknown buyer', async () => {
    await seller.settleSession('unknown-peer');
    expect(seller.channelsClient.close).not.toHaveBeenCalled();
  });

  it('recordSpend is no-op for unknown channelId', () => {
    seller.recordSpend('0x' + 'ff'.repeat(32), 1000n);
  });
});
