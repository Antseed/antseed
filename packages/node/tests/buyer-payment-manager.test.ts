import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { id, keccak256, Wallet } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig, type BuyerSpendEvent } from '../src/payments/buyer-payment-manager.js';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { estimateCostFromBytes } from '../src/payments/pricing.js';
import { decodeSpendingAuth, encodeSpendingAuth } from '@antseed/protocol/payment-codec';
import { decodeSpendingAuthMetadata, getServiceMetadataId, MAX_METADATA_SERVICES } from '@antseed/protocol/signatures';
import { decodeWorkerTail } from '@antseed/protocol/worker-attribution';
import type { SpendingAuthPayload } from '@antseed/protocol/messages';
import { captureUnitBillingContext } from '@antseed/buyer-core';

const enc = new TextEncoder();

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

/** Generate a fake but valid-format peerId (40 hex chars) from a label. */
function fakePeerId(label: string): string {
  const hex = Buffer.from(label).toString('hex').padEnd(40, '0').slice(0, 40);
  return hex;
}

function decodeMetadataTokens(metadata: string): {
  inputTokens: bigint;
  outputTokens: bigint;
  outputImages: bigint;
  videoGenerations: bigint;
  videoSeconds: bigint;
  inputCharacters: bigint;
} {
  const decoded = decodeSpendingAuthMetadata(metadata);
  return {
    inputTokens: decoded.cumulativeInputTokens,
    outputTokens: decoded.cumulativeOutputTokens,
    outputImages: decoded.cumulativeOutputImages,
    videoGenerations: decoded.cumulativeVideoGenerations,
    videoSeconds: decoded.cumulativeVideoSeconds,
    inputCharacters: decoded.cumulativeInputCharacters,
  };
}

function decodeMetadataServices(metadata: string): Array<{
  serviceId: string;
  cumulativeAmount: bigint;
  cumulativeInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  cumulativeOutputImages: bigint;
}> {
  return decodeSpendingAuthMetadata(metadata).services.map((service) => ({
    serviceId: service.serviceId,
    cumulativeAmount: service.cumulativeAmount,
    cumulativeInputTokens: service.cumulativeInputTokens,
    cumulativeCachedInputTokens: service.cumulativeCachedInputTokens,
    cumulativeOutputTokens: service.cumulativeOutputTokens,
    cumulativeRequestCount: service.cumulativeRequestCount,
    cumulativeOutputImages: service.cumulativeOutputImages,
  }));
}

function createMockPaymentMux(): PaymentMux & {
  sentSpendingAuths: unknown[];
} {
  const mux = {
    sentSpendingAuths: [] as unknown[],
    sendSpendingAuth(payload: unknown) { mux.sentSpendingAuths.push(payload); },
    sendAuthAck() {},
    sendPaymentRequired() {},
    sendNeedAuth() {},
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & { sentSpendingAuths: unknown[] };
}

function makeConfig(dataDir: string, overrides?: Partial<BuyerPaymentConfig>): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    channelsContractAddress: '0x' + 'cc'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    chainId: 31337,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 100_000n, // $0.10
    maxReserveAmountUsdc: 10_000_000n, // $10.00
    dataDir,
    ...overrides,
  };
}

/** Standard test pricing: $3/M input, $15/M output (similar to GPT-4). */
const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

/** Realistic test content to get stable tokenx estimates. */
const SAMPLE_INPUT = enc.encode(
  'What is the capital of France? Please provide a detailed answer with historical context.',
);
const SAMPLE_OUTPUT = enc.encode(
  'The capital of France is Paris. Paris has been the capital since the late 10th century when Hugh Capet made it the seat of the French kingdom. The city is located on the Seine River in northern France and is the most populous city in France with over 2 million inhabitants in the city proper.',
);

/** Pre-compute tokenx cost estimate for SAMPLE_INPUT/OUTPUT. */
const SAMPLE_ESTIMATE = estimateCostFromBytes(SAMPLE_INPUT, SAMPLE_OUTPUT, TEST_PRICING);

