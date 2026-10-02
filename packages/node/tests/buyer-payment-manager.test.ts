import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { AbiCoder, id, keccak256, Wallet } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { estimateCostFromBytes } from '../src/payments/pricing.js';

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

function decodeMetadataTokens(metadata: string): { inputTokens: bigint; outputTokens: bigint; outputImages: bigint } {
  const coder = AbiCoder.defaultAbiCoder();
  const [, inputTokens, outputTokens, , outputImages] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256'], metadata);
  return { inputTokens, outputTokens, outputImages };
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
  const coder = AbiCoder.defaultAbiCoder();
  const [, , , , , services] = coder.decode([
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeOutputImages)[]',
  ], metadata);
  return [...services].map((service) => ({
    serviceId: service.serviceId as string,
    cumulativeAmount: service.cumulativeAmount as bigint,
    cumulativeInputTokens: service.cumulativeInputTokens as bigint,
    cumulativeCachedInputTokens: service.cumulativeCachedInputTokens as bigint,
    cumulativeOutputTokens: service.cumulativeOutputTokens as bigint,
    cumulativeRequestCount: service.cumulativeRequestCount as bigint,
    cumulativeOutputImages: service.cumulativeOutputImages as bigint,
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
    // v3 zero metadata: five head words + empty services array (offset + length) = 7 words.
    expect((sent.metadata as string).length).toBe(2 + 7 * 64);
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
      requestFacts: { model: service, requestedImages: 1 },
      unitModel,
    });
    mux.sentSpendingAuths.length = 0;

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

  it('handleNeedAuth suppresses per-service metadata when disabled', async () => {
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir, {
      disableMetadataV2Services: true,
    }), store);
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-needauth-no-service-meta');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestService('req-sensitive-needauth', 'sensitive-model');
    mux.sentSpendingAuths.length = 0;

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
      requestFacts: {},
      unitModel: {
        version: 1,
        components: [
          { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
        ],
      },
    });
    mux.sentSpendingAuths.length = 0;

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
      requestFacts: {},
      unitModel: {
        version: 1,
        components: [
          { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
        ],
      },
    });
    manager.recordObservedUnitUsage('req-image-tier-mismatch', { units: { output_images: 2 } });
    mux.sentSpendingAuths.length = 0;

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
      requestFacts: {},
      tokenPricing: TEST_PRICING,
      unitModel: imageModel,
    });
    manager.recordObservedUnitUsage('req-image-hybrid', { units: { output_images: 2 } });
    mux.sentSpendingAuths.length = 0;

    const tokenCost = 3_750n; // 1000 input at $3/M + 50 output at $15/M
    const imageCost = 8_000n;
    const totalCost = tokenCost + imageCost;
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
      requestFacts: {},
      unitModel: {
        version: 1,
        components: [
          { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
        ],
      },
    });
    manager.recordObservedUnitUsage('req-image-observed', { units: { output_images: 1 } });
    mux.sentSpendingAuths.length = 0;

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

  it('handleNeedAuth does not double-count service totals for a request already counted by signPerRequestAuth', async () => {
    const sellerPeerId = fakePeerId('seller-service-dedup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.trackRequestService('req-dedup', 'gpt-5');

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

    // Seller demands more headroom for the same request — must not re-count it.
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

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '64999',
      currentAcceptedCumulative: '0',
      deposit: '100000',
      lastRequestCost: '64999',
    }, mux);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBeUndefined();

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
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

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '9499999',
      currentAcceptedCumulative: '0',
      deposit: '10000000',
      lastRequestCost: '9499999',
    }, mux);

    expect(mux.sentSpendingAuths).toHaveLength(1);
    expect((mux.sentSpendingAuths[0] as Record<string, unknown>).reserveMaxAmount).toBeUndefined();

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
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

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
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

    const payload = {
      channelId,
      requiredCumulativeAmount: '1100000',
      currentAcceptedCumulative: '950000',
      deposit: '1000000',
      lastRequestCost: '950000',
      inputTokens: '50000',
      freshInputTokens: '50000',
      outputTokens: '4500',
      cachedInputTokens: '0',
    } as const;

    await Promise.all([
      manager.handleNeedAuth(sellerPeerId, payload, mux),
      manager.handleNeedAuth(sellerPeerId, payload, mux),
      manager.handleNeedAuth(sellerPeerId, payload, mux),
      manager.handleNeedAuth(sellerPeerId, payload, mux),
      manager.handleNeedAuth(sellerPeerId, payload, mux),
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

    // Stale: required (30000) < current cumulative (50000)
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '30000',
      currentAcceptedCumulative: '10000',
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
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
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
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
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