describe('BuyerPaymentManager', () => {
  let tempDir: string;
  let identity: Identity;
  let manager: BuyerPaymentManager;
  let store: ChannelStore;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-pm-test-'));
    identity = createTestIdentity();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    const wallet = Wallet.createRandom();
    manager.setSigner(wallet);
    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── authorizeSpending ──────────────────────────────────────────

  it('authorizeSpending sends SpendingAuth with channelId and reserve fields', async () => {
    const sellerPeerId = fakePeerId('seller-peer-001');
    const minBudget = 50_000n;

    const channelId = await manager.authorizeSpending(sellerPeerId, mux, minBudget, TEST_PRICING);

    expect(channelId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mux.sentSpendingAuths.length).toBe(1);

    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe('0');
    expect(sent.metadataHash).toBeTypeOf('string');
    expect(sent.channelId).toBe(channelId);
    expect(sent.spendingAuthSig).toBeTypeOf('string');
    expect(sent.reserveSalt).toBeTypeOf('string');
    expect(sent.reserveMaxAmount).toBe('10000000');
  });

  it('authorizeSpending sends ABI-encoded zero metadata (not empty string)', async () => {
    const sellerPeerId = fakePeerId('seller-peer-meta');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    expect(channelId).toMatch(/^0x[0-9a-f]{64}$/);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    // metadata must be a valid hex-encoded bytes value, not ''
    expect(sent.metadata).toBeTypeOf('string');
    expect(sent.metadata).not.toBe('');
    expect((sent.metadata as string).startsWith('0x')).toBe(true);
    // v5 zero metadata: eight head words (version, input, output, requests,
    // images, video generations, video seconds, speech characters) + empty services array
    // (offset + length) = 10 words.
    expect((sent.metadata as string).length).toBe(2 + 10 * 64);
  });

  it('does not transmit ReserveAuth when durable persistence fails', async () => {
    const persistenceError = new Error('durable write failed');
    Object.assign(store, {
      commitAuthorization: vi.fn().mockRejectedValue(persistenceError),
    });

    await expect(
      manager.authorizeSpending(fakePeerId('seller-persist-fail'), mux, 50_000n, TEST_PRICING),
    ).rejects.toThrow('durable write failed');
    expect(mux.sentSpendingAuths).toHaveLength(0);
  });

  it('authorizeSpending rejects if minBudgetPerRequest exceeds maxPerRequestUsdc', async () => {
    const sellerPeerId = fakePeerId('seller-peer-reject');
    const tooLarge = 200_000n;

    const channelId = await manager.authorizeSpending(sellerPeerId, mux, tooLarge, TEST_PRICING);

    expect(channelId).toBe('');
    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('authorizeSpending initializes verifiedCost to 0', async () => {
    const sellerPeerId = fakePeerId('seller-init');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
  });

  // ── AuthAck ────────────────────────────────────────────────────

  it('handleAuthAck marks session as confirmed', async () => {
    const sellerPeerId = fakePeerId('seller-peer-003');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    expect(manager.isAuthorized(sellerPeerId)).toBe(false);

    manager.handleAuthAck(sellerPeerId, { channelId });
    expect(manager.isAuthorized(sellerPeerId)).toBe(true);
  });

  it('isAuthorized returns true for confirmed session, false otherwise', async () => {
    const peerId1 = fakePeerId('seller-peer-auth-1');
    const peerId2 = fakePeerId('seller-peer-auth-2');

    expect(manager.isAuthorized(peerId1)).toBe(false);

    const cid = await manager.authorizeSpending(peerId1, mux, 10_000n, TEST_PRICING);
    expect(manager.isAuthorized(peerId1)).toBe(false);

    manager.handleAuthAck(peerId1, { channelId: cid });
    expect(manager.isAuthorized(peerId1)).toBe(true);
    expect(manager.isAuthorized(peerId2)).toBe(false);
  });

  // ── recordResponseBytes ────────────────────────────────────────

  it('recordResponseBytes accumulates verified cost using tokenx', async () => {
    const sellerPeerId = fakePeerId('seller-bytes');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const result1 = manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    expect(result1).not.toBeNull();
    expect(result1!.inputTokens).toBeGreaterThan(5);
    expect(result1!.outputTokens).toBeGreaterThan(20);
    expect(result1!.verifiedCost).toBeGreaterThan(0n);
    expect(result1!.verifiedCost).toBe(SAMPLE_ESTIMATE.cost);

    // Second response accumulates
    const result2 = manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    expect(result2!.verifiedCost).toBe(SAMPLE_ESTIMATE.cost * 2n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(SAMPLE_ESTIMATE.cost * 2n);
  });

  it('recordResponseBytes returns null without pricing', async () => {
    const sellerPeerId = fakePeerId('seller-no-pricing');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n); // no pricing
    const result = manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    expect(result).toBeNull();
  });

  // ── signPerRequestAuth (overdraft model) ───────────────────────

  it('signPerRequestAuth uses seller claimed cost within tolerance', async () => {
    const sellerPeerId = fakePeerId('seller-perreq');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, {
      channelId: (mux.sentSpendingAuths[0] as Record<string, unknown>).channelId as string,
    });

    // Seller claims less than buyer estimate * 1.4 → accepted as-is
    const sellerClaim = SAMPLE_ESTIMATE.cost / 2n; // well under tolerance
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: sellerClaim },
    );

    // new cumulative = 0 (initial) + sellerClaim
    expect(BigInt(payload.cumulativeAmount)).toBe(sellerClaim);
    expect(payload.spendingAuthSig).toBeTypeOf('string');
  });

  it('leaves post-response state unchanged when authorization persistence fails', async () => {
    const sellerPeerId = fakePeerId('seller-post-response-persist-fail');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    const originalCommit = store.commitAuthorization.bind(store);
    Object.assign(store, {
      commitAuthorization: vi.fn()
        .mockRejectedValueOnce(new Error('durable post-response write failed'))
        .mockImplementation(originalCommit),
    });
    const spendEvents: unknown[] = [];
    manager.setSpendListener((event) => spendEvents.push(event));

    const response = {
      inputBytes: SAMPLE_INPUT,
      outputBytes: SAMPLE_OUTPUT,
      sellerClaimedCost: SAMPLE_ESTIMATE.cost,
      reportedInputTokens: 20n,
      reportedOutputTokens: 10n,
      service: 'gpt-test',
      requestId: 'post-response-persist-fail',
    };
    manager.recordDeliveredResponse(sellerPeerId, response.requestId, { costUsdc: SAMPLE_ESTIMATE.cost });
    await expect(manager.signPerRequestAuth(sellerPeerId, response))
      .rejects.toThrow('durable post-response write failed');

    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(0n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
    expect(spendEvents).toHaveLength(0);

    await manager.signPerRequestAuth(sellerPeerId, response);
    const metadata = store.getChannelMetadata(store.getChannel(channelId)!);
    expect(metadata.cumulativeRequestCount).toBe(1n);
    expect(metadata.cumulativeInputTokens).toBe(20n);
    expect(metadata.cumulativeOutputTokens).toBe(10n);
    expect(spendEvents).toHaveLength(1);
  });

  it('signPerRequestAuth caps seller claim at tolerance multiplier', async () => {
    const sellerPeerId = fakePeerId('seller-cap');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims way more than buyer estimate * 1.4
    const outrageousClaim = SAMPLE_ESTIMATE.cost * 10n;
    const maxAcceptable = BigInt(Math.ceil(Number(SAMPLE_ESTIMATE.cost) * 1.4));

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: outrageousClaim },
    );

    // new cumulative = 0 (initial) + capped amount
    expect(BigInt(payload.cumulativeAmount)).toBe(maxAcceptable);
  });

  it('signPerRequestAuth caps at overdraft limit (verifiedCost + maxPerRequestUsdc)', async () => {
    const sellerPeerId = fakePeerId('seller-overdraft');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims a huge cost — tolerance caps it first, then overdraft limit
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 500_000n },
    );

    // maxSignable = verifiedCost + maxPerRequestUsdc(100_000)
    const maxSignable = SAMPLE_ESTIMATE.cost + 100_000n;
    // The tolerance cap (1.4x estimate) is applied first, which is smaller than overdraft
    expect(BigInt(payload.cumulativeAmount)).toBeLessThanOrEqual(maxSignable);
  });

  it('signPerRequestAuth advances after multiple responses', async () => {
    const sellerPeerId = fakePeerId('seller-multi');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Use a claim within tolerance so it's accepted as-is
    const claim = SAMPLE_ESTIMATE.cost / 2n; // well under 1.4x estimate

    const { payload: p1 } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: claim },
    );
    expect(BigInt(p1.cumulativeAmount)).toBe(claim);

    const { payload: p2 } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: claim },
    );
    expect(BigInt(p2.cumulativeAmount)).toBe(claim * 2n);
  });

  it('signPerRequestAuth uses buyer estimate when no seller claim', async () => {
    const sellerPeerId = fakePeerId('seller-no-claim');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT },
    );

    // Buyer estimate used as cost, cumulative = 0 + estimate
    expect(BigInt(payload.cumulativeAmount)).toBe(SAMPLE_ESTIMATE.cost);
  });

  it('signPerRequestAuth ensures monotonic increase', async () => {
    const sellerPeerId = fakePeerId('seller-mono');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    // Tiny response — cost would be very small, but cumulative must advance
    const tiny = enc.encode('Hi');
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: tiny, outputBytes: tiny, sellerClaimedCost: 1n },
    );

    expect(BigInt(payload.cumulativeAmount)).toBe(1n);
  });

  it('signPerRequestAuth uses seller claimed cost for verifiedCost when no pricing available', async () => {
    // Simulate post-restart state: session exists but no pricing in memory
    const sellerPeerId = fakePeerId('seller-no-pricing-restart');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n); // no pricing!

    const sellerClaim = 5_000n;
    const { payload: p1 } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: sellerClaim,
        reportedInputTokens: 100n,
        reportedOutputTokens: 50n,
      },
    );

    // Cumulative should advance by seller's claimed cost
    expect(BigInt(p1.cumulativeAmount)).toBe(sellerClaim);

    // Second request — verifiedCost should have grown, allowing maxSignable to increase
    const { payload: p2 } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: sellerClaim,
        reportedInputTokens: 100n,
        reportedOutputTokens: 50n,
      },
    );

    // Should advance further — not stuck at the same value
    expect(BigInt(p2.cumulativeAmount)).toBe(sellerClaim * 2n);
  });

  it('signPerRequestAuth signals topUpNeeded at the initial headroom threshold', async () => {
    const sellerPeerId = fakePeerId('seller-topup');
    // Use a ceiling just above the expected cost, leaving much less than the
    // initial reserve's 35% headroom threshold after one request.
    const initialBudget = 9_000n;
    const ceiling = SAMPLE_ESTIMATE.cost + 100n; // tight ceiling
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: ceiling, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    await manager.authorizeSpending(sellerPeerId, mux, initialBudget, TEST_PRICING);

    const { topUpNeeded, payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: SAMPLE_ESTIMATE.cost },
    );

    expect(BigInt(payload.cumulativeAmount)).toBe(SAMPLE_ESTIMATE.cost);
    expect(topUpNeeded).toBe(true);
  });

  it('signPerRequestAuth accepts seller claim above buyer estimate when within tolerance', async () => {
    const sellerPeerId = fakePeerId('seller-above-ok');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims 1.3x the buyer's estimate — within 1.4x tolerance
    const sellerClaim = BigInt(Math.ceil(Number(SAMPLE_ESTIMATE.cost) * 1.3));
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: sellerClaim },
    );

    // Seller's claim accepted as-is (not reduced to buyer's estimate)
    expect(BigInt(payload.cumulativeAmount)).toBe(sellerClaim);
  });

  it('signPerRequestAuth does not underpay when seller claim is slightly above buyer estimate', async () => {
    const sellerPeerId = fakePeerId('seller-no-underpay');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims 10% more than buyer's estimate — well within tolerance
    const sellerClaim = SAMPLE_ESTIMATE.cost + SAMPLE_ESTIMATE.cost / 10n;
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: sellerClaim },
    );

    // acceptedCost must be the seller's claim, not the buyer's lower estimate
    const cumulative = BigInt(payload.cumulativeAmount);
    expect(cumulative).toBe(sellerClaim);
    expect(cumulative).toBeGreaterThan(SAMPLE_ESTIMATE.cost);
  });

  it('signPerRequestAuth trusts seller claimed cost of zero (no byte fallback)', async () => {
    const sellerPeerId = fakePeerId('seller-zero-claim');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 0n },
    );

    // Seller claimed cost=0 is authoritative — no byte-based fallback, no forced +1
    expect(BigInt(payload.cumulativeAmount)).toBe(0n);
  });

  it('signPerRequestAuth prefers reported tokens over byte estimation for metadata', async () => {
    const sellerPeerId = fakePeerId('seller-reported');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const reportedIn = 5000n;
    const reportedOut = 200n;
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        reportedInputTokens: reportedIn,
        reportedOutputTokens: reportedOut,
      },
    );

    // Metadata should encode reported tokens, not byte-estimated tokens.
    // The metadata is ABI-encoded: (version, inputTokens, outputTokens, requestCount)
    // We can verify by checking the payload has a valid metadataHash
    expect(payload.metadata).toBeTypeOf('string');
    expect(payload.metadataHash).toBeTypeOf('string');
    // Cumulative should use cost from reported tokens, not from bytes.
    // Since cumulative starts at 0, the cumulative amount equals the reported cost.
    const reportedCost = BigInt(Math.round(
      (Number(reportedIn) * TEST_PRICING.inputUsdPerMillion +
       Number(reportedOut) * TEST_PRICING.outputUsdPerMillion) / 1_000_000 * 1_000_000
    ));
    expect(BigInt(payload.cumulativeAmount)).toBe(reportedCost);
  });

  it('signPerRequestAuth includes cached tokens in metadata input total', async () => {
    const sellerPeerId = fakePeerId('seller-cached-total');
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 };
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, pricing);

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        reportedInputTokens: 1000n,
        reportedCachedInputTokens: 800n,
        reportedOutputTokens: 100n,
      },
    );

    const meta = decodeMetadataTokens(payload.metadata);
    expect(meta.inputTokens).toBe(1000n);
    expect(meta.outputTokens).toBe(100n);
    expect(BigInt(payload.cumulativeAmount)).toBe(2340n);
  });

  it('signPerRequestAuth appends cumulative per-service metadata', async () => {
    const sellerPeerId = fakePeerId('seller-service-meta');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 100n,
        reportedInputTokens: 1000n,
        reportedCachedInputTokens: 200n,
        reportedOutputTokens: 50n,
        service: 'gpt-5',
      },
    );

    await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 150n,
        reportedInputTokens: 500n,
        reportedCachedInputTokens: 100n,
        reportedOutputTokens: 25n,
        service: 'gpt-5',
      },
    );

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 250n,
        reportedInputTokens: 2000n,
        reportedCachedInputTokens: 300n,
        reportedOutputTokens: 75n,
        service: 'claude-opus',
      },
    );

    // The legacy first-four-field decode still works with the appended services array.
    const meta = decodeMetadataTokens(payload.metadata);
    expect(meta.inputTokens).toBe(3500n);
    expect(meta.outputTokens).toBe(150n);

    const services = decodeMetadataServices(payload.metadata);
    expect(services).toHaveLength(2);
    expect(services).toContainEqual({
      serviceId: id('gpt-5'),
      cumulativeAmount: 250n,
      cumulativeInputTokens: 1500n,
      cumulativeCachedInputTokens: 300n,
      cumulativeOutputTokens: 75n,
      cumulativeRequestCount: 2n,
      cumulativeOutputImages: 0n,
    });
    expect(services).toContainEqual({
      serviceId: id('claude-opus'),
      cumulativeAmount: 250n,
      cumulativeInputTokens: 2000n,
      cumulativeCachedInputTokens: 300n,
      cumulativeOutputTokens: 75n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 0n,
    });

    const channel = store.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER);
    expect(channel).not.toBeNull();
    const storedServices = store.getServiceTotals(channel!.sessionId);
    expect(storedServices).toHaveLength(2);
    expect(storedServices).toContainEqual(expect.objectContaining({
      serviceId: id('gpt-5'),
      cumulativeAmount: '250',
      cumulativeInputTokens: '1500',
      cumulativeCachedInputTokens: '300',
      cumulativeOutputTokens: '75',
      cumulativeRequestCount: '2',
    }));
  });

  it('signPerRequestAuth suppresses per-service metadata when disabled', async () => {
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, {
      disableMetadataV2Services: true,
    }), store);
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-no-service-meta');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 100n,
        reportedInputTokens: 1000n,
        reportedCachedInputTokens: 200n,
        reportedOutputTokens: 50n,
        service: 'sensitive-model',
      },
    );

    const meta = decodeMetadataTokens(payload.metadata);
    expect(meta.inputTokens).toBe(1000n);
    expect(meta.outputTokens).toBe(50n);
    expect(decodeMetadataServices(payload.metadata)).toEqual([]);

    const channel = store.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER);
    expect(channel).not.toBeNull();
    expect(store.getServiceTotals(channel!.sessionId)).toEqual([]);
  });

  it('signPerRequestAuth hydrates cumulative service metadata after restart', async () => {
    const sellerPeerId = fakePeerId('seller-service-restart');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    await manager.handleAuthAck(sellerPeerId, { channelId });

    await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 100n,
        reportedInputTokens: 1000n,
        reportedCachedInputTokens: 200n,
        reportedOutputTokens: 50n,
        service: 'gpt-5',
      },
    );

    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(identity.wallet);

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 150n,
        reportedInputTokens: 500n,
        reportedCachedInputTokens: 100n,
        reportedOutputTokens: 25n,
        service: 'gpt-5',
      },
    );

    const [service] = decodeMetadataServices(payload.metadata);
    expect(service).toEqual({
      serviceId: id('gpt-5'),
      cumulativeAmount: 250n,
      cumulativeInputTokens: 1500n,
      cumulativeCachedInputTokens: 300n,
      cumulativeOutputTokens: 75n,
      cumulativeRequestCount: 2n,
      cumulativeOutputImages: 0n,
    });
  });

  it('signPerRequestAuth throws if no active session', async () => {
    await expect(
      manager.signPerRequestAuth('nonexistent-peer', { inputBytes: new Uint8Array(0), outputBytes: new Uint8Array(0) }),
    ).rejects.toThrow(/No active session/);
  });

  it('signs per-worker totals for colony pool requests and keeps them across a restart', async () => {
    const sellerPeerId = fakePeerId('seller-colony-pool');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    await manager.handleAuthAck(sellerPeerId, { channelId });
    const workerA = '0x1000000000000000000000000000000000000001';
    const workerB = '0x2000000000000000000000000000000000000002';
    const stats = (requestId: string, sellerClaimedCost: bigint) => ({
      inputBytes: SAMPLE_INPUT,
      outputBytes: SAMPLE_OUTPUT,
      sellerClaimedCost,
      reportedInputTokens: 100n,
      reportedOutputTokens: 10n,
      service: 'qwen',
      requestId,
    });

    const usage = { inputTokens: 100n, cachedInputTokens: 0n, outputTokens: 10n };
    // The buyer's own price for each answer, as its request path records it.
    const delivered = (requestId: string, costUsdc: bigint) => manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc });
    manager.recordWorkerAttribution(sellerPeerId, 'req-a', workerA);
    delivered('req-a', 100n);
    manager.recordWorkerDelivery('req-a', usage);
    await manager.signPerRequestAuth(sellerPeerId, stats('req-a', 100n));
    manager.recordWorkerAttribution(sellerPeerId, 'req-b', workerB);
    delivered('req-b', 150n);
    manager.recordWorkerDelivery('req-b', usage);
    await manager.signPerRequestAuth(sellerPeerId, stats('req-b', 150n));
    // A request no worker was assigned (an ordinary provider of the same seller) stays unattributed.
    manager.trackPoolSellerRequest(sellerPeerId, 'req-c');
    delivered('req-c', 50n);
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, stats('req-c', 50n));
    expect(decodeWorkerTail(payload.metadata)).toEqual([
      { worker: workerA, cumulativeAmount: 100n },
      { worker: workerB, cumulativeAmount: 150n },
    ]);
    expect(decodeMetadataTokens(payload.metadata).inputTokens).toBe(300n);

    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(identity.wallet);
    manager.recordWorkerAttribution(sellerPeerId, 'req-d', workerA);
    manager.recordDeliveredResponse(sellerPeerId, 'req-d', { costUsdc: 25n });
    manager.recordWorkerDelivery('req-d', usage);
    const after = await manager.signPerRequestAuth(sellerPeerId, stats('req-d', 25n));
    expect(decodeWorkerTail(after.payload.metadata)).toEqual([
      { worker: workerA, cumulativeAmount: 125n },
      { worker: workerB, cumulativeAmount: 150n },
    ]);
  });

  it('credits a worker from headroom signed before its answer, re-signing at the same amount', async () => {
    const sellerPeerId = fakePeerId('seller-colony-pool-headroom');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    await manager.handleAuthAck(sellerPeerId, { channelId });
    const worker = '0x1000000000000000000000000000000000000001';
    const usage = { inputTokens: 100n, cachedInputTokens: 0n, outputTokens: 10n };
    const stats = (requestId: string) => ({
      inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 100n,
      reportedInputTokens: 100n, reportedOutputTokens: 10n, service: 'qwen', requestId,
    });
    // A seller prompt signs 500 ahead, before any answer: no worker to credit yet.
    mux.sentSpendingAuths.length = 0;
    await manager.handleNeedAuth(sellerPeerId, { channelId, requiredCumulativeAmount: '500', currentAcceptedCumulative: '0', deposit: '1000000' }, mux);
    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect(decodeWorkerTail((mux.sentSpendingAuths[0] as { metadata: string }).metadata)).toBeNull();
    // Two worker answers the headroom covers: the amount stays, each is credited.
    for (const requestId of ['req-a', 'req-b']) {
      manager.recordWorkerAttribution(sellerPeerId, requestId, worker);
      manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: 100n });
      manager.recordWorkerDelivery(requestId, usage);
      await manager.signPerRequestAuth(sellerPeerId, stats(requestId));
    }
    const latest = manager.latestSpendingAuth(sellerPeerId)!;
    expect(latest.cumulativeAmount).toBe('500');
    expect(decodeWorkerTail(latest.metadata)).toEqual([{ worker, cumulativeAmount: 200n }]);
  });

  it('keeps every uncounted worker answer when more arrive than the request ledger holds', async () => {
    const sellerPeerId = fakePeerId('seller-colony-pool-ledger-cap');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    await manager.handleAuthAck(sellerPeerId, { channelId });
    const worker = '0x1000000000000000000000000000000000000001';
    const usage = { inputTokens: 1n, cachedInputTokens: 0n, outputTokens: 1n };
    // Past the ledger's 512 records, with ordinary requests mixed in: those go first.
    for (let i = 0; i < 600; i++) {
      manager.trackPoolSellerRequest(sellerPeerId, `plain-${i}`);
      manager.recordDeliveredResponse(sellerPeerId, `plain-${i}`, { costUsdc: 1n });
      manager.recordWorkerAttribution(sellerPeerId, `req-${i}`, worker);
      manager.recordDeliveredResponse(sellerPeerId, `req-${i}`, { costUsdc: 10n });
      manager.recordWorkerDelivery(`req-${i}`, usage);
    }
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
      inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10n,
      reportedInputTokens: 1n, reportedOutputTokens: 1n, service: 'qwen', requestId: 'req-599',
    });
    expect(decodeWorkerTail(payload.metadata)).toEqual([{ worker, cumulativeAmount: 6_000n }]);
  });

  it('credits only the recipient whose answer verified when a request is encrypted for several workers', async () => {
    const sellerPeerId = fakePeerId('seller-colony-pool-recipients');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    await manager.handleAuthAck(sellerPeerId, { channelId });
    const workerA = '0x1000000000000000000000000000000000000001';
    const workerB = '0x2000000000000000000000000000000000000002';
    const outsider = '0x3000000000000000000000000000000000000003';
    const usage = { inputTokens: 100n, cachedInputTokens: 0n, outputTokens: 10n };
    const stats = (requestId: string) => ({
      inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 100n,
      reportedInputTokens: 100n, reportedOutputTokens: 10n, service: 'qwen', requestId,
    });
    // The pool failed over to B: only B is credited.
    manager.recordWorkerAttribution(sellerPeerId, 'req-a', [workerA, workerB]);
    manager.recordDeliveredResponse(sellerPeerId, 'req-a', { costUsdc: 100n });
    manager.recordWorkerDelivery('req-a', usage, workerB);
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, stats('req-a'));
    expect(decodeWorkerTail(payload.metadata)).toEqual([{ worker: workerB, cumulativeAmount: 100n }]);
    // An answer from a worker outside the set, or one that names no worker, is never paid.
    manager.recordWorkerAttribution(sellerPeerId, 'req-b', [workerA, workerB]);
    manager.recordWorkerDelivery('req-b', usage, outsider);
    await expect(manager.signPerRequestAuth(sellerPeerId, stats('req-b'))).rejects.toThrow();
    manager.recordWorkerAttribution(sellerPeerId, 'req-c', [workerA, workerB]);
    manager.recordWorkerDelivery('req-c', usage);
    await expect(manager.signPerRequestAuth(sellerPeerId, stats('req-c'))).rejects.toThrow();
  });

  describe('NeedAuth for colony pool requests', () => {
    const worker = '0x1000000000000000000000000000000000000001';
    const usage = { inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 400n };
    const setup = async (name: string, pricing: typeof TEST_PRICING & { cachedInputUsdPerMillion?: number } = TEST_PRICING) => {
      const sellerPeerId = fakePeerId(name);
      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, pricing);
      await manager.handleAuthAck(sellerPeerId, { channelId });
      mux.sentSpendingAuths.length = 0;
      manager.recordWorkerAttribution(sellerPeerId, 'req-pool', worker);
      // Priced consistently with TEST_PRICING ($3 in, $15 out per million): 1000 in + 400 out = 9000.
      const needAuth = (claim: { inputTokens: string; outputTokens: string; lastRequestCost: string; cachedInputTokens?: string; freshInputTokens?: string } = { inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000' }) => manager.handleNeedAuth(sellerPeerId, {
        channelId, requiredCumulativeAmount: '19000', currentAcceptedCumulative: '10000', deposit: '1000000',
        requestId: 'req-pool', ...claim,
      }, mux);
      // The worker's answer verified, priced by the buyer first as its request path does.
      const answered = (answerUsage: typeof usage = usage, costUsdc = 9000n) => {
        manager.recordDeliveredResponse(sellerPeerId, 'req-pool', { costUsdc });
        manager.recordWorkerDelivery('req-pool', answerUsage);
      };
      return { needAuth, sellerPeerId, answered };
    };

    it('waits for the worker\'s answer to verify, then signs and attributes it', async () => {
      const { needAuth, answered } = await setup('seller-pool-verified');
      const pending = needAuth();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mux.sentSpendingAuths).toHaveLength(0);
      answered();
      await pending;
      expect(mux.sentSpendingAuths).toHaveLength(1);
      const sent = mux.sentSpendingAuths[0] as { metadata: string };
      expect(decodeWorkerTail(sent.metadata)).toEqual([{ worker, cumulativeAmount: 9000n }]);
    });

    it('credits the worker from signed headroom when the answer\'s NeedAuth asks for no more than is signed', async () => {
      const { needAuth, sellerPeerId, answered } = await setup('seller-pool-covered');
      // A seller prompt signs ahead, before the answer: no worker to credit yet.
      await manager.handleNeedAuth(sellerPeerId, { channelId: manager.getActiveSession(sellerPeerId)!.sessionId, requiredCumulativeAmount: '19000', currentAcceptedCumulative: '10000', deposit: '1000000' }, mux);
      const signed = manager.latestSpendingAuth(sellerPeerId)!;
      expect(BigInt(signed.cumulativeAmount)).toBeGreaterThanOrEqual(19_000n);
      expect(decodeWorkerTail(signed.metadata)).toBeNull();
      // The answer's NeedAuth asks for 19000, already signed: the auth is signed again with the worker in its
      // tail, one unit higher, so the pool can settle it even when it already settled the headroom.
      answered();
      mux.sentSpendingAuths.length = 0;
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(1);
      const sent = mux.sentSpendingAuths[0] as { cumulativeAmount: string; metadata: string };
      expect(BigInt(sent.cumulativeAmount)).toBe(BigInt(signed.cumulativeAmount) + 1n);
      expect(decodeWorkerTail(sent.metadata)).toEqual([{ worker, cumulativeAmount: 9000n }]);
      // Counted once: the same frame again signs nothing.
      mux.sentSpendingAuths.length = 0;
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('signs nothing after the response for a worker answer that authenticated no usage, whatever the buyer estimated', async () => {
      const { sellerPeerId, answered } = await setup('seller-pool-zero-usage');
      const before = manager.getCumulativeAmount(sellerPeerId);
      // The buyer's own parse priced the response at 9000; the worker authenticated nothing.
      answered({ inputTokens: 0n, cachedInputTokens: 0n, outputTokens: 0n }, 9000n);
      const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, requestId: 'req-pool',
      });
      expect(BigInt(payload.cumulativeAmount)).toBe(before);
      expect(decodeWorkerTail(payload.metadata)).toBeNull();
    });

    it('prices a worker answer after the response from its authenticated usage, not a higher estimate', async () => {
      const { sellerPeerId, answered } = await setup('seller-pool-authenticated-price');
      const before = manager.getCumulativeAmount(sellerPeerId);
      // 1000 in + 400 out = 9000 authenticated; the buyer's parse said 20000.
      answered(usage, 20_000n);
      const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, requestId: 'req-pool',
      });
      expect(BigInt(payload.cumulativeAmount)).toBe(before + 9000n);
      expect(decodeWorkerTail(payload.metadata)).toEqual([{ worker, cumulativeAmount: 9000n }]);
    });

    it('lets concurrent requests credit no more workers than a channel holds, counting ones still in flight', async () => {
      const sellerPeerId = fakePeerId('seller-pool-slots');
      const w = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
      // Seven requests in flight, each to its own worker: one slot is left.
      for (let i = 1; i <= 7; i++) manager.recordWorkerAttribution(sellerPeerId, `req-slot-${i}`, w(i));
      // Two more, chosen before either is answered: the first takes the last slot, the second gets only known workers.
      const first = manager.creditableWorkers(sellerPeerId, [w(8), w(9)]);
      expect(first).toEqual([w(8)]);
      manager.recordWorkerAttribution(sellerPeerId, 'req-slot-8', first);
      expect(manager.creditableWorkers(sellerPeerId, [w(10), w(3)])).toEqual([w(3)]);
      expect(manager.creditableWorkers(sellerPeerId, [w(10)])).toEqual([]);
      // A request whose answer failed credits no one, so its worker's slot is free again.
      manager.recordWorkerDelivery('req-slot-8', null);
      expect(manager.creditableWorkers(sellerPeerId, [w(10)])).toEqual([w(10)]);
    });

    it('never charges a verified worker answer to a request sent free, on a channel with paid pricing', async () => {
      const { sellerPeerId } = await setup('seller-pool-free-request');
      manager.recordWorkerAttribution(sellerPeerId, 'req-free-worker', worker, true);
      manager.recordWorkerDelivery('req-free-worker', usage);
      const channelId = manager.getActiveSession(sellerPeerId)!.sessionId;
      const signed = manager.getCumulativeAmount(sellerPeerId);
      // Passes the paid pricing checks (1000 in + 400 out = 9000), so only the free flag refuses it.
      await manager.handleNeedAuth(sellerPeerId, {
        channelId, requiredCumulativeAmount: '19000', currentAcceptedCumulative: '10000', deposit: '1000000',
        requestId: 'req-free-worker', inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000',
      }, mux);
      expect(mux.sentSpendingAuths).toHaveLength(0);
      await expect(manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 9000n, requestId: 'req-free-worker', service: 'qwen',
      })).rejects.toThrow(/sent free/);
      expect(manager.getCumulativeAmount(sellerPeerId)).toBe(signed);
    });

    it('refuses a NeedAuth that arrives before a tampered or truncated answer fails verification', async () => {
      const { needAuth } = await setup('seller-pool-fails-later');
      const pending = needAuth();
      await new Promise((resolve) => setTimeout(resolve, 20));
      manager.recordWorkerDelivery('req-pool', null);
      await pending;
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('refuses a pool seller\'s claim that drops or changes the request ID after a failed answer', async () => {
      const { sellerPeerId } = await setup('seller-pool-untracked');
      manager.recordWorkerDelivery('req-pool', null);
      const channelId = manager.getActiveSession(sellerPeerId)!.sessionId;
      const claim = { channelId, requiredCumulativeAmount: '19000', currentAcceptedCumulative: '10000', deposit: '1000000', inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000' };
      // No request ID at all, then a fresh one the buyer never sent.
      await manager.handleNeedAuth(sellerPeerId, claim, mux);
      await manager.handleNeedAuth(sellerPeerId, { ...claim, requestId: 'req-invented' }, mux);
      // A zero-cost delivered claim is judged too.
      await manager.handleNeedAuth(sellerPeerId, { ...claim, requestId: 'req-invented-2', lastRequestCost: '0' }, mux);
      expect(mux.sentSpendingAuths).toHaveLength(0);
      await expect(manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 9000n, requestId: 'req-invented', service: 'qwen',
      })).rejects.toThrow(/no verified answer/);
      await expect(manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 9000n,
      })).rejects.toThrow(/no verified answer/);
    });

    it('pays a pool seller for an ordinary request the buyer sent it, and a marked seller only for those', async () => {
      const sellerPeerId = fakePeerId('seller-pool-mixed');
      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
      await manager.handleAuthAck(sellerPeerId, { channelId });
      mux.sentSpendingAuths.length = 0;
      manager.markWorkerSeller(sellerPeerId);
      const claim = { channelId, requiredCumulativeAmount: '19000', currentAcceptedCumulative: '10000', deposit: '1000000', inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000' };
      manager.recordDeliveredResponse(sellerPeerId, 'req-ordinary', { costUsdc: 9000n });
      await manager.handleNeedAuth(sellerPeerId, { ...claim, requestId: 'req-ordinary' }, mux);
      expect(mux.sentSpendingAuths).toHaveLength(0);
      manager.trackPoolSellerRequest(sellerPeerId, 'req-ordinary');
      await manager.handleNeedAuth(sellerPeerId, { ...claim, requestId: 'req-ordinary' }, mux);
      expect(mux.sentSpendingAuths).toHaveLength(1);
      // Ordinary work is never credited to a worker.
      expect(decodeWorkerTail((mux.sentSpendingAuths[0] as { metadata: string }).metadata)).toBeNull();
    });

    it('does not reopen a pool seller\'s overdraft window on its own headroom prompts', async () => {
      const prompts = async (sellerPeerId: string, pool: boolean) => {
        const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
        await manager.handleAuthAck(sellerPeerId, { channelId });
        if (pool) manager.markWorkerSeller(sellerPeerId);
        mux.sentSpendingAuths.length = 0;
        // Headroom prompts: no request, no delivered cost, each asking past the window.
        for (const required of ['100000', '200000', '300000']) {
          await manager.handleNeedAuth(sellerPeerId, { channelId, requiredCumulativeAmount: required, currentAcceptedCumulative: '0', deposit: '1000000' }, mux);
        }
        return manager.getCumulativeAmount(sellerPeerId);
      };
      // The pool keeps the one prepaid window ($0.10) and gets nothing more without an answer.
      expect(await prompts(fakePeerId('seller-pool-headroom'), true)).toBe(100_000n);
      expect(mux.sentSpendingAuths).toHaveLength(1);
    });

    it('leaves sellers without colony-pool workers unaffected', async () => {
      const sellerPeerId = fakePeerId('seller-not-a-pool');
      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
      await manager.handleAuthAck(sellerPeerId, { channelId });
      mux.sentSpendingAuths.length = 0;
      manager.recordDeliveredResponse(sellerPeerId, 'req-any', { costUsdc: 9000n });
      await manager.handleNeedAuth(sellerPeerId, {
        channelId, requiredCumulativeAmount: '19000', currentAcceptedCumulative: '10000', deposit: '1000000',
        inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000', requestId: 'req-any',
      }, mux);
      expect(mux.sentSpendingAuths).toHaveLength(1);
    });

    it('refuses a NeedAuth that arrives after the answer failed verification', async () => {
      const { needAuth } = await setup('seller-pool-failed');
      manager.recordWorkerDelivery('req-pool', null);
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('still refuses a failed delivery after later requests evict its record', async () => {
      const { needAuth, sellerPeerId } = await setup('seller-pool-evicted');
      manager.recordWorkerDelivery('req-pool', null);
      // 512 later worker requests (each answered and verified) push req-pool out of the cache.
      for (let i = 0; i < 600; i++) {
        manager.recordWorkerAttribution(sellerPeerId, `req-later-${i}`, worker);
        manager.recordWorkerDelivery(`req-later-${i}`, usage);
      }
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
      await expect(manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 9000n, requestId: 'req-pool',
      })).rejects.toThrow(/no verified answer/);
    });

    it('still refuses a pending delivery evicted before its NeedAuth arrives', async () => {
      const { needAuth, sellerPeerId } = await setup('seller-pool-evicted-pending');
      for (let i = 0; i < 600; i++) manager.recordWorkerAttribution(sellerPeerId, `req-later-${i}`, worker);
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('still pays a verified answer whose NeedAuth comes after later requests filled the cache', async () => {
      const { needAuth, sellerPeerId, answered } = await setup('seller-pool-deferred');
      answered();
      // 600 later worker requests would push a record out; a verified answer not yet paid is kept.
      for (let i = 0; i < 600; i++) manager.recordWorkerAttribution(sellerPeerId, `req-later-${i}`, worker);
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(1);
      const sent = mux.sentSpendingAuths[0] as { metadata: string };
      expect(decodeWorkerTail(sent.metadata)).toEqual([{ worker, cumulativeAmount: 9000n }]);
    });

    it('retires worker answers a free allowance covered, so they never fill the owed limit', async () => {
      const { needAuth, sellerPeerId } = await setup('seller-pool-allowance');
      // More covered answers on a priced service than the owed limit (4,096) allows.
      for (let i = 0; i < 4_200; i++) {
        const id = `req-covered-${i}`;
        manager.recordWorkerAttribution(sellerPeerId, id, worker);
        manager.recordWorkerDelivery(id, usage);
        manager.markRequestCovered(sellerPeerId, id);
      }
      expect(() => manager.recordWorkerAttribution(sellerPeerId, 'req-after', worker)).not.toThrow();
      // A covered answer is still never paid for.
      manager.recordWorkerDelivery('req-pool', usage);
      manager.markRequestCovered(sellerPeerId, 'req-pool');
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('refuses a NeedAuth from another seller naming a worker request', async () => {
      await setup('seller-pool-owner');
      manager.recordWorkerDelivery('req-pool', usage);
      const other = fakePeerId('seller-pool-other');
      const channelId = await manager.authorizeSpending(other, mux, 10_000n, TEST_PRICING);
      await manager.handleAuthAck(other, { channelId });
      mux.sentSpendingAuths.length = 0;
      await manager.handleNeedAuth(other, {
        channelId, requiredCumulativeAmount: '19000', currentAcceptedCumulative: '10000', deposit: '1000000',
        requestId: 'req-pool', inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000',
      }, mux);
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('refuses the first seller\'s NeedAuth after the request is retried through another seller', async () => {
      const { needAuth, answered } = await setup('seller-pool-retried-away');
      answered();
      manager.recordWorkerAttribution(fakePeerId('seller-pool-retry-target'), 'req-pool', worker);
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('refuses to pay for more tokens than the worker authenticated', async () => {
      const { needAuth, answered } = await setup('seller-pool-inflated');
      // Recorded as delivered, so only the worker's sealed usage can refuse the claim.
      answered();
      // Consistently priced, but for 600 output tokens where the worker sealed 400.
      await needAuth({ inputTokens: '1000', outputTokens: '600', lastRequestCost: '12000' });
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    describe('with cached input', () => {
      // $3 fresh, $0.30 cached, $15 out per million. The worker sealed 1000 input
      // tokens, 900 of them cached: 100 * 3 + 900 * 0.3 + 400 * 15 = 6570.
      const cachedPricing = { ...TEST_PRICING, cachedInputUsdPerMillion: 0.3 };
      const cachedUsage = { inputTokens: 1000n, cachedInputTokens: 900n, outputTokens: 400n };

      it('signs the authenticated fresh and cached split', async () => {
        const { needAuth, answered } = await setup('seller-pool-cached-ok', cachedPricing);
        answered(cachedUsage, 6570n);
        await needAuth({ inputTokens: '1000', cachedInputTokens: '900', freshInputTokens: '100', outputTokens: '400', lastRequestCost: '6570' });
        expect(mux.sentSpendingAuths).toHaveLength(1);
      });

      it('refuses cached input billed as fresh', async () => {
        const { needAuth, answered } = await setup('seller-pool-cached-as-fresh', cachedPricing);
        answered(cachedUsage, 6570n);
        // Consistently priced for 1000 fresh tokens: 3000 + 6000.
        await needAuth({ inputTokens: '1000', cachedInputTokens: '0', freshInputTokens: '1000', outputTokens: '400', lastRequestCost: '9000' });
        expect(mux.sentSpendingAuths).toHaveLength(0);
      });

      it('refuses cached input billed as fresh when the fresh count is left out', async () => {
        const { needAuth, answered } = await setup('seller-pool-cached-dropped', cachedPricing);
        answered(cachedUsage, 6570n);
        await needAuth({ inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000' });
        expect(mux.sentSpendingAuths).toHaveLength(0);
      });

      it('refuses an inflated cached count', async () => {
        const { needAuth, answered } = await setup('seller-pool-cached-inflated', cachedPricing);
        answered(cachedUsage, 6570n);
        await needAuth({ inputTokens: '1000', cachedInputTokens: '5000', freshInputTokens: '100', outputTokens: '400', lastRequestCost: '7770' });
        expect(mux.sentSpendingAuths).toHaveLength(0);
      });

      it('refuses a cost above the authenticated usage even within the estimate tolerance', async () => {
        const { needAuth, answered } = await setup('seller-pool-cached-tolerance', cachedPricing);
        answered(cachedUsage, 6570n);
        await needAuth({ inputTokens: '1000', cachedInputTokens: '900', freshInputTokens: '100', outputTokens: '400', lastRequestCost: '8000' });
        expect(mux.sentSpendingAuths).toHaveLength(0);
      });
    });

    it('prices a per-request auth from the worker\'s authenticated usage, not reported counts', async () => {
      const sellerPeerId = fakePeerId('seller-pool-per-request-usage');
      const { answered } = await setup('seller-pool-per-request-usage');
      answered();
      const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 9000n, requestId: 'req-pool',
        reportedInputTokens: 50_000n, reportedOutputTokens: 50_000n, service: 'qwen',
      });
      const tokens = decodeMetadataTokens(payload.metadata);
      expect(tokens.inputTokens).toBe(1000n);
      expect(tokens.outputTokens).toBe(400n);
    });

    it('pays a worker\'s authenticated price, not a larger claim within the estimate tolerance', async () => {
      const sellerPeerId = fakePeerId('seller-pool-per-request-cap');
      const { answered } = await setup('seller-pool-per-request-cap');
      answered();
      const before = manager.getCumulativeAmount(sellerPeerId);
      // 1000 in and 400 out price at 9000; 12,000 is within the 1.4x tolerance.
      await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 12_000n, requestId: 'req-pool', service: 'qwen',
      });
      expect(manager.getCumulativeAmount(sellerPeerId) - before).toBe(9000n);
    });

    it('pays nothing for a worker\'s answer that authenticated no usage, instead of estimating from bytes', async () => {
      const sellerPeerId = fakePeerId('seller-pool-per-request-zero');
      await setup('seller-pool-per-request-zero');
      manager.recordWorkerDelivery('req-pool', { inputTokens: 0n, cachedInputTokens: 0n, outputTokens: 0n });
      const before = manager.getCumulativeAmount(sellerPeerId);
      await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, requestId: 'req-pool', service: 'qwen',
      });
      expect(manager.getCumulativeAmount(sellerPeerId)).toBe(before);
    });

    it('a zero-cost NeedAuth cannot clear a failed delivery for a later paid claim', async () => {
      const { needAuth, sellerPeerId } = await setup('seller-pool-zero-cost');
      const before = manager.getCumulativeAmount(sellerPeerId);
      manager.recordWorkerDelivery('req-pool', null);
      await needAuth({ inputTokens: '0', outputTokens: '0', lastRequestCost: '0' });
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
      expect(manager.getCumulativeAmount(sellerPeerId)).toBe(before);
    });

    it('refuses a second claim for a worker request already paid by the buyer', async () => {
      const { needAuth, sellerPeerId } = await setup('seller-pool-buyer-first');
      manager.recordWorkerDelivery('req-pool', usage);
      await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 9000n, requestId: 'req-pool', service: 'qwen',
      });
      const paid = manager.getCumulativeAmount(sellerPeerId);
      mux.sentSpendingAuths.length = 0;
      // The seller's NeedAuth for the same request, asking past what was signed.
      await manager.handleNeedAuth(sellerPeerId, {
        channelId: manager.getActiveSession(sellerPeerId)!.sessionId, requiredCumulativeAmount: (paid + 9000n).toString(),
        currentAcceptedCumulative: paid.toString(), deposit: '1000000',
        requestId: 'req-pool', inputTokens: '1000', outputTokens: '400', lastRequestCost: '9000',
      }, mux);
      expect(mux.sentSpendingAuths).toHaveLength(0);
      expect(manager.getCumulativeAmount(sellerPeerId)).toBe(paid);
      await needAuth();
      expect(mux.sentSpendingAuths).toHaveLength(0);
    });

    it('does not charge a retired worker request again after its counted entry is trimmed', async () => {
      const { needAuth, sellerPeerId } = await setup('seller-pool-trimmed');
      manager.recordWorkerDelivery('req-pool', usage);
      await needAuth();
      const paid = manager.getCumulativeAmount(sellerPeerId);
      // 600 later counted requests push req-pool out of the counted-request tracker.
      for (let i = 0; i < 600; i++) {
        manager.trackPoolSellerRequest(sellerPeerId, `req-free-${i}`);
        await manager.signPerRequestAuth(sellerPeerId, {
          inputBytes: new Uint8Array(), outputBytes: new Uint8Array(), sellerClaimedCost: 0n, requestId: `req-free-${i}`,
        });
      }
      const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 9000n, requestId: 'req-pool', service: 'qwen',
      });
      expect(BigInt(payload.cumulativeAmount)).toBe(paid);
    });

    it('never counts verified worker requests toward the unpaid-request limit', () => {
      const sellerPeerId = fakePeerId('seller-pool-healthy');
      // Free (verified, never billed) answers, far past the 16,384 unpaid limit.
      for (let i = 0; i < 17_000; i++) {
        manager.recordWorkerAttribution(sellerPeerId, `req-free-${i}`, worker, true);
        manager.recordWorkerDelivery(`req-free-${i}`, usage);
      }
      expect(() => manager.recordWorkerAttribution(sellerPeerId, 'req-next', worker)).not.toThrow();
      // Unanswered ones still count.
      const flaky = fakePeerId('seller-pool-flaky');
      expect(() => {
        for (let i = 0; i < 17_500; i++) manager.recordWorkerAttribution(flaky, `req-lost-${i}`, worker);
      }).toThrow(/Too many unpaid colony-pool requests/);
    });

    it('refuses to sign a per-request auth for an unverified worker answer', async () => {
      await setup('seller-pool-per-request');
      await expect(manager.signPerRequestAuth(fakePeerId('seller-pool-per-request'), {
        inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 100n, requestId: 'req-pool',
      })).rejects.toThrow(/no verified answer/);
    });
  });

  // ── handleNeedAuth ─────────────────────────────────────────────

  it('handleNeedAuth signs within overdraft limit', async () => {
    const sellerPeerId = fakePeerId('seller-needauth');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    // Verified cost is 0, so maxSignable = 0 + 100_000 = 100_000
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe('50000');
  });

  it('remembers the highest amount the seller reported accepting on the active channel, until it retires', async () => {
    const sellerPeerId = fakePeerId('seller-accepted');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-10', { costUsdc: 10_000n });
    const needAuth = (required: string, accepted: string) => manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'paid-request-10', requiredCumulativeAmount: required, currentAcceptedCumulative: accepted, deposit: '1000000', lastRequestCost: '10000',
    }, mux);

    await needAuth('50000', '40000');
    // A NeedAuth that was overtaken on the wire reports less: the higher one stands.
    await needAuth('20000', '10000');
    const seen = manager.getSellerAcceptedCumulative(sellerPeerId);
    manager.retireSession(sellerPeerId, CHANNEL_STATUS.SETTLED);

    expect({ seen, afterRetire: manager.getSellerAcceptedCumulative(sellerPeerId) }).toEqual({ seen: 40_000n, afterRetire: 0n });
  });

  it('handleNeedAuth signs concurrent NeedAuths one at a time: no lost cost, no lower cumulative after a higher one', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-race');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;
    // The first signature is slow, so without serializing the second would commit first.
    const wallet = Wallet.createRandom();
    let calls = 0;
    const slowFirst = new Proxy(wallet, {
      get(target, property, receiver) {
        if (property !== 'signTypedData') return Reflect.get(target, property, receiver);
        return async (...args: Parameters<Wallet['signTypedData']>) => {
          calls += 1;
          if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 50));
          return target.signTypedData(...args);
        };
      },
    });
    manager.setSigner(slowFirst);

    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-a', { costUsdc: 40_000n });
    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-b', { costUsdc: 40_000n });
    await Promise.all([
      manager.handleNeedAuth(sellerPeerId, { channelId, requestId: 'paid-request-a', requiredCumulativeAmount: '40000', currentAcceptedCumulative: '0', deposit: '1000000', lastRequestCost: '40000' }, mux),
      manager.handleNeedAuth(sellerPeerId, { channelId, requestId: 'paid-request-b', requiredCumulativeAmount: '80000', currentAcceptedCumulative: '0', deposit: '1000000', lastRequestCost: '40000' }, mux),
    ]);

    expect(mux.sentSpendingAuths.map((auth) => (auth as Record<string, unknown>).cumulativeAmount)).toEqual(['40000', '80000']);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(80_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(80_000n);
  });

  it('judges NeedAuths in arrival order while an image NeedAuth waits for its delivery: the image is counted once, never charged again at close', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-image-order');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestBilling('req-image-order', {
      context: {
        sellerPeerId,
        provider: 'openai',
        service: 'gpt-image-2',
        serviceApiProtocol: 'openai-images',
        attributes: { model: 'gpt-image-2', size: '1024x1024' },
      },
      requestFacts: { kind: 'image', image: {} },
      tokenPricing: TEST_PRICING,
      unitModel: { version: 1, components: [{ unit: 'output_images', priceUsd: 0.004, match: { size: '1024x1024' } }] },
    });
    mux.sentSpendingAuths.length = 0;

    const imageCost = 11_750n; // 1000 input + 50 output tokens, plus 2 images at $0.004
    const tokenCost = 40_000n;
    // The image NeedAuth arrives before the buyer saw the images; a token
    // NeedAuth for the next request arrives right behind it.
    manager.recordDeliveredResponse(sellerPeerId, 'req-image-order', { costUsdc: imageCost });
    const image = manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-image-order',
      requiredCumulativeAmount: imageCost.toString(),
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: imageCost.toString(),
      inputTokens: '1000',
      freshInputTokens: '1000',
      cachedInputTokens: '0',
      outputTokens: '50',
      billingUsage: { version: 1, units: { output_images: '2' } },
    }, mux);
    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-9', { costUsdc: tokenCost });
    const token = manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-9',
      requiredCumulativeAmount: (imageCost + tokenCost).toString(),
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: tokenCost.toString(),
    }, mux);
    await new Promise((resolve) => setTimeout(resolve, 30));
    manager.recordObservedUnitUsage('req-image-order', { units: { output_images: 2 } });
    await Promise.all([image, token]);

    expect(mux.sentSpendingAuths.map((auth) => (auth as Record<string, unknown>).cumulativeAmount))
      .toEqual([imageCost.toString(), (imageCost + tokenCost).toString()]);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(imageCost + tokenCost);
    const last = mux.sentSpendingAuths.at(-1) as Record<string, string>;
    expect(decodeMetadataTokens(last.metadata).outputImages).toBe(2n);

    // The buyer-initiated authorization for the same response at close adds nothing.
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
      inputBytes: SAMPLE_INPUT,
      outputBytes: SAMPLE_OUTPUT,
      sellerClaimedCost: imageCost,
      reportedInputTokens: 1000n,
      reportedOutputTokens: 50n,
      unitUsage: { units: { output_images: 2 } },
      service: 'gpt-image-2',
      requestId: 'req-image-order',
    });
    expect(BigInt(payload.cumulativeAmount)).toBe(imageCost + tokenCost);
  });

  it('handleNeedAuth resends the signed authorization when a catch-up prompt shows the seller never got it', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-resend');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    await manager.handleNeedAuth(sellerPeerId, { channelId, requiredCumulativeAmount: '50000', currentAcceptedCumulative: '0', deposit: '1000000' }, mux);
    mux.sentSpendingAuths.length = 0;

    // The seller restarted and only accepted 20k: same amount again, never higher.
    await manager.handleNeedAuth(sellerPeerId, { channelId, requiredCumulativeAmount: '50000', currentAcceptedCumulative: '20000', deposit: '1000000' }, mux);
    expect(mux.sentSpendingAuths.map((auth) => (auth as Record<string, unknown>).cumulativeAmount)).toEqual(['50000']);

    // A post-response NeedAuth for an amount already signed is still ignored (its authorization is in flight).
    await manager.handleNeedAuth(sellerPeerId, { channelId, requiredCumulativeAmount: '50000', currentAcceptedCumulative: '20000', deposit: '1000000', lastRequestCost: '0' }, mux);
    expect(mux.sentSpendingAuths).toHaveLength(1);
  });

  it('handleNeedAuth refuses to sign for a request the seller served from a free allowance', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-covered');
    const otherSellerPeerId = fakePeerId('seller-needauth-fallback');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    const otherChannelId = await manager.authorizeSpending(otherSellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;
    // The same charge signs once nothing marks it covered (see the last step),
    // so only the covered-request guard refuses it here.
    const needAuth = (id: string) => ({
      channelId: id,
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
      requestId: 'covered-request',
    });
    manager.markRequestCovered(sellerPeerId, 'covered-request');

    await manager.handleNeedAuth(sellerPeerId, needAuth(channelId), mux);
    expect(mux.sentSpendingAuths).toHaveLength(0);
    expect(manager.isRequestCovered(sellerPeerId, 'covered-request')).toBe(true);

    // A fallback seller serving the same request ID is paid normally.
    await manager.handleNeedAuth(otherSellerPeerId, needAuth(otherChannelId), mux);
    expect(mux.sentSpendingAuths).toHaveLength(1);

    // A paid retry to the same seller releases the covered attempt first.
    manager.releaseRequestCoverage(sellerPeerId, 'covered-request');
    await manager.handleNeedAuth(sellerPeerId, needAuth(channelId), mux);
    expect(mux.sentSpendingAuths).toHaveLength(2);
  });

  it('handleNeedAuth propagates durable persistence failures without transmitting', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-persist-fail');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestService('needauth-persist-fail', 'gpt-test');
    mux.sentSpendingAuths.length = 0;
    const originalCommit = store.commitAuthorization.bind(store);
    Object.assign(store, {
      commitAuthorization: vi.fn()
        .mockRejectedValueOnce(new Error('durable NeedAuth write failed'))
        .mockImplementation(originalCommit),
    });
    const spendEvents: unknown[] = [];
    manager.setSpendListener((event) => spendEvents.push(event));

    const needAuth = {
      channelId,
      requestId: 'needauth-persist-fail',
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '0',
      inputTokens: '12',
      outputTokens: '7',
    };
    await expect(manager.handleNeedAuth(sellerPeerId, needAuth, mux))
      .rejects.toThrow('durable NeedAuth write failed');
    expect(mux.sentSpendingAuths).toHaveLength(0);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(0n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
    expect(store.getChannelMetadata(store.getChannel(channelId)!).cumulativeRequestCount).toBe(0n);
    expect(spendEvents).toHaveLength(0);

    await manager.handleNeedAuth(sellerPeerId, needAuth, mux);
    const metadata = store.getChannelMetadata(store.getChannel(channelId)!);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(50_000n);
    expect(metadata.cumulativeRequestCount).toBe(1n);
    expect(metadata.cumulativeInputTokens).toBe(12n);
    expect(metadata.cumulativeOutputTokens).toBe(7n);
    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect(spendEvents).toHaveLength(1);
  });

  it('adopts an externally persisted pending reserve without a reload', () => {
    const sellerPeerId = fakePeerId('seller-external-reserve');
    const now = Date.now();
    const channel = {
      sessionId: '0x' + 'ab'.repeat(32),
      peerId: sellerPeerId,
      role: CHANNEL_ROLE.BUYER,
      sellerEvmAddr: '0x' + 'bc'.repeat(20),
      buyerEvmAddr: identity.wallet.address,
      nonce: 0,
      authMax: '0',
      deadline: Math.floor(now / 1000) + 3600,
      previousSessionId: '0x' + '00'.repeat(32),
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: '0x1234',
      latestSpendingAuthSig: null,
      latestMetadata: '0x',
      reserveSalt: '0x' + 'cd'.repeat(32),
      initialReserveAmount: '100000',
      reserveMaxAmount: '100000',
      latestReserveAuthSig: '0x1234',
      latestReserveDeadline: Math.floor(now / 1000) + 3600,
      reserveAuthPending: true,
      confirmedReserveAmount: '0',
      createdAt: now,
      updatedAt: now,
    } satisfies StoredChannel;
    store.upsertChannel(channel);

    manager.adoptPersistedAuthorization(channel);

    expect(manager.hasPendingReserveAuth(sellerPeerId)).toBe(true);
    expect(manager.canReplayReserveAuth(sellerPeerId)).toBe(true);
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(0n);
  });

  it('handleNeedAuth does not attribute unsigned headroom to service amount without reported cost', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-headroom');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestService('req-headroom', 'gpt-5');
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-headroom',
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      inputTokens: '1000',
      cachedInputTokens: '200',
      outputTokens: '100',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, string>;
    expect(sent.cumulativeAmount).toBe('50000');

    const services = decodeMetadataServices(sent.metadata);
    expect(services).toEqual([{
      serviceId: id('gpt-5'),
      cumulativeAmount: 0n,
      cumulativeInputTokens: 0n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 0n,
      cumulativeOutputImages: 0n,
    }]);
  });

  it('attributes an image charge after a headroom NeedAuth races ahead of the response', async () => {
    const sellerPeerId = fakePeerId('seller-image-headroom-race');
    const service = 'qwen-image-3-pro';
    const requestId = 'req-image-headroom-race';
    const unitModel = {
      version: 1 as const,
      components: [{ unit: 'output_images' as const, priceUsd: 0.025 }],
    };
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n);
    manager.trackRequestBilling(requestId, {
      context: {
        sellerPeerId,
        provider: 'openai',
        service,
        serviceApiProtocol: 'openai-images',
        attributes: { model: service },
        unitLimits: { output_images: 1 },
      },
      requestFacts: { kind: 'image', image: { model: service, requestedImages: 1 } },
      unitModel,
    });
    mux.sentSpendingAuths.length = 0;
    manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: 25_000n });

    // This only opens payment headroom. It does not report a delivered image
    // and therefore must not consume the request's service attribution.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId,
      requiredCumulativeAmount: '10000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
    }, mux);

    const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
      inputBytes: new Uint8Array(0),
      outputBytes: enc.encode(JSON.stringify({ data: [{ url: 'https://example.test/image.png' }] })),
      sellerClaimedCost: 25_000n,
      reportedInputTokens: 0n,
      reportedCachedInputTokens: 0n,
      reportedOutputTokens: 0n,
      unitUsage: { units: { output_images: 1 } },
      service,
      requestId,
    });

    const services = decodeMetadataServices(payload.metadata);
    expect(services).toEqual([{
      serviceId: id(service),
      cumulativeAmount: 25_000n,
      cumulativeInputTokens: 0n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 1290n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 1n,
    }]);
  });

  it('signs delivered speech characters and adds none for a speech request that failed', async () => {
    const sellerPeerId = fakePeerId('seller-speech-characters');
    const service = 'tts-model';
    const unitModel = { version: 1 as const, components: [{ unit: 'input_characters' as const, priceUsd: 0.000015 }] };
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n);
    const track = (requestId: string) => manager.trackRequestBilling(requestId, {
      context: {
        sellerPeerId,
        provider: 'openai',
        service,
        serviceApiProtocol: 'openai-audio-speech',
        attributes: { model: service },
        unitLimits: { input_characters: 19 },
      },
      requestFacts: { kind: 'speech', speech: { characters: 19 } },
      unitModel,
    });

    track('req-speech-ok');
    manager.recordDeliveredResponse(sellerPeerId, 'req-speech-ok', { costUsdc: 285n });
    const delivered = await manager.signPerRequestAuth(sellerPeerId, {
      inputBytes: new Uint8Array(0),
      outputBytes: new Uint8Array([0xff, 0xfb, 0x90]),
      sellerClaimedCost: 285n,
      reportedInputTokens: 0n,
      reportedCachedInputTokens: 0n,
      reportedOutputTokens: 0n,
      unitUsage: { units: { input_characters: 19 } },
      service,
      requestId: 'req-speech-ok',
    });
    expect(decodeMetadataTokens(delivered.payload.metadata).inputCharacters).toBe(19n);
    expect(decodeSpendingAuthMetadata(delivered.payload.metadata).services[0]).toMatchObject({
      serviceId: id(service),
      cumulativeInputCharacters: 19n,
      cumulativeRequestCount: 1n,
    });

    // Speech billing measures no characters when no audio came back.
    track('req-speech-failed');
    manager.recordDeliveredResponse(sellerPeerId, 'req-speech-failed', { costUsdc: 0n });
    const failed = await manager.signPerRequestAuth(sellerPeerId, {
      inputBytes: new Uint8Array(0),
      outputBytes: enc.encode(JSON.stringify({ error: { message: 'upstream failed' } })),
      sellerClaimedCost: 0n,
      reportedInputTokens: 0n,
      reportedCachedInputTokens: 0n,
      reportedOutputTokens: 0n,
      unitUsage: { units: { input_characters: 0 } },
      service,
      requestId: 'req-speech-failed',
    });
    const after = decodeSpendingAuthMetadata(failed.payload.metadata);
    expect(after.cumulativeInputCharacters).toBe(19n);
    expect(after.services[0]).toMatchObject({ cumulativeInputCharacters: 19n, cumulativeRequestCount: 2n });
  });

  it('handleNeedAuth suppresses per-service metadata when disabled', async () => {
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, {
      disableMetadataV2Services: true,
    }), store);
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-needauth-no-service-meta');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestService('req-sensitive-needauth', 'sensitive-model');
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'req-sensitive-needauth', { costUsdc: 100n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-sensitive-needauth',
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '100',
      inputTokens: '1000',
      cachedInputTokens: '200',
      outputTokens: '50',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, string>;
    const meta = decodeMetadataTokens(sent.metadata);
    expect(meta.inputTokens).toBe(1000n);
    expect(meta.outputTokens).toBe(50n);
    expect(decodeMetadataServices(sent.metadata)).toEqual([]);

    const channel = store.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER);
    expect(channel).not.toBeNull();
    expect(store.getServiceTotals(channel!.sessionId)).toEqual([]);
  });

  it('handleNeedAuth rejects positive token/image cost when image unit billingUsage is omitted', async () => {
    const sellerPeerId = fakePeerId('seller-image-unit');
    const channelId = await manager.authorizeSpending(
      sellerPeerId,
      mux,
      10_000n,
      10_000_000n,
      undefined,
      undefined,
      undefined,
      {
        defaults: { version: 1, components: [] },
        providers: {
          openai: {
            services: {
              'gpt-image-2': {
                'openai-images': {
                  version: 1,
                  components: [
                    { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
                  ],
                },
              },
            },
          },
        },
      },
    );
    manager.trackRequestBilling('req-image-no-usage', {
      context: {
        sellerPeerId,
        provider: 'openai',
        service: 'gpt-image-2',
        serviceApiProtocol: 'openai-images',
        attributes: { model: 'gpt-image-2', size: '1024x1024' },
      },
      requestFacts: { kind: 'image', image: {} },
      unitModel: {
        version: 1,
        components: [
          { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
        ],
      },
    });
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'req-image-no-usage', { costUsdc: 40_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-image-no-usage',
      requiredCumulativeAmount: '40000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '40000',
      inputTokens: '0',
      outputTokens: '0',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
  });

  it('handleNeedAuth rejects image billingUsage whose tier does not match buyer request context', async () => {
    const sellerPeerId = fakePeerId('seller-image-tier');
    const channelId = await manager.authorizeSpending(
      sellerPeerId,
      mux,
      10_000n,
      10_000_000n,
      undefined,
      undefined,
      undefined,
      {
        defaults: { version: 1, components: [] },
        providers: {
          openai: {
            services: {
              'gpt-image-2': {
                'openai-images': {
                  version: 1,
                  components: [
                    { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
                  ],
                },
              },
            },
          },
        },
      },
    );
    manager.trackRequestBilling('req-image-tier-mismatch', {
      context: {
        sellerPeerId,
        provider: 'openai',
        service: 'gpt-image-2',
        serviceApiProtocol: 'openai-images',
        attributes: { model: 'gpt-image-2', size: '256x256' },
      },
      requestFacts: { kind: 'image', image: {} },
      unitModel: {
        version: 1,
        components: [
          { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
        ],
      },
    });
    manager.recordObservedUnitUsage('req-image-tier-mismatch', { units: { output_images: 2 } });
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'req-image-tier-mismatch', { costUsdc: 40_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-image-tier-mismatch',
      requiredCumulativeAmount: '40000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '40000',
      inputTokens: '0',
      outputTokens: '0',
      billingUsage: {
        version: 1,
        units: { output_images: '1' },
      },
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
  });

  it('handleNeedAuth accepts token pricing plus validated image unit surcharge', async () => {
    const sellerPeerId = fakePeerId('seller-image-hybrid');
    const channelId = await manager.authorizeSpending(
      sellerPeerId,
      mux,
      10_000n,
      TEST_PRICING,
    );
    const imageModel = {
      version: 1 as const,
      components: [
        { unit: 'output_images' as const, priceUsd: 0.004, match: { size: '1024x1024' } },
      ],
    };
    manager.trackRequestBilling('req-image-hybrid', {
      context: {
        sellerPeerId,
        provider: 'openai',
        service: 'gpt-image-2',
        serviceApiProtocol: 'openai-images',
        attributes: { model: 'gpt-image-2', size: '1024x1024' },
      },
      requestFacts: { kind: 'image', image: {} },
      tokenPricing: TEST_PRICING,
      unitModel: imageModel,
    });
    manager.recordObservedUnitUsage('req-image-hybrid', { units: { output_images: 2 } });
    mux.sentSpendingAuths.length = 0;

    const tokenCost = 3_750n; // 1000 input at $3/M + 50 output at $15/M
    const imageCost = 8_000n;
    const totalCost = tokenCost + imageCost;
    manager.recordDeliveredResponse(sellerPeerId, 'req-image-hybrid', { costUsdc: totalCost });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-image-hybrid',
      requiredCumulativeAmount: totalCost.toString(),
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: totalCost.toString(),
      inputTokens: '1000',
      freshInputTokens: '1000',
      cachedInputTokens: '0',
      outputTokens: '50',
      billingUsage: {
        version: 1,
        units: { output_images: '2' },
      },
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(totalCost);
    const sent = mux.sentSpendingAuths[0] as Record<string, string>;
    const totals = decodeMetadataTokens(sent.metadata);
    expect(totals.inputTokens).toBe(1000n);
    expect(totals.outputTokens).toBe(50n + 2n * 1290n);
    expect(totals.outputImages).toBe(2n);
  });

  it('handleNeedAuth pays a video exactly its price: no token tolerance above it', async () => {
    const sellerPeerId = fakePeerId('seller-video-exact');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    const unitModel = { version: 1 as const, components: [{ unit: 'video_seconds' as const, priceUsd: 0.1 }] };
    const captured = captureUnitBillingContext({
      sellerPeerId,
      provider: 'venice',
      service: 'wan-2.5',
      serviceApiProtocol: 'venice-video',
      request: {
        requestId: 'req-video-exact',
        method: 'POST',
        path: '/api/v1/video/queue',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'wan-2.5', prompt: 'An ant', duration: '8s' })),
      },
    });
    manager.trackRequestBilling('req-video-exact', {
      context: captured.context,
      requestFacts: captured.requestFacts,
      estimatedCostUsdc: 800_000n,
      unitModel,
    });
    manager.recordObservedUnitUsage('req-video-exact', { units: { video_seconds: 8 } });
    manager.recordDeliveredResponse(sellerPeerId, 'req-video-exact', { costUsdc: 800_000n });
    mux.sentSpendingAuths.length = 0;
    const needAuth = (cost: bigint) => ({
      channelId,
      requestId: 'req-video-exact',
      requiredCumulativeAmount: cost.toString(),
      currentAcceptedCumulative: '0',
      deposit: '5000000',
      lastRequestCost: cost.toString(),
      inputTokens: '0',
      outputTokens: '0',
      billingUsage: { version: 1 as const, units: { video_seconds: '8' } },
    });

    // $1.00 is within the 1.4x tolerance of $0.80, but a video's price is exact.
    await manager.handleNeedAuth(sellerPeerId, needAuth(1_000_000n), mux);
    expect(mux.sentSpendingAuths.length).toBe(0);
    await manager.handleNeedAuth(sellerPeerId, needAuth(800_000n), mux);
    expect(mux.sentSpendingAuths.length).toBe(1);
  });

  it('handleNeedAuth rejects image billingUsage claiming more images than the buyer observed', async () => {
    const sellerPeerId = fakePeerId('seller-image-observed');
    const channelId = await manager.authorizeSpending(
      sellerPeerId,
      mux,
      10_000n,
      TEST_PRICING,
    );
    manager.trackRequestBilling('req-image-observed', {
      context: {
        sellerPeerId,
        provider: 'openai',
        service: 'gpt-image-2',
        serviceApiProtocol: 'openai-images',
        attributes: { model: 'gpt-image-2', size: '1024x1024' },
      },
      requestFacts: { kind: 'image', image: {} },
      unitModel: {
        version: 1,
        components: [
          { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
        ],
      },
    });
    manager.recordObservedUnitUsage('req-image-observed', { units: { output_images: 1 } });
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'req-image-observed', { costUsdc: 80_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-image-observed',
      requiredCumulativeAmount: '80000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '80000',
      inputTokens: '0',
      outputTokens: '0',
      billingUsage: {
        version: 1,
        units: { output_images: '2' },
      },
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
  });

  it('handleNeedAuth keeps a pending request\'s billing context through a catch-up prompt that names it', async () => {
    const sellerPeerId = fakePeerId('seller-catch-up-billing');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    const context = {
      sellerPeerId,
      provider: 'openai',
      service: 'gpt-image-2',
      serviceApiProtocol: 'openai-images' as const,
      attributes: { model: 'gpt-image-2', size: '1024x1024' },
    };
    manager.trackRequestBillingContext('req-image-pending', context);

    // A catch-up for earlier spend arrives while the image request is still being served.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'req-image-pending', requiredCumulativeAmount: '40000', currentAcceptedCumulative: '0', deposit: '1000000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(40_000n);
    expect(manager.getRequestBilling('req-image-pending')?.context).toEqual(context);
  });

  it('handleNeedAuth rejects positive cost for free-default image billing', async () => {
    const sellerPeerId = fakePeerId('seller-image-free');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestBillingContext('req-image-free', {
      sellerPeerId,
      provider: 'openai',
      service: 'gpt-image-2',
      serviceApiProtocol: 'openai-images',
      attributes: { model: 'gpt-image-2', size: '1024x1024' },
    });
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'req-image-free', { costUsdc: 40_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-image-free',
      requiredCumulativeAmount: '40000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '40000',
      inputTokens: '0',
      outputTokens: '0',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
  });

  it('handleNeedAuth refuses a cost claim for a request signPerRequestAuth paid, and counts its service totals once', async () => {
    const sellerPeerId = fakePeerId('seller-service-dedup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestService('req-dedup', 'gpt-5');
    manager.recordDeliveredResponse(sellerPeerId, 'req-dedup', { costUsdc: 100n });

    await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 100n,
        reportedInputTokens: 1000n,
        reportedCachedInputTokens: 200n,
        reportedOutputTokens: 50n,
        service: 'gpt-5',
        requestId: 'req-dedup',
      },
    );

    // The seller charges the same request again: it is already paid, so the claim is refused.
    mux.sentSpendingAuths.length = 0;
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-dedup',
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '100',
      inputTokens: '1000',
      cachedInputTokens: '200',
      outputTokens: '50',
    }, mux);
    expect(mux.sentSpendingAuths.length).toBe(0);

    // The seller then asks for headroom: the auth signed for it counts the request once.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, string>;
    const services = decodeMetadataServices(sent.metadata);
    expect(services).toEqual([{
      serviceId: id('gpt-5'),
      cumulativeAmount: 100n,
      cumulativeInputTokens: 1000n,
      cumulativeCachedInputTokens: 200n,
      cumulativeOutputTokens: 50n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 0n,
    }]);
  });

  it('signPerRequestAuth does not charge again for a request already paid through NeedAuth', async () => {
    const sellerPeerId = fakePeerId('seller-cost-dedup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });

    // The seller's NeedAuth for the chat arrives first and is paid.
    manager.recordDeliveredResponse(sellerPeerId, 'chat-1', { costUsdc: 20_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-1', requiredCumulativeAmount: '20000', currentAcceptedCumulative: '0',
      deposit: '1000000', lastRequestCost: '20000', inputTokens: '1000', outputTokens: '1133',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(20_000n);

    // The post-response auth for the same chat (e.g. flushed before a close) must not add its cost again.
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
      requestId: 'chat-1', inputBytes: new Uint8Array(), outputBytes: new Uint8Array(),
      sellerClaimedCost: 20_000n, reportedInputTokens: 1000n, reportedOutputTokens: 1133n,
    });
    expect(BigInt(payload.cumulativeAmount)).toBe(20_000n);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(20_000n);
  });

  it('signPerRequestAuth signs the remainder of a request NeedAuth capped at the reserve ceiling', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-cost-dedup-capped');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n);
    manager.handleAuthAck(sellerPeerId, { channelId });

    manager.recordDeliveredResponse(sellerPeerId, 'chat-1', { costUsdc: 60_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-1', requiredCumulativeAmount: '60000', currentAcceptedCumulative: '0',
      deposit: '1000000', lastRequestCost: '60000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(60_000n);

    // chat-2 costs 50_000, but NeedAuth can only sign up to the 100_000 ceiling before topping up.
    manager.recordDeliveredResponse(sellerPeerId, 'chat-2', { costUsdc: 50_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-2', requiredCumulativeAmount: '110000', currentAcceptedCumulative: '60000',
      deposit: '1000000', lastRequestCost: '50000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(100_000n);

    // The post-response auth (e.g. flushed before a close) signs the 10_000 NeedAuth left unsigned.
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
      requestId: 'chat-2', inputBytes: new Uint8Array(), outputBytes: new Uint8Array(),
      sellerClaimedCost: 50_000n,
    });
    expect(BigInt(payload.cumulativeAmount)).toBe(110_000n);

    // Once paid in full, a repeat must not charge it again.
    const repeat = await manager.signPerRequestAuth(sellerPeerId, {
      requestId: 'chat-2', inputBytes: new Uint8Array(), outputBytes: new Uint8Array(),
      sellerClaimedCost: 50_000n,
    });
    expect(BigInt(repeat.payload.cumulativeAmount)).toBe(110_000n);
  });

  it('attributes the whole cost of a ceiling-capped worker request to its worker', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    const worker = '0x1000000000000000000000000000000000000001';
    const sellerPeerId = fakePeerId('seller-pool-capped');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n);
    manager.handleAuthAck(sellerPeerId, { channelId });

    manager.recordDeliveredResponse(sellerPeerId, 'chat-1', { costUsdc: 60_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-1', requiredCumulativeAmount: '60000', currentAcceptedCumulative: '0',
      deposit: '1000000', lastRequestCost: '60000',
    }, mux);
    manager.recordWorkerAttribution(sellerPeerId, 'chat-2', worker);
    manager.recordDeliveredResponse(sellerPeerId, 'chat-2', { costUsdc: 50_000n });
    manager.recordWorkerDelivery('chat-2', { inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 400n });
    // 50_000, of which NeedAuth signs 40_000 up to the ceiling.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-2', requiredCumulativeAmount: '110000', currentAcceptedCumulative: '60000',
      deposit: '1000000', lastRequestCost: '50000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(100_000n);
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
      requestId: 'chat-2', inputBytes: new Uint8Array(), outputBytes: new Uint8Array(), sellerClaimedCost: 50_000n,
    });
    expect(BigInt(payload.cumulativeAmount)).toBe(110_000n);
    expect(decodeWorkerTail(payload.metadata)).toEqual([{ worker, cumulativeAmount: 50_000n }]);
  });

  it('keeps a ceiling-capped worker request through cache eviction until its remainder is signed', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    const worker = '0x1000000000000000000000000000000000000001';
    const other = '0x2000000000000000000000000000000000000002';
    const sellerPeerId = fakePeerId('seller-pool-capped-evicted');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n);
    manager.handleAuthAck(sellerPeerId, { channelId });

    manager.recordDeliveredResponse(sellerPeerId, 'chat-1', { costUsdc: 60_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-1', requiredCumulativeAmount: '60000', currentAcceptedCumulative: '0',
      deposit: '1000000', lastRequestCost: '60000',
    }, mux);
    manager.recordWorkerAttribution(sellerPeerId, 'chat-2', worker);
    manager.recordDeliveredResponse(sellerPeerId, 'chat-2', { costUsdc: 50_000n });
    manager.recordWorkerDelivery('chat-2', { inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 400n });
    // 50_000, of which NeedAuth signs 40_000 up to the ceiling.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-2', requiredCumulativeAmount: '110000', currentAcceptedCumulative: '60000',
      deposit: '1000000', lastRequestCost: '50000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(100_000n);

    // Many newer worker requests (more than the delivery cache holds) arrive before the remainder is signed.
    for (let i = 0; i < 600; i++) {
      manager.recordWorkerAttribution(sellerPeerId, `later-${i}`, other);
      manager.recordWorkerDelivery(`later-${i}`, i % 2 === 0 ? { inputTokens: 1n, cachedInputTokens: 0n, outputTokens: 1n } : null);
    }

    // The reserve grows: the 10_000 left is signed and still credited to chat-2's worker.
    const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
      requestId: 'chat-2', inputBytes: new Uint8Array(), outputBytes: new Uint8Array(), sellerClaimedCost: 50_000n,
    });
    expect(BigInt(payload.cumulativeAmount)).toBe(110_000n);
    expect(decodeWorkerTail(payload.metadata)).toEqual([{ worker, cumulativeAmount: 50_000n }]);
  });

  it('lets NeedAuth collect a ceiling-capped worker remainder after cache eviction', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    const worker = '0x1000000000000000000000000000000000000001';
    const other = '0x2000000000000000000000000000000000000002';
    const sellerPeerId = fakePeerId('seller-pool-capped-evicted-needauth');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n);
    manager.handleAuthAck(sellerPeerId, { channelId });

    manager.recordDeliveredResponse(sellerPeerId, 'chat-1', { costUsdc: 60_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-1', requiredCumulativeAmount: '60000', currentAcceptedCumulative: '0',
      deposit: '1000000', lastRequestCost: '60000',
    }, mux);
    manager.recordWorkerAttribution(sellerPeerId, 'chat-2', worker);
    manager.recordDeliveredResponse(sellerPeerId, 'chat-2', { costUsdc: 50_000n });
    manager.recordWorkerDelivery('chat-2', { inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 400n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-2', requiredCumulativeAmount: '110000', currentAcceptedCumulative: '60000',
      deposit: '1000000', lastRequestCost: '50000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(100_000n);

    for (let i = 0; i < 600; i++) {
      manager.recordWorkerAttribution(sellerPeerId, `later-${i}`, other);
      manager.recordWorkerDelivery(`later-${i}`, i % 2 === 0 ? { inputTokens: 1n, cachedInputTokens: 0n, outputTokens: 1n } : null);
    }

    // The seller prompts for the remainder (its cost was counted already): it stays chat-2's worker's.
    for (let attempt = 0; attempt < 2 && manager.getCumulativeAmount(sellerPeerId) < 110_000n; attempt++) {
      await manager.handleNeedAuth(sellerPeerId, {
        channelId, requestId: 'chat-2', requiredCumulativeAmount: '110000', currentAcceptedCumulative: '100000',
        deposit: '1000000',
      }, mux);
    }
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(110_000n);
    const last = mux.sentSpendingAuths.at(-1) as { metadata: string };
    expect(decodeWorkerTail(last.metadata)).toEqual([{ worker, cumulativeAmount: 50_000n }]);
  });

  it('attributes the remainder NeedAuth signs after a capped post-response auth to the worker', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    const worker = '0x1000000000000000000000000000000000000001';
    const sellerPeerId = fakePeerId('seller-pool-capped-buyer-first');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n);
    manager.handleAuthAck(sellerPeerId, { channelId });

    manager.recordDeliveredResponse(sellerPeerId, 'chat-1', { costUsdc: 60_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-1', requiredCumulativeAmount: '60000', currentAcceptedCumulative: '0',
      deposit: '1000000', lastRequestCost: '60000',
    }, mux);
    manager.recordWorkerAttribution(sellerPeerId, 'chat-2', worker);
    manager.recordDeliveredResponse(sellerPeerId, 'chat-2', { costUsdc: 50_000n });
    manager.recordWorkerDelivery('chat-2', { inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 400n });
    const first = await manager.signPerRequestAuth(sellerPeerId, {
      requestId: 'chat-2', inputBytes: new Uint8Array(), outputBytes: new Uint8Array(), sellerClaimedCost: 50_000n,
    });
    expect(BigInt(first.payload.cumulativeAmount)).toBe(100_000n);
    for (let attempt = 0; attempt < 2 && manager.getCumulativeAmount(sellerPeerId) < 110_000n; attempt++) {
      await manager.handleNeedAuth(sellerPeerId, {
        channelId, requestId: 'chat-2', requiredCumulativeAmount: '110000', currentAcceptedCumulative: '100000',
        deposit: '1000000',
      }, mux);
    }
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(110_000n);
    const last = mux.sentSpendingAuths.at(-1) as { metadata: string };
    expect(decodeWorkerTail(last.metadata)).toEqual([{ worker, cumulativeAmount: 50_000n }]);
  });

  it('counts a partly paid worker request\'s cost once however often NeedAuth repeats it', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    const worker = '0x1000000000000000000000000000000000000001';
    const sellerPeerId = fakePeerId('seller-pool-repeated-remainder');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n);
    manager.handleAuthAck(sellerPeerId, { channelId });

    manager.recordDeliveredResponse(sellerPeerId, 'chat-1', { costUsdc: 60_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-1', requiredCumulativeAmount: '60000', currentAcceptedCumulative: '0',
      deposit: '1000000', lastRequestCost: '60000',
    }, mux);
    manager.recordWorkerAttribution(sellerPeerId, 'chat-2', worker);
    manager.recordDeliveredResponse(sellerPeerId, 'chat-2', { costUsdc: 50_000n });
    manager.recordWorkerDelivery('chat-2', { inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 400n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'chat-2', requiredCumulativeAmount: '110000', currentAcceptedCumulative: '60000',
      deposit: '1000000', lastRequestCost: '50000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(100_000n);

    // The seller repeats chat-2's claim, one unit at a time, then asks for far more.
    for (let i = 0; i < 6; i++) {
      const current = manager.getCumulativeAmount(sellerPeerId);
      await manager.handleNeedAuth(sellerPeerId, {
        channelId, requestId: 'chat-2', requiredCumulativeAmount: String(current + 1n), currentAcceptedCumulative: String(current),
        deposit: '1000000', lastRequestCost: '50000',
      }, mux);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = manager.getCumulativeAmount(sellerPeerId);
      await manager.handleNeedAuth(sellerPeerId, {
        channelId, requestId: 'chat-2', requiredCumulativeAmount: '1000000', currentAcceptedCumulative: String(current),
        deposit: '1000000', lastRequestCost: '50000',
      }, mux);
    }
    // Delivered: 60,000 + 50,000. The window past it is maxPerRequestUsdc, never another 50,000 per repeat.
    expect(manager.getCumulativeAmount(sellerPeerId)).toBeLessThanOrEqual(110_000n + 100_000n);
  });

  it('handleNeedAuth caps at reserve ceiling', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-cap');
    // Reserve ceiling = 10_000 (initial suggested amount)
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    // Seller asks for 500_000 → capped at reserve ceiling (10_000).
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    // Should trigger top-up since required > ceiling, then sign
    expect(mux.sentSpendingAuths.length).toBeGreaterThanOrEqual(1);
  });

  it('handleNeedAuth first top-up triggers with 35% of the initial reserve left', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-needauth-threshold-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n);
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-8', { costUsdc: 64_999n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-8',
      requiredCumulativeAmount: '64999',
      currentAcceptedCumulative: '0',
      deposit: '100000',
      lastRequestCost: '64999',
    }, mux);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBeUndefined();

    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-7', { costUsdc: 1n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-7',
      requiredCumulativeAmount: '65000',
      currentAcceptedCumulative: '64999',
      deposit: '100000',
      lastRequestCost: '1',
    }, mux);

    expect(mux.sentSpendingAuths).toHaveLength(3);
    const reserveTopUp = mux.sentSpendingAuths[2] as Record<string, unknown>;
    expect(reserveTopUp.cumulativeAmount).toBe('65000');
    expect(reserveTopUp.reserveMaxAmount).toBe('200000');
  });

  it('handleNeedAuth later top-ups use $0.50 headroom regardless of lifetime ceiling', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n, maxPerRequestUsdc: 1_000_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-needauth-absolute-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n);
    (manager as unknown as { _currentReserveCeiling: Map<string, bigint> })
      ._currentReserveCeiling.set(sellerPeerId, 10_000_000n);
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-6', { costUsdc: 9_499_999n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-6',
      requiredCumulativeAmount: '9499999',
      currentAcceptedCumulative: '0',
      deposit: '10000000',
      lastRequestCost: '9499999',
    }, mux);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBeUndefined();

    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-5', { costUsdc: 1n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-5',
      requiredCumulativeAmount: '9500000',
      currentAcceptedCumulative: '9499999',
      deposit: '10000000',
      lastRequestCost: '1',
    }, mux);

    expect(mux.sentSpendingAuths).toHaveLength(3);
    const reserveTopUp = mux.sentSpendingAuths[2] as Record<string, unknown>;
    expect(reserveTopUp.cumulativeAmount).toBe('9500000');
    expect(reserveTopUp.reserveMaxAmount).toBe('11000000');
  });

  it('handleNeedAuth sends spending auth before reserve top-up when the ceiling blocks the required amount', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-needauth-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n, TEST_PRICING);

    manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '100001',
      currentAcceptedCumulative: '100000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(2);
    const updatedBudget = mux.sentSpendingAuths[0] as Record<string, unknown>;
    const reserveTopUp = mux.sentSpendingAuths[1] as Record<string, unknown>;
    expect(updatedBudget.cumulativeAmount).toBe('100000');
    expect(updatedBudget.reserveMaxAmount).toBeUndefined();
    expect(reserveTopUp.cumulativeAmount).toBe('100000');
    expect(reserveTopUp.reserveMaxAmount).toBe('200000');
  });

  it('handleNeedAuth still sends spending auth first for high-price models that exhaust a small per-request budget', async () => {
    const expensivePricing = { inputUsdPerMillion: 10, outputUsdPerMillion: 100 };

    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n, maxPerRequestUsdc: 500_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();

    const sellerPeerId = fakePeerId('seller-needauth-expensive-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, expensivePricing);

    // Simulate a very expensive first response: verified cost jumps close to the
    // reserve ceiling, and the seller asks for just above that ceiling. The buyer
    // must still sign at the current ceiling first, then top up.
    (manager as unknown as { _verifiedCost: Map<string, bigint> })._verifiedCost.set(sellerPeerId, 950_000n);
    mux.sentSpendingAuths.length = 0;

    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-4', { costUsdc: 950_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-4',
      requiredCumulativeAmount: '1100000',
      currentAcceptedCumulative: '950000',
      deposit: '1000000',
      lastRequestCost: '950000',
      inputTokens: '50000',
      freshInputTokens: '50000',
      outputTokens: '4500',
      cachedInputTokens: '0',
    }, mux);

    expect(mux.sentSpendingAuths).toHaveLength(2);
    const spendingFirst = mux.sentSpendingAuths[0] as Record<string, unknown>;
    const reserveSecond = mux.sentSpendingAuths[1] as Record<string, unknown>;
    expect(spendingFirst.cumulativeAmount).toBe('1000000');
    expect(spendingFirst.reserveMaxAmount).toBeUndefined();
    expect(reserveSecond.cumulativeAmount).toBe('1000000');
    expect(reserveSecond.reserveMaxAmount).toBe('2000000');
  });

  it('keeps expensive concurrent NeedAuth waves monotonic under multiple conversations on one channel', async () => {
    const expensivePricing = { inputUsdPerMillion: 10, outputUsdPerMillion: 100 };

    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n, maxPerRequestUsdc: 500_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();

    const sellerPeerId = fakePeerId('seller-concurrent-expensive-conversations');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, expensivePricing);

    (manager as unknown as { _verifiedCost: Map<string, bigint> })._verifiedCost.set(sellerPeerId, 950_000n);
    mux.sentSpendingAuths.length = 0;

    // One paid request per conversation, each with the same cost frame.
    const payload = (requestId: string) => {
      manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: 950_000n });
      return {
        channelId,
        requestId,
        requiredCumulativeAmount: '1100000',
        currentAcceptedCumulative: '950000',
        deposit: '1000000',
        lastRequestCost: '950000',
        inputTokens: '50000',
        freshInputTokens: '50000',
        outputTokens: '4500',
        cachedInputTokens: '0',
      } as const;
    };

    await Promise.all([
      manager.handleNeedAuth(sellerPeerId, payload('conversation-1'), mux),
      manager.handleNeedAuth(sellerPeerId, payload('conversation-2'), mux),
      manager.handleNeedAuth(sellerPeerId, payload('conversation-3'), mux),
      manager.handleNeedAuth(sellerPeerId, payload('conversation-4'), mux),
      manager.handleNeedAuth(sellerPeerId, payload('conversation-5'), mux),
    ]);

    const cumulatives = mux.sentSpendingAuths
      .map((message) => message as Record<string, unknown>)
      .map((message) => BigInt(message.cumulativeAmount as string));
    const reserveRaises = mux.sentSpendingAuths
      .map((message) => message as Record<string, unknown>)
      .filter((message) => message.reserveMaxAmount != null)
      .map((message) => BigInt(message.reserveMaxAmount as string));

    expect(cumulatives.every((value) => value >= 1_000_000n)).toBe(true);
    expect(reserveRaises.every((value) => value >= 2_000_000n)).toBe(true);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(1_000_000n);
    expect(manager.getReserveCeiling(sellerPeerId)).toBeGreaterThanOrEqual(2_000_000n);
  });

  it('handleNeedAuth allows more after verified cost increases', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-v');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Record response to increase verified cost
    manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    const verified = manager.getVerifiedCost(sellerPeerId);
    const maxSignable = verified + 100_000n;
    mux.sentSpendingAuths.length = 0;

    // Ask for just under maxSignable
    const requested = maxSignable - 1000n;
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: requested.toString(),
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe(requested.toString());
  });

  it('handleNeedAuth ignores stale requests', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-stale');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    // First, advance cumulative by processing a NeedAuth with a higher amount
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
    }, mux);
    expect(mux.sentSpendingAuths.length).toBe(1);
    mux.sentSpendingAuths.length = 0;

    // Stale: required (30000) < current cumulative (50000), which the seller already accepted
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '30000',
      currentAcceptedCumulative: '50000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('handleNeedAuth does not consume request service mapping for stale auths', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-service');
    const channelId = await manager.authorizeSpending(
      sellerPeerId,
      mux,
      10_000n,
      1_000_000n,
      { inputUsdPerMillion: 0.36, outputUsdPerMillion: 1.65, cachedInputUsdPerMillion: 0.07 },
      {
        defaults: { inputUsdPerMillion: 0.36, outputUsdPerMillion: 1.65, cachedInputUsdPerMillion: 0.07 },
        services: {
          'gpt-5.3-codex-spark': { inputUsdPerMillion: 5, outputUsdPerMillion: 30, cachedInputUsdPerMillion: 1 },
        },
      },
    );
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '1000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
    }, mux);
    expect(mux.sentSpendingAuths.length).toBe(1);
    mux.sentSpendingAuths.length = 0;

    manager.trackRequestService('req-service-pricing', 'gpt-5.3-codex-spark');

    manager.recordDeliveredResponse(sellerPeerId, 'req-service-pricing', { costUsdc: 53_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-service-pricing',
      requiredCumulativeAmount: '500',
      currentAcceptedCumulative: '1000',
      deposit: '1000000',
      lastRequestCost: '53000',
      inputTokens: '10000',
      freshInputTokens: '10000',
      outputTokens: '100',
      cachedInputTokens: '0',
    }, mux);
    expect(mux.sentSpendingAuths.length).toBe(0);

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'req-service-pricing',
      requiredCumulativeAmount: '53000',
      currentAcceptedCumulative: '1000',
      deposit: '1000000',
      lastRequestCost: '53000',
      inputTokens: '10000',
      freshInputTokens: '10000',
      outputTokens: '100',
      cachedInputTokens: '0',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe('53000');
  });

  it('handleNeedAuth ignores unknown seller', async () => {
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth('unknown-seller', {
      channelId: '0x' + '00'.repeat(32),
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  // ── Reserve top-up ─────────────────────────────────────────────

  it('extendCurrentSpendingAuth sends spending auth before reserve top-up when extending past the current ceiling', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();

    const sellerPeerId = fakePeerId('seller-extend-topup-order');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });

    (manager as unknown as { _verifiedCost: Map<string, bigint> })._verifiedCost.set(sellerPeerId, 100_000n);
    mux.sentSpendingAuths.length = 0;
    await manager.extendCurrentSpendingAuth(sellerPeerId, 1n, mux, 100_001n);

    expect(mux.sentSpendingAuths).toHaveLength(2);
    const spendingFirst = mux.sentSpendingAuths[0] as Record<string, unknown>;
    const reserveSecond = mux.sentSpendingAuths[1] as Record<string, unknown>;
    expect(spendingFirst.cumulativeAmount).toBe('100000');
    expect(spendingFirst.reserveMaxAmount).toBeUndefined();
    expect(reserveSecond.cumulativeAmount).toBe('100000');
    expect(reserveSecond.reserveMaxAmount).toBe('200000');
  });

  it('extendCurrentSpendingAuth tops up the reserve when a catch-up signs exactly up to the ceiling', async () => {
    // Signing the target fills the reserve: without a top-up the seller's spend
    // then equals its reserve and it closes the channel as exhausted.
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();

    const sellerPeerId = fakePeerId('seller-catch-up-to-ceiling');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, 100_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });
    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-60', { costUsdc: 60_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '60000',
      currentAcceptedCumulative: '0',
      deposit: '100000',
      requestId: 'paid-request-60',
      lastRequestCost: '60000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(60_000n);
    mux.sentSpendingAuths.length = 0;

    await manager.extendCurrentSpendingAuth(sellerPeerId, 50_000n, mux, 100_000n);

    expect(mux.sentSpendingAuths.map((auth) => {
      const { cumulativeAmount, reserveMaxAmount } = auth as Record<string, string | undefined>;
      return { cumulativeAmount, reserveMaxAmount };
    })).toEqual([
      { cumulativeAmount: '100000', reserveMaxAmount: undefined },
      { cumulativeAmount: '100000', reserveMaxAmount: '200000' },
    ]);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(100_000n);
  });

  it('handleNeedAuth signs the confirmed deposit first when a pending top-up would be crossed in one jump', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 250_000n, maxPerRequestUsdc: 150_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-needauth-cross-pending-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n);
    const needAuth = async (requestId: string, cost: bigint, required: bigint, accepted: bigint) => {
      manager.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: cost });
      await manager.handleNeedAuth(sellerPeerId, {
        channelId,
        requestId,
        requiredCumulativeAmount: required.toString(),
        currentAcceptedCumulative: accepted.toString(),
        deposit: '250000',
        lastRequestCost: cost.toString(),
      }, mux);
    };
    await needAuth('r1', 105_327n, 105_327n, 0n);
    // An early top-up (sent below the contract's settle threshold) is pending.
    await manager.topUpReserve(sellerPeerId, mux);
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(500_000n);
    await needAuth('r2', 49_638n, 154_965n, 105_327n);
    mux.sentSpendingAuths.length = 0;

    // The next delivered cost jumps past the confirmed deposit (250000).
    await needAuth('r3', 99_879n, 254_844n, 154_965n);
    const spendOnly = () => mux.sentSpendingAuths
      .map((a) => a as Record<string, unknown>)
      .filter((a) => a.reserveMaxAmount == null)
      .map((a) => a.cumulativeAmount);
    expect(spendOnly()).toEqual(['250000']);

    // The seller's next prompt signs the rest.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '254844',
      currentAcceptedCumulative: '250000',
      deposit: '250000',
    }, mux);
    expect(spendOnly()).toEqual(['250000', '254844']);
  });

  it('topUpReserve sends new ReserveAuth with increased ceiling', async () => {
    const sellerPeerId = fakePeerId('seller-topup-rsv');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    await manager.topUpReserve(sellerPeerId, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.reserveMaxAmount).toBe('20000000');
    expect(sent.reserveSalt).toBeTypeOf('string');
    expect(sent.reserveDeadline).toBeTypeOf('number');
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(20_000_000n);
  });

  it('sizes reserve top-ups and their trigger to the paid requests in flight, within a bound', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n }), store);
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();
    const sellerPeerId = fakePeerId('seller-load-topup');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    const internals = manager as unknown as {
      _metadata: Map<string, { cumulativeRequestCount: bigint }>;
      _verifiedCost: Map<string, bigint>;
      _cumulativeAmount: Map<string, bigint>;
      _needsTopUp(sellerPeerId: string): boolean;
    };
    // Ten requests served at $0.07 each on average.
    internals._metadata.set(sellerPeerId, { ...internals._metadata.get(sellerPeerId)!, cumulativeRequestCount: 10n });
    internals._verifiedCost.set(sellerPeerId, 700_000n);
    internals._cumulativeAmount.set(sellerPeerId, 400_000n);

    // Idle: $0.60 of headroom left is above the fixed trigger, and one step is enough.
    expect(internals._needsTopUp(sellerPeerId)).toBe(false);

    // 32 requests in flight need 32 x $0.07 x 2 = $4.48: top up now, by that much.
    for (let i = 0; i < 32; i += 1) manager.beginPaidRequest(sellerPeerId);
    expect(internals._needsTopUp(sellerPeerId)).toBe(true);
    mux.sentSpendingAuths.length = 0;
    await manager.topUpReserve(sellerPeerId, mux);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBe('5480000');

    // 200 in flight would need $28: capped at ten configured steps.
    for (let i = 0; i < 168; i += 1) manager.beginPaidRequest(sellerPeerId);
    mux.sentSpendingAuths.length = 0;
    await manager.topUpReserve(sellerPeerId, mux);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBe('15480000');

    // Once they finish, top-ups return to one configured step.
    for (let i = 0; i < 200; i += 1) manager.endPaidRequest(sellerPeerId);
    mux.sentSpendingAuths.length = 0;
    await manager.topUpReserve(sellerPeerId, mux);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBe('16480000');
  });

  it('never authorizes stacked top-ups beyond the deposits left after one still pending on-chain', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n }), store);
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();
    const sellerPeerId = fakePeerId('seller-stacked-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });
    vi.spyOn(manager, 'getBalance').mockResolvedValue({ available: 12_000_000n, reserved: 1_000_000n });
    const internals = manager as unknown as {
      _metadata: Map<string, { cumulativeRequestCount: bigint }>;
      _verifiedCost: Map<string, bigint>;
    };
    internals._metadata.set(sellerPeerId, { ...internals._metadata.get(sellerPeerId)!, cumulativeRequestCount: 10n });
    internals._verifiedCost.set(sellerPeerId, 700_000n);
    for (let i = 0; i < 200; i += 1) manager.beginPaidRequest(sellerPeerId);
    const ceilings = (): string[] => mux.sentSpendingAuths.map((auth) => (auth as Record<string, unknown>).reserveMaxAmount as string);
    mux.sentSpendingAuths.length = 0;

    // $28 needed: capped at ten steps. The seller defers it (below the settle threshold).
    await manager.topUpReserve(sellerPeerId, mux);
    // Still short: only the $2 left after the pending $10 can be added.
    await manager.topUpReserve(sellerPeerId, mux);
    expect(ceilings()).toEqual(['11000000', '13000000']);
    // Nothing left: refuse rather than authorize more than the deposits hold.
    await expect(manager.topUpReserve(sellerPeerId, mux)).rejects.toThrow(/Insufficient buyer deposits/);
    expect(ceilings()).toHaveLength(2);
  });

  it('reconciles a top-up that already landed before budgeting the next, so its funds are not counted twice', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n }), store);
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();
    const sellerPeerId = fakePeerId('seller-landed-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });
    let deposit = 1_000_000n;
    manager.setChannelDepositReader(async () => deposit);
    let available = 12_000_000n;
    vi.spyOn(manager, 'getBalance').mockImplementation(async () => ({ available, reserved: 0n }));
    const internals = manager as unknown as {
      _metadata: Map<string, { cumulativeRequestCount: bigint }>;
      _verifiedCost: Map<string, bigint>;
    };
    internals._metadata.set(sellerPeerId, { ...internals._metadata.get(sellerPeerId)!, cumulativeRequestCount: 10n });
    internals._verifiedCost.set(sellerPeerId, 700_000n);
    for (let i = 0; i < 200; i += 1) manager.beginPaidRequest(sellerPeerId);
    mux.sentSpendingAuths.length = 0;

    await manager.topUpReserve(sellerPeerId, mux);
    // The $10 top-up lands: the chain locks it and the available balance drops,
    // but the seller's acknowledgement has not reached the buyer yet.
    deposit = 11_000_000n;
    available = 2_000_000n;
    await manager.topUpReserve(sellerPeerId, mux);

    expect(mux.sentSpendingAuths.map((auth) => (auth as Record<string, unknown>).reserveMaxAmount)).toEqual(['11000000', '13000000']);
    expect(manager.hasPendingReserveAuth(sellerPeerId)).toBe(true);
  });

  it('runs overlapping top-ups one at a time, so a slow deposit read never moves the ceiling backward', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n }), store);
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();
    const sellerPeerId = fakePeerId('seller-overlap-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });
    vi.spyOn(manager, 'getBalance').mockResolvedValue({ available: 50_000_000n, reserved: 0n });
    const internals = manager as unknown as {
      _metadata: Map<string, { cumulativeRequestCount: bigint }>;
      _verifiedCost: Map<string, bigint>;
    };
    internals._metadata.set(sellerPeerId, { ...internals._metadata.get(sellerPeerId)!, cumulativeRequestCount: 10n });
    internals._verifiedCost.set(sellerPeerId, 700_000n);
    for (let i = 0; i < 200; i += 1) manager.beginPaidRequest(sellerPeerId);
    await manager.topUpReserve(sellerPeerId, mux); // $11, pending on-chain

    // It lands; the next two top-ups both start before the first deposit read answers.
    let releaseFirstRead!: () => void;
    let reads = 0;
    manager.setChannelDepositReader(() => {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { releaseFirstRead = () => resolve(11_000_000n); });
      return Promise.resolve(11_000_000n);
    });
    mux.sentSpendingAuths.length = 0;
    const first = manager.topUpReserve(sellerPeerId, mux);
    const second = manager.topUpReserve(sellerPeerId, mux);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The load drains while the slow read is outstanding.
    for (let i = 0; i < 200; i += 1) manager.endPaidRequest(sellerPeerId);
    releaseFirstRead();
    await Promise.all([first, second]);

    const ceilings = mux.sentSpendingAuths.map((auth) => BigInt((auth as Record<string, unknown>).reserveMaxAmount as string));
    expect(ceilings.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < ceilings.length; i += 1) expect(ceilings[i]! > ceilings[i - 1]!).toBe(true);
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(ceilings.at(-1));
  });

  function loadedManager(label: string, available: () => bigint) {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, { maxReserveAmountUsdc: 1_000_000n }), store);
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();
    const sellerPeerId = fakePeerId(label);
    vi.spyOn(manager, 'getBalance').mockImplementation(async () => ({ available: available(), reserved: 0n }));
    return { sellerPeerId };
  }

  it('drops top-ups queued behind one that already restored the headroom', async () => {
    const { sellerPeerId } = loadedManager('seller-queued-topups', () => 50_000_000n);
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });
    const internals = manager as unknown as {
      _metadata: Map<string, { cumulativeRequestCount: bigint }>;
      _verifiedCost: Map<string, bigint>;
      _cumulativeAmount: Map<string, bigint>;
    };
    internals._metadata.set(sellerPeerId, { ...internals._metadata.get(sellerPeerId)!, cumulativeRequestCount: 10n });
    internals._verifiedCost.set(sellerPeerId, 700_000n);
    internals._cumulativeAmount.set(sellerPeerId, 900_000n);
    for (let i = 0; i < 32; i += 1) manager.beginPaidRequest(sellerPeerId);
    mux.sentSpendingAuths.length = 0;

    // Three signing steps each see the low ceiling and ask for a top-up at once.
    await Promise.all([1, 2, 3].map(() => manager.topUpReserve(sellerPeerId, mux)));

    // The first adds $4.48 for the 32 in flight; the others find enough headroom.
    expect(mux.sentSpendingAuths.map((auth) => (auth as Record<string, unknown>).reserveMaxAmount)).toEqual(['5480000']);
  });

  it('reads both the deposit and the balance again when a pending top-up lands between them', async () => {
    let available = 12_000_000n;
    const { sellerPeerId } = loadedManager('seller-snapshot-topup', () => available);
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId });
    const internals = manager as unknown as {
      _metadata: Map<string, { cumulativeRequestCount: bigint }>;
      _verifiedCost: Map<string, bigint>;
    };
    internals._metadata.set(sellerPeerId, { ...internals._metadata.get(sellerPeerId)!, cumulativeRequestCount: 10n });
    internals._verifiedCost.set(sellerPeerId, 700_000n);
    for (let i = 0; i < 200; i += 1) manager.beginPaidRequest(sellerPeerId);
    await manager.topUpReserve(sellerPeerId, mux); // $10 more, pending on-chain
    mux.sentSpendingAuths.length = 0;

    // The deposit read still sees $1; the $10 then lands before the balance read.
    let deposit = 1_000_000n;
    manager.setChannelDepositReader(async () => {
      const seen = deposit;
      deposit = 11_000_000n;
      available = 2_000_000n;
      return seen;
    });
    await manager.topUpReserve(sellerPeerId, mux);

    expect(mux.sentSpendingAuths.map((auth) => (auth as Record<string, unknown>).reserveMaxAmount)).toEqual(['13000000']);
  });

  it('resendReserveAuth replays the original reserve amount after top-up', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());
    mux = createMockPaymentMux();

    const sellerPeerId = fakePeerId('seller-replay-rsv');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, 50_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    await manager.topUpReserve(sellerPeerId, mux);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBe('150000');
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(150_000n);

    mux.sentSpendingAuths.length = 0;
    await manager.resendReserveAuth(sellerPeerId, mux);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    const replay = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(replay.reserveMaxAmount).toBe('50000');
    // Replaying the original reserve is used when the channel was not found
    // on-chain, so the unconfirmed top-up ceiling must not survive the replay.
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(50_000n);
  });

  it('resendReserveAuth hashes the exact non-zero metadata it transmits', async () => {
    const sellerPeerId = fakePeerId('seller-replay-meta');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestService('replay-meta-request', 'gpt-5');
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'replay-meta-request',
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '0',
      inputTokens: '10',
      outputTokens: '4',
    }, mux);
    mux.sentSpendingAuths.length = 0;

    await manager.resendReserveAuth(sellerPeerId, mux);

    const replay = mux.sentSpendingAuths[0] as Record<string, string>;
    expect(decodeMetadataTokens(replay.metadata)).toMatchObject({ inputTokens: 10n, outputTokens: 4n });
    expect(replay.metadataHash).toBe(keccak256(replay.metadata));
  });

  it('persists a cooperative-close authorization before returning it', async () => {
    const sellerPeerId = fakePeerId('seller-close-persist');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
    }, mux);
    const commitAuthorization = vi.fn().mockRejectedValue(new Error('close authorization write failed'));
    Object.assign(store, { commitAuthorization });

    await expect(manager.buildCloseChannelRequest(sellerPeerId))
      .rejects.toThrow('close authorization write failed');
    expect(commitAuthorization).toHaveBeenCalledOnce();
  });

  // parseResponseCost tests removed — method removed (cost flows through NeedAuth now)

  // ── Session persistence ────────────────────────────────────────

  it('session survives store reconstruction', async () => {
    const sellerPeerId = fakePeerId('seller-peer-persist');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    store.close();

    const checkStore = new ChannelStore(tempDir);
    const session = checkStore.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.peerId).toBe(sellerPeerId);
    expect(session!.role).toBe('buyer');
    expect(session!.authMax).toBe('0');
    checkStore.close();

    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(Wallet.createRandom());

    const mux2 = createMockPaymentMux();
    const secondId = await manager.authorizeSpending(sellerPeerId, mux2, 10_000n, TEST_PRICING);
    expect(secondId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(secondId).not.toBe(channelId);
  });

  // ── recordAndPersistTokens ────────────────────────────────────

  it('recordAndPersistTokens accumulates tokens and persists to channel store', async () => {
    const sellerPeerId = fakePeerId('seller-record-tok');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    manager.recordAndPersistTokens(sellerPeerId, 1000, 200);
    manager.recordAndPersistTokens(sellerPeerId, 500, 150);

    // In-memory totals
    const totals = manager.getResponseTokenTotals(sellerPeerId);
    expect(totals.input).toBe(1500);
    expect(totals.output).toBe(350);
    expect(totals.requests).toBe(2);

    // Persisted in channel store
    const channel = store.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER);
    expect(channel).not.toBeNull();
    expect(channel!.tokensDelivered).toBe('1500');
    expect(channel!.previousConsumption).toBe('350');
    expect(channel!.requestCount).toBe(2);
  });

  it('recordAndPersistTokens no-ops when no active session', () => {
    const sellerPeerId = fakePeerId('seller-no-session');
    manager.recordAndPersistTokens(sellerPeerId, 1000, 200);
    expect(manager.getResponseTokenTotals(sellerPeerId)).toBeNull();
  });

  it('getResponseTokenTotals returns null for unknown peer', () => {
    const totals = manager.getResponseTokenTotals(fakePeerId('unknown'));
    expect(totals).toBeNull();
  });

  it('recordAndPersistTokens survives store reopen', async () => {
    const sellerPeerId = fakePeerId('seller-persist');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    manager.recordAndPersistTokens(sellerPeerId, 2000, 800);
    store.close();

    // Reopen store and verify persisted data
    const store2 = new ChannelStore(tempDir);
    const channel = store2.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER);
    expect(channel).not.toBeNull();
    expect(channel!.tokensDelivered).toBe('2000');
    expect(channel!.previousConsumption).toBe('800');
    expect(channel!.requestCount).toBe(1);
    store2.close();

    // Re-assign store so afterEach cleanup doesn't double-close
    store = new ChannelStore(tempDir);
  });

  it('resendCurrentSpendingAuth stays at zero after restart for reserve-only sessions', async () => {
    const sellerPeerId = fakePeerId('seller-reserve-only');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    store.close();

    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(identity.wallet);
    mux = createMockPaymentMux();

    const resentChannelId = await manager.resendCurrentSpendingAuth(sellerPeerId, mux);

    expect(resentChannelId).toBe(channelId);
    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).cumulativeAmount).toBe('0');
  });

  it('re-signs a channel whose persisted service list outgrew the payment frame', async () => {
    const sellerPeerId = fakePeerId('seller-oversized-metadata');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    // A channel persisted before the service cap: ~110 services made each
    // SpendingAuth larger than the 64 KiB payment frame.
    store.replaceMetadataServiceTotals(channelId, Array.from({ length: 110 }, (_, i) => ({
      serviceId: getServiceMetadataId(`legacy-model-${i}`),
      cumulativeAmount: BigInt(1_000 + i),
      cumulativeInputTokens: 10n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 20n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 1n,
      cumulativeVideoGenerations: 0n,
      cumulativeVideoSeconds: 0n,
    })));
    store.close();

    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(identity.wallet);
    mux = createMockPaymentMux();

    expect(await manager.resendCurrentSpendingAuth(sellerPeerId, mux)).toBe(channelId);
    const resent = mux.sentSpendingAuths[0] as SpendingAuthPayload;
    // What the seller's codec does with the frame: it must decode, and the
    // signed hash must match the folded metadata it carries.
    const received = decodeSpendingAuth(encodeSpendingAuth(resent));
    expect(keccak256(received.metadata)).toBe(received.metadataHash);
    const services = decodeMetadataServices(received.metadata);
    expect(services).toHaveLength(MAX_METADATA_SERVICES);
    expect(services.reduce((sum, s) => sum + s.cumulativeRequestCount, 0n)).toBe(110n);
    // The folded list is persisted, so the next restart signs the same metadata.
    expect(store.getMetadataServiceTotals(channelId)).toHaveLength(MAX_METADATA_SERVICES);
  });

  it('caps a close authorization at the given deposit without persisting it', async () => {
    const sellerPeerId = fakePeerId('seller-close-cap');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId: (mux.sentSpendingAuths[0] as Record<string, string>).channelId! });
    await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    const signed = manager.getCumulativeAmount(sellerPeerId);
    const persistedSig = store.getChannel(channelId)!.latestSpendingAuthSig;

    const capped = await manager.buildCloseChannelRequest(sellerPeerId, { maxCumulative: signed - 1n });
    expect(capped.cumulativeAmount).toBe((signed - 1n).toString());
    expect(store.getChannel(channelId)!.latestSpendingAuthSig).toBe(persistedSig);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(signed);

    const uncapped = await manager.buildCloseChannelRequest(sellerPeerId, { maxCumulative: signed + 1n });
    expect(uncapped.cumulativeAmount).toBe(signed.toString());
  });

  it('extendCurrentSpendingAuth raises cumulative for an exhausted active session without changing metadata', async () => {
    const sellerPeerId = fakePeerId('seller-extend-current');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId: (mux.sentSpendingAuths[0] as Record<string, string>).channelId! });

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );

    mux.sentSpendingAuths.length = 0;
    const previousMetadata = payload.metadata;
    const previousCumulative = BigInt(payload.cumulativeAmount);

    await manager.extendCurrentSpendingAuth(sellerPeerId, 50_000n, mux);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    const extended = mux.sentSpendingAuths[0] as Record<string, string>;
    expect(BigInt(extended.cumulativeAmount)).toBeGreaterThan(previousCumulative);
    expect(extended.metadata).toBe(previousMetadata);

    const channel = store.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER);
    expect(channel).not.toBeNull();
    expect(channel!.authMax).toBe(extended.cumulativeAmount);
  });

  it('extendCurrentSpendingAuth reports the newly signed amount as spend', async () => {
    const sellerPeerId = fakePeerId('seller-extend-spend');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, { channelId: (mux.sentSpendingAuths[0] as Record<string, string>).channelId! });
    const before = manager.getCumulativeAmount(sellerPeerId);
    const spendEvents: BuyerSpendEvent[] = [];
    manager.setSpendListener((event) => spendEvents.push(event));

    await manager.extendCurrentSpendingAuth(sellerPeerId, 50_000n, mux, undefined, 'req-extend');

    expect(spendEvents).toHaveLength(1);
    expect(spendEvents[0]).toMatchObject({ sellerPeerId, requestId: 'req-extend', outputTokens: '0' });
    expect(BigInt(spendEvents[0]!.amountUsdc)).toBe(manager.getCumulativeAmount(sellerPeerId) - before);
  });

  it('extendCurrentSpendingAuth advances verifiedCost to unblock a collapsed overdraft window', async () => {
    const sellerPeerId = fakePeerId('seller-extend-stalled');
    const stalledConfig = makeConfig(tempDir, {
      maxPerRequestUsdc: 10_000n,
      maxReserveAmountUsdc: 100_000n,
    });

    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, stalledConfig, store);
    manager.setSigner(identity.wallet);
    mux = createMockPaymentMux();

    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, 100_000n, TEST_PRICING);
    const channelId = (mux.sentSpendingAuths[0] as Record<string, string>).channelId!;
    manager.handleAuthAck(sellerPeerId, { channelId });

    // Drive cumulative up to the overdraft cap (verified=0 + maxPerRequest=10_000) without
    // advancing verifiedCost — mirrors the real deadlock where NeedAuth arrived without a
    // cost claim.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '10000',
      currentAcceptedCumulative: '0',
      deposit: '10000',
    }, mux);

    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(10_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);

    mux.sentSpendingAuths.length = 0;

    const returnedChannelId = await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux);

    // verifiedCost advances to currentCumulative (10_000), unblocking the overdraft window so
    // maxSignable becomes verified (10_000) + maxPerRequest (10_000) = 20_000, still under the
    // 100_000 reserve ceiling. The new SpendingAuth is signed at 20_000.
    expect(returnedChannelId).toBe(channelId);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(10_000n);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(20_000n);
    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect((mux.sentSpendingAuths[0] as Record<string, string>).cumulativeAmount).toBe('20000');
  });

  it('credits a worker whose answer a 402 catch-up pays, and refuses its NeedAuth after', async () => {
    const sellerPeerId = fakePeerId('seller-pool-extend');
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, { maxPerRequestUsdc: 10_000n, maxReserveAmountUsdc: 100_000n }), store);
    manager.setSigner(identity.wallet);
    mux = createMockPaymentMux();
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, 100_000n, TEST_PRICING);
    const channelId = (mux.sentSpendingAuths[0] as Record<string, string>).channelId!;
    manager.handleAuthAck(sellerPeerId, { channelId });
    // The prepaid window is used up before the worker's answer is counted.
    await manager.handleNeedAuth(sellerPeerId, { channelId, requiredCumulativeAmount: '10000', currentAcceptedCumulative: '0', deposit: '10000' }, mux);
    const worker = '0x1000000000000000000000000000000000000001';
    manager.recordWorkerAttribution(sellerPeerId, 'req-pool-402', worker);
    manager.recordDeliveredResponse(sellerPeerId, 'req-pool-402', { costUsdc: 5_000n });
    manager.recordWorkerDelivery('req-pool-402', { inputTokens: 1000n, cachedInputTokens: 0n, outputTokens: 100n });
    mux.sentSpendingAuths.length = 0;

    // The seller's 402 asks for everything it served: the reopen pays the recorded answer.
    await manager.extendCurrentSpendingAuth(sellerPeerId, 1n, mux, 15_000n);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(15_000n);
    const sent = mux.sentSpendingAuths[0] as { metadata: string };
    // Credited at what the worker authenticated (1000 in + 100 out = 4500), not the 5000 recorded.
    expect(decodeWorkerTail(sent.metadata)).toEqual([{ worker, cumulativeAmount: 4_500n }]);
    // Paid by the catch-up: a claim for it now is refused.
    await manager.handleNeedAuth(sellerPeerId, {
      channelId, requestId: 'req-pool-402', requiredCumulativeAmount: '20000', currentAcceptedCumulative: '15000',
      deposit: '1000000', inputTokens: '1000', outputTokens: '100', lastRequestCost: '5000',
    }, mux);
    expect(mux.sentSpendingAuths).toHaveLength(1);
  });

  it('extendCurrentSpendingAuth catches up to an explicit target in a single step within overdraft window', async () => {
    const sellerPeerId = fakePeerId('seller-catchup-target');
    // CLI default-shaped config: the legitimate Open Forge race (56_218 signed,
    // seller spent 85_119) is 28_901 behind — well within the 300_000-USDC
    // CLI-default overdraft window, so we expect a one-hop catch-up.
    const catchupConfig = makeConfig(tempDir, {
      maxPerRequestUsdc: 300_000n,
      maxReserveAmountUsdc: 1_000_000n,
    });
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, catchupConfig, store);
    manager.setSigner(identity.wallet);
    mux = createMockPaymentMux();

    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, 1_000_000n, TEST_PRICING);
    const channelId = (mux.sentSpendingAuths[0] as Record<string, string>).channelId!;
    manager.handleAuthAck(sellerPeerId, { channelId });

    // Simulate a session that has already signed cumulative=56_218 via a
    // tolerance-checked NeedAuth (so verifiedCost tracks that amount).
    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-3', { costUsdc: 56_218n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-3',
      requiredCumulativeAmount: '56218',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '56218',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(56_218n);

    mux.sentSpendingAuths.length = 0;

    // Without a target, the advance would only reach 56_218 + 10_000 = 66_218,
    // which the seller would still reject as underfunded (spent=85_119). With
    // the target passed through, the buyer jumps straight to the target in
    // one hop because 85_119 < verifiedCost + maxPerRequestUsdc.
    await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, 85_119n);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    const extended = mux.sentSpendingAuths[0] as Record<string, string>;
    expect(BigInt(extended.cumulativeAmount)).toBe(85_119n);
  });

  it('extendCurrentSpendingAuth caps a malicious target at verifiedCost + maxPerRequestUsdc', async () => {
    // Adversarial model: a rogue seller sends a 402 with an inflated
    // requiredCumulativeAmount (claiming fictitious spend) in an attempt
    // to drain the entire reserve in a single signature. The buyer must
    // NOT let that target feed verifiedCost — the cap is the per-request
    // overdraft window beyond what was already signed.
    const sellerPeerId = fakePeerId('seller-malicious-target');
    const tightConfig = makeConfig(tempDir, {
      maxPerRequestUsdc: 10_000n,
      maxReserveAmountUsdc: 1_000_000n,
    });
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, tightConfig, store);
    manager.setSigner(identity.wallet);
    mux = createMockPaymentMux();

    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, 1_000_000n, TEST_PRICING);
    const channelId = (mux.sentSpendingAuths[0] as Record<string, string>).channelId!;
    manager.handleAuthAck(sellerPeerId, { channelId });

    // Legitimate progress via NeedAuth: verifiedCost tracks this.
    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-2', { costUsdc: 5_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-2',
      requiredCumulativeAmount: '5000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '5000',
    }, mux);
    expect(manager.getCumulativeAmount(sellerPeerId)).toBe(5_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(5_000n);

    mux.sentSpendingAuths.length = 0;

    // Seller claims via 402 body that it spent the entire 1_000_000 reserve.
    // If the buyer trusted this, it would sign cumulative=1_000_000 and lose
    // the whole channel reservation to an unvalidated claim.
    await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, 1_000_000n);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    const extended = mux.sentSpendingAuths[0] as Record<string, string>;
    // Cap: verifiedCost (5_000) + maxPerRequestUsdc (10_000) = 15_000.
    // The malicious 1_000_000 target is ignored beyond that bound.
    expect(BigInt(extended.cumulativeAmount)).toBe(15_000n);
    // And crucially: verifiedCost must NOT have been contaminated by the
    // seller-supplied target — it only advances to the already-signed amount
    // to reopen the overdraft window.
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(5_000n);
  });

  it('extendCurrentSpendingAuth allows one per-request window per in-flight request for a catch-up', async () => {
    // Several parallel requests to one seller can leave its spend more than
    // one per-request window ahead of what the buyer signed.
    const sellerPeerId = fakePeerId('seller-parallel-catch-up');
    const tightConfig = makeConfig(tempDir, {
      maxPerRequestUsdc: 10_000n,
      maxReserveAmountUsdc: 1_000_000n,
    });
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, tightConfig, store);
    manager.setSigner(identity.wallet);
    mux = createMockPaymentMux();

    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, 1_000_000n, TEST_PRICING);
    const channelId = (mux.sentSpendingAuths[0] as Record<string, string>).channelId!;
    manager.handleAuthAck(sellerPeerId, { channelId });
    manager.recordDeliveredResponse(sellerPeerId, 'paid-request-1', { costUsdc: 5_000n });
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requestId: 'paid-request-1',
      requiredCumulativeAmount: '5000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
      lastRequestCost: '5000',
    }, mux);
    mux.sentSpendingAuths.length = 0;

    // Three requests in flight: the signable window grows to 3 × 10_000, and
    // an inflated target is still capped at verifiedCost + 3 × maxPerRequestUsdc.
    await manager.extendCurrentSpendingAuth(sellerPeerId, 10_000n, mux, 1_000_000n, undefined, 3);
    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect(BigInt((mux.sentSpendingAuths[0] as Record<string, string>).cumulativeAmount)).toBe(35_000n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(5_000n);
  });

  it('recordAndPersistTokens continues from persisted totals after restart', async () => {
    const sellerPeerId = fakePeerId('seller-record-restart');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    manager.recordAndPersistTokens(sellerPeerId, 1000, 200);
    store.close();

    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(identity.wallet);

    manager.recordAndPersistTokens(sellerPeerId, 500, 150);

    const totals = manager.getResponseTokenTotals(sellerPeerId);
    expect(totals).toEqual({
      input: 1500,
      output: 350,
      requests: 2,
    });

    const channel = store.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER);
    expect(channel).not.toBeNull();
    expect(channel!.tokensDelivered).toBe('1500');
    expect(channel!.previousConsumption).toBe('350');
    expect(channel!.requestCount).toBe(2);
  });
});
