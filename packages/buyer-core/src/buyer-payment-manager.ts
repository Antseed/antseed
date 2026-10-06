import { hexlify, randomBytes } from 'ethers';
import { type AbstractSigner } from 'ethers';
import type { BuyerIdentity } from './interfaces.js';
import type { PaymentMux } from './payment-mux.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  NeedAuthPayload,
  CloseChannelRequestPayload,
} from '@antseed/protocol/messages';
import { DepositsClient } from './deposits-client.js';
import {
  signSpendingAuth,
  signReserveAuth,
  makeChannelsDomain,
  computeMetadataHash,
  encodeMetadata,
  OUTPUT_IMAGE_TOKEN_EQUIVALENT,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
  computeChannelId,
} from '@antseed/protocol/signatures';
import type { SpendingAuthMessage, ReserveAuthMessage, SpendingAuthMetadata } from '@antseed/protocol/signatures';
import { debugLog, debugWarn } from './debug.js';
import { peerIdToAddress, type PeerId } from '@antseed/protocol/peer-id';
import type { SellerAddressResolver } from './seller-address-resolver.js';
import type { PeerMetadata } from '@antseed/protocol/peer-metadata';
import { BuyerChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from './channel-store-types.js';
import {
  advanceUsageMetadata,
  CountedRequestTracker,
  normalizeRequestUsageDelta,
  RequestServiceTracker,
} from './channel-usage-accounting.js';
import {
  estimateCostFromBytes,
  computeCostUsdc,
  type ServicePricing,
} from './pricing.js';
import type { UnitBillingContext, UnitBillingModelV1, UnitBillingUsage } from '@antseed/protocol/billing';
import type { ImageRequestFacts } from '@antseed/api-adapter';
import { evaluateUnitBilling, unitUsageFromReport, validateUnitBillingUsage } from '@antseed/protocol/billing';
import { buyerFault, faultCodeOf } from './errors.js';

/** Default tolerance: accept seller claims up to 1.4x buyer's estimate. */
const DEFAULT_COST_TOLERANCE = 1.4;
/** Remaining headroom that triggers the first top-up (35% of the initial reserve). */
const INITIAL_TOPUP_HEADROOM_PERCENT = 35n;
/** Fixed remaining headroom that triggers every later top-up ($0.50). */
const SUBSEQUENT_TOPUP_HEADROOM_USDC = 500_000n;
const PERCENT_DENOMINATOR = 100n;
const REQUEST_BILLING_TTL_MS = 5 * 60_000;
const MAX_REQUEST_BILLING_ENTRIES = 512;
/** How long NeedAuth validation waits for the buyer's own response processing
 *  to record delivered unit usage before rejecting a positive claim. */
const OBSERVED_UNIT_USAGE_WAIT_MS = 5_000;

function countOutputImages(usage: UnitBillingUsage | undefined): bigint {
  return BigInt(Math.max(0, Math.floor(usage?.units.output_images ?? 0)));
}

function validateUnitNormalizedCost(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  usage: UnitBillingUsage,
): bigint {
  return evaluateUnitBilling(model, context, usage);
}

export interface BuyerPaymentConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  depositsContractAddress: string;
  channelsContractAddress: string;
  usdcAddress: string;
  identityRegistryAddress: string;
  chainId: number;
  defaultAuthDurationSecs: number;
  /**
   * Max unverified exposure (overdraft limit) in USDC base units.
   * The buyer will never sign more than verifiedCost + maxPerRequestUsdc.
   * Default: 500000 ($0.50).
   */
  maxPerRequestUsdc: bigint;
  /** Max USDC to reserve per ReserveAuth signature (base units). Default: 1000000 ($1.00). */
  maxReserveAmountUsdc: bigint;
  /** Max ratio of seller-claimed cost to buyer's bytes/4 estimate. Default: 1.4. */
  costToleranceMultiplier?: number;
  /** Disable per-service attribution in metadata v2. Default: false. */
  disableMetadataV2Services?: boolean;
  dataDir: string;
}

/** Result of signPerRequestAuth — includes the payload and whether a reserve top-up is needed. */
export interface PerRequestAuthResult {
  payload: SpendingAuthPayload;
  topUpNeeded: boolean;
}

export interface BuyerRequestBillingEntry {
  context: UnitBillingContext;
  requestFacts: ImageRequestFacts;
  unitModel?: UnitBillingModelV1;
  tokenPricing?: ServicePricing;
  observedUnitUsage?: UnitBillingUsage;
}

interface StoredBuyerRequestBillingEntry extends BuyerRequestBillingEntry {
  createdAtMs: number;
}

interface PendingReserveAuthorization {
  signature: string;
  salt: string;
  maxAmount: bigint;
  deadline: number;
  confirmedAmount: bigint;
}

/**
 * One request's newly authorized spend, reported as it is signed.
 *
 * Both the buyer-initiated (signPerRequestAuth) and seller-initiated
 * (handleNeedAuth) paths can observe the same request. Only the first path to
 * account for a delivered response reports its service amount and tokens; a
 * racing duplicate reports zero usage. Headroom-only authorizations may still
 * produce an event for the newly signed channel delta without claiming that a
 * response was delivered.
 */
export interface BuyerSpendEvent {
  sellerPeerId: string;
  /** Proxy request id, when the caller threaded one through. */
  requestId: string | null;
  /** USDC base units newly authorized by this signature. */
  amountUsdc: string;
  inputTokens: string;
  cachedInputTokens: string;
  /** Includes OUTPUT_IMAGE_TOKEN_EQUIVALENT credits for generated images. */
  outputTokens: string;
  outputImages: string;
}

export type BuyerSpendListener = (event: BuyerSpendEvent) => void;

/**
 * Manages buyer-side payment sessions using EIP-712 SpendingAuth
 * with cumulative authorization, bytes/4 cost verification, and overdraft control.
 */
export class BuyerPaymentManager {
  private readonly _identity: BuyerIdentity;
  private _signer: AbstractSigner;
  private readonly _depositsClient: DepositsClient;
  private readonly _config: BuyerPaymentConfig;
  private readonly _channelStore: BuyerChannelStore;
  /** In-memory map of active confirmed sessions by seller peerId for fast lookups. */
  private readonly _confirmedPeers = new Set<string>();
  /** Peers that explicitly rejected our spending auth. */
  private readonly _rejectedPeers = new Set<string>();

  private readonly _sellerAddressResolver?: SellerAddressResolver;

  /** sellerPeerId -> cumulative USDC amount in the latest SpendingAuth */
  private readonly _cumulativeAmount = new Map<string, bigint>();

  /** sellerPeerId -> cumulative metadata for SpendingAuth */
  private readonly _metadata = new Map<string, SpendingAuthMetadata>();

  /** sellerPeerId -> buyer-verified cumulative cost from bytes/4 */
  private readonly _verifiedCost = new Map<string, bigint>();

  /** requestId -> service/model the buyer requested (from its own request body).
   *  Used in handleNeedAuth to validate cost with the correct pricing tier
   *  without trusting the seller's claim of which service was used. */
  private readonly _requestService = new RequestServiceTracker();
  /**
   * requestId -> trusted buyer-owned billing identity, request facts, and mode.
   *
   * Used by NeedAuth validation so seller-reported billingUsage cannot choose
   * the provider, protocol, service, billing model, or size/quality tier after
   * the fact.
   */
  private readonly _requestBillingEntries = new Map<string, StoredBuyerRequestBillingEntry>();
  private readonly _observedUsageWaiters = new Map<string, Array<(usage: UnitBillingUsage) => void>>();

  /** sellerPeerId -> full pricing map (defaults + per-service overrides from peer metadata / 402) */
  private readonly _sessionPricing = new Map<string, { defaults: ServicePricing; services: Record<string, ServicePricing> }>();

  /** Cumulative response token totals per seller, tracked independently of signing metadata. */
  private readonly _responseTokenTotals = new Map<string, { input: number; output: number; requests: number }>();

  /** sellerPeerId -> current on-chain reserve ceiling (can grow with top-ups) */
  private readonly _currentReserveCeiling = new Map<string, bigint>();

  /** sellerPeerId -> original first-reserve amount for replaying reserve() safely. */
  private readonly _initialReserveAmount = new Map<string, bigint>();

  /** sellerPeerId -> salt used in the current reserve */
  private readonly _reserveSalt = new Map<string, string>();

  /** Latest ReserveAuth awaiting seller acknowledgement, including top-ups. */
  private readonly _pendingReserveAuth = new Map<string, PendingReserveAuthorization>();

  /** Cached EIP-712 domain — static for the lifetime of this manager. */
  private readonly _channelsDomain: ReturnType<typeof makeChannelsDomain>;

  constructor(identity: BuyerIdentity, config: BuyerPaymentConfig, channelStore: BuyerChannelStore, sellerAddressResolver?: SellerAddressResolver) {
    this._identity = identity;
    this._config = config;
    this._sellerAddressResolver = sellerAddressResolver;
    this._signer = identity.wallet;
    this._depositsClient = new DepositsClient({
      rpcUrl: config.rpcUrl,
      ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
      contractAddress: config.depositsContractAddress,
      usdcAddress: config.usdcAddress,
      evmChainId: config.chainId,
    });
    this._channelStore = channelStore;
    this._channelsDomain = makeChannelsDomain(config.chainId, config.channelsContractAddress);

    // Hydrate cumulative maps from persisted active sessions
    this._hydrateFromStore();
  }

  /** Hydrate cumulative tracking maps from persisted active buyer sessions. */
  private _hydrateFromStore(): void {
    const activeChannels = this._channelStore.getActiveChannelsByBuyer(
      CHANNEL_ROLE.BUYER,
      this._identity.wallet.address,
    );
    const latestByPeer = new Map<string, StoredChannel>();
    for (const channel of activeChannels) {
      const existing = latestByPeer.get(channel.peerId);
      if (
        !existing
        || channel.createdAt > existing.createdAt
        || (channel.createdAt === existing.createdAt && channel.updatedAt > existing.updatedAt)
      ) {
        latestByPeer.set(channel.peerId, channel);
      }
    }

    for (const channel of latestByPeer.values()) {
      this._hydrateChannel(channel, true);
    }
  }

  /** Adopt an authorization durably written outside this manager. */
  adoptPersistedAuthorization(channel: StoredChannel): void {
    if (
      channel.role !== CHANNEL_ROLE.BUYER
      || channel.buyerEvmAddr.toLowerCase() !== this._identity.wallet.address.toLowerCase()
    ) {
      throw buyerFault('Cannot adopt an authorization owned by another buyer', 'buyer-session-state');
    }
    this._hydrateChannel(channel, false);
  }

  private _hydrateChannel(channel: StoredChannel, persistServiceMetadata: boolean): void {
    const peerId = channel.peerId;
    const persistedCumulative = BigInt(channel.authMax);
    this._cumulativeAmount.set(peerId, persistedCumulative);
    const metadata = this._sanitizeMetadata(this._channelStore.getChannelMetadata(channel));
    this._metadata.set(peerId, metadata);
    if (persistServiceMetadata && !this._disableMetadataV2Services) {
      this._persistServiceMetadata(channel.sessionId, metadata);
    }
    // Hydrate verifiedCost to authMax so _maxSignable can grow beyond maxPerRequestUsdc.
    // Without this, maxSignable = 0 + maxPerRequestUsdc after restart, permanently capping
    // the cumulative and causing non-monotonic SpendingAuth rejections on the seller.
    this._verifiedCost.set(peerId, persistedCumulative);
    // Stores predating browser recovery (including the current sqlite node
    // store) omit these optional fields. Preserve their historical default
    // ceiling instead of interpreting missing recovery state as a confirmed
    // zero reserve.
    const hasReserveRecoveryState = channel.confirmedReserveAmount != null
      || channel.reserveMaxAmount != null
      || channel.reserveAuthPending != null;
    if (hasReserveRecoveryState) {
      let confirmedReserve = 0n;
      if (channel.confirmedReserveAmount != null) {
        confirmedReserve = BigInt(channel.confirmedReserveAmount);
      } else if (channel.reserveMaxAmount != null && channel.reserveAuthPending !== true) {
        confirmedReserve = BigInt(channel.reserveMaxAmount);
      }
      this._currentReserveCeiling.set(peerId, confirmedReserve);
      if (confirmedReserve > 0n) this._confirmedPeers.add(peerId);
      if (
        channel.reserveAuthPending === true
        && channel.latestReserveAuthSig
        && channel.reserveSalt
        && channel.reserveMaxAmount != null
        && channel.latestReserveDeadline != null
      ) {
        this._pendingReserveAuth.set(peerId, {
          signature: channel.latestReserveAuthSig,
          salt: channel.reserveSalt,
          maxAmount: BigInt(channel.reserveMaxAmount),
          deadline: channel.latestReserveDeadline,
          confirmedAmount: confirmedReserve,
        });
      }
    }
    if (channel.initialReserveAmount != null) {
      this._initialReserveAmount.set(peerId, BigInt(channel.initialReserveAmount));
    }
    if (channel.reserveSalt) {
      this._reserveSalt.set(peerId, channel.reserveSalt);
    }
    this._responseTokenTotals.set(peerId, {
      input: Number(channel.tokensDelivered),
      output: Number(channel.previousConsumption),
      requests: channel.requestCount,
    });
  }

  get signer(): AbstractSigner {
    return this._signer;
  }

  setSigner(signer: AbstractSigner): void {
    this._signer = signer;
  }

  get depositsClient(): DepositsClient {
    return this._depositsClient;
  }

  private get _costTolerance(): number {
    return this._config.costToleranceMultiplier ?? DEFAULT_COST_TOLERANCE;
  }

  private get _disableMetadataV2Services(): boolean {
    return this._config.disableMetadataV2Services === true;
  }

  private _sanitizeMetadata(metadata: SpendingAuthMetadata | undefined): SpendingAuthMetadata {
    const current = metadata ?? ZERO_METADATA;
    if (!this._disableMetadataV2Services) return current;
    return {
      cumulativeInputTokens: current.cumulativeInputTokens,
      cumulativeOutputTokens: current.cumulativeOutputTokens,
      cumulativeRequestCount: current.cumulativeRequestCount,
      cumulativeOutputImages: current.cumulativeOutputImages ?? 0n,
      services: [],
    };
  }

  private _advanceUsageMetadata(
    previous: SpendingAuthMetadata | undefined,
    service: string | undefined,
    delta: Parameters<typeof advanceUsageMetadata>[2],
  ): SpendingAuthMetadata {
    return advanceUsageMetadata(
      this._sanitizeMetadata(previous),
      this._disableMetadataV2Services ? undefined : service,
      delta,
    );
  }

  private _getCeiling(sellerPeerId: string): bigint {
    return this._currentReserveCeiling.get(sellerPeerId) ?? this._config.maxReserveAmountUsdc;
  }

  /** Clean up all in-memory state for a seller when the session ends. */
  cleanupSession(sellerPeerId: string): void {
    this._cumulativeAmount.delete(sellerPeerId);
    this._metadata.delete(sellerPeerId);
    this._verifiedCost.delete(sellerPeerId);
    this._sessionPricing.delete(sellerPeerId);
    this._currentReserveCeiling.delete(sellerPeerId);
    this._initialReserveAmount.delete(sellerPeerId);
    this._reserveSalt.delete(sellerPeerId);
    this._pendingReserveAuth.delete(sellerPeerId);
    this._confirmedPeers.delete(sellerPeerId);
    this._rejectedPeers.delete(sellerPeerId);
    this._responseTokenTotals.delete(sellerPeerId);
    this._clearRequestBillingForSeller(sellerPeerId);
  }

  getActiveSession(sellerPeerId: string): StoredChannel | null {
    return this._channelStore.getActiveChannelByPeerAndBuyer(sellerPeerId, CHANNEL_ROLE.BUYER, this._identity.wallet.address);
  }

  retireSession(
    sellerPeerId: string,
    status: typeof CHANNEL_STATUS.SETTLED | typeof CHANNEL_STATUS.TIMEOUT | typeof CHANNEL_STATUS.GHOST,
    settledAmount?: bigint,
  ): void {
    const session = this.getActiveSession(sellerPeerId);
    if (session) {
      this._channelStore.updateChannelStatus(
        session.sessionId,
        status,
        settledAmount !== undefined ? settledAmount.toString() : undefined,
      );
    }
    this.cleanupSession(sellerPeerId);
  }

  canReplayReserveAuth(sellerPeerId: string): boolean {
    return this._reserveSalt.has(sellerPeerId);
  }

  hasPendingReserveAuth(sellerPeerId: string): boolean {
    return this._pendingReserveAuth.has(sellerPeerId);
  }

  clearLockConfirmation(sellerPeerId: string): void {
    this._confirmedPeers.delete(sellerPeerId);
    this._rejectedPeers.delete(sellerPeerId);
  }

  async resendCurrentSpendingAuth(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<string> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw buyerFault(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}...`, 'buyer-session-state');
    }

    const cumulativeAmount = this._cumulativeAmount.get(sellerPeerId) ?? BigInt(session.authMax);
    const currentMeta = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    const metadataHashHex = computeMetadataHash(currentMeta);
    const encodedMetadata = encodeMetadata(currentMeta);

    const metadataMsg: SpendingAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount,
      metadataHash: metadataHashHex,
    };
    const spendingAuthSig = await signSpendingAuth(this._signer, this._channelsDomain, metadataMsg);

    await this._commitAuthorization({
      ...session,
      latestBuyerSig: spendingAuthSig,
      latestSpendingAuthSig: spendingAuthSig,
      latestMetadata: encodedMetadata,
      updatedAt: Date.now(),
    }, currentMeta);

    paymentMux.sendSpendingAuth({
      channelId: session.sessionId,
      cumulativeAmount: cumulativeAmount.toString(),
      metadataHash: metadataHashHex,
      metadata: encodedMetadata,
      spendingAuthSig,
    });

    return session.sessionId;
  }

  async extendCurrentSpendingAuth(
    sellerPeerId: string,
    minBudgetPerRequest: bigint,
    paymentMux: PaymentMux,
    targetCumulative?: bigint,
  ): Promise<string> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw buyerFault(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}...`, 'buyer-session-state');
    }

    const currentCumulative = this._cumulativeAmount.get(sellerPeerId) ?? BigInt(session.authMax);
    let maxSignable = this._maxSignable(sellerPeerId);
    const reopened = this._reopenOverdraftWindowIfCollapsed(
      sellerPeerId,
      currentCumulative,
      maxSignable,
      'extendCurrentSpendingAuth',
    );
    maxSignable = reopened.maxSignable;

    const ceiling = this._getCeiling(sellerPeerId);
    // Prefer the seller-supplied target when present — a raw
    // `currentCumulative + minBudgetPerRequest` advance may still fall short
    // of what the seller has already spent, producing an infinite 402 loop.
    const minAdvance = currentCumulative + minBudgetPerRequest;
    const requestedAmount = targetCumulative != null && targetCumulative > minAdvance
      ? targetCumulative
      : minAdvance;

    const nextCumulative = requestedAmount < maxSignable ? requestedAmount : maxSignable;
    const extendNeedsTopUp = this._needsCeilingAdvance(requestedAmount, maxSignable, ceiling);
    if (nextCumulative <= currentCumulative) {
      // Nothing to sign at current ceiling — try topUp anyway for next round
      if (extendNeedsTopUp) {
        await this._topUpAfterSpendAuthBestEffort(sellerPeerId, paymentMux, 'extendCurrentSpendingAuth');
      }
      debugWarn(
        `[BuyerPayment] Cannot extend active session for ${sellerPeerId.slice(0, 12)}... ` +
        `(current=${currentCumulative} maxSignable=${maxSignable} target=${targetCumulative ?? 'n/a'})`,
      );
      return session.sessionId;
    }

    const currentMeta = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    const spendingAuth = await this._commitUpdatedSpendingAuth(
      session,
      sellerPeerId,
      nextCumulative,
      currentMeta,
    );
    this._verifiedCost.set(sellerPeerId, reopened.verifiedCost);
    paymentMux.sendSpendingAuth(spendingAuth);

    // Send topUp AFTER the SpendingAuth so the seller processes the higher
    // cumulative first, meeting the on-chain settle threshold for topUp.
    if (extendNeedsTopUp) {
      await this._topUpAfterSpendAuthBestEffort(sellerPeerId, paymentMux, 'extendCurrentSpendingAuth');
    }

    return session.sessionId;
  }

  /**
   * Build a CloseChannelRequest for an active session.
   *
   * With `includeAuth` (the default) the buyer signs its current cumulative so
   * a seller that lost the last SpendingAuth can still close at the full
   * amount owed. Signing costs nothing extra: the cumulative is unchanged, so
   * this authorizes no more than the seller could already claim. Pass
   * `includeAuth: false` to send a bare request and let the seller close using
   * whatever auth it already holds.
   */
  async buildCloseChannelRequest(
    sellerPeerId: string,
    { includeAuth = true }: { includeAuth?: boolean } = {},
  ): Promise<CloseChannelRequestPayload> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw buyerFault(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}...`, 'buyer-session-state');
    }

    const cumulativeAmount = this._cumulativeAmount.get(sellerPeerId) ?? BigInt(session.authMax);
    if (!includeAuth || cumulativeAmount <= 0n) {
      return { version: 1, channelId: session.sessionId };
    }

    const currentMeta = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    const metadataHash = computeMetadataHash(currentMeta);
    const metadataMsg: SpendingAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount,
      metadataHash,
    };

    const spendingAuthSig = await signSpendingAuth(
      this._signer,
      this._channelsDomain,
      metadataMsg,
    );
    const encodedMetadata = encodeMetadata(currentMeta);
    await this._commitAuthorization({
      ...session,
      latestBuyerSig: spendingAuthSig,
      latestSpendingAuthSig: spendingAuthSig,
      latestMetadata: encodedMetadata,
      updatedAt: Date.now(),
    }, currentMeta);

    return {
      version: 1,
      channelId: session.sessionId,
      cumulativeAmount: cumulativeAmount.toString(),
      metadataHash,
      metadata: encodedMetadata,
      spendingAuthSig,
    };
  }

  async resendReserveAuth(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<string> {
    const session = this.getActiveSession(sellerPeerId);
    const salt = this._reserveSalt.get(sellerPeerId);
    if (!session || !salt) {
      throw buyerFault(`[BuyerPayment] No replayable reserve for seller ${sellerPeerId.slice(0, 12)}...`, 'buyer-session-state');
    }

    // Force a fresh AuthAck after replaying the reserve path.
    this._confirmedPeers.delete(sellerPeerId);

    const replayAmount = this._initialReserveAmount.get(sellerPeerId)
      ?? this._currentReserveCeiling.get(sellerPeerId)
      ?? this._config.maxReserveAmountUsdc;
    const maxAmount = replayAmount > this._config.maxReserveAmountUsdc
      ? this._config.maxReserveAmountUsdc
      : replayAmount;
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;
    const reserveMsg: ReserveAuthMessage = {
      channelId: session.sessionId,
      maxAmount,
      deadline: BigInt(deadline),
    };
    const reserveAuthSig = await signReserveAuth(this._signer, this._channelsDomain, reserveMsg);

    const pending: PendingReserveAuthorization = {
      signature: reserveAuthSig,
      salt,
      maxAmount,
      deadline,
      confirmedAmount: 0n,
    };
    await this._commitAndSendReserveAuth(session, sellerPeerId, pending, paymentMux, {
      initialReserveAmount: maxAmount.toString(),
    });

    return session.sessionId;
  }

  /** Replay the latest unacknowledged initial reserve or top-up authorization. */
  async resendPendingReserveAuth(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<string> {
    const session = this.getActiveSession(sellerPeerId);
    const existing = this._pendingReserveAuth.get(sellerPeerId);
    if (!session || !existing) {
      throw new Error(`[BuyerPayment] No pending reserve for seller ${sellerPeerId.slice(0, 12)}...`);
    }

    // Replaying an initial reserve requires a fresh AuthAck. A top-up does not:
    // current sellers only acknowledge the initial/recovered channel, while
    // top-up confirmation comes from the authoritative on-chain read.
    if (existing.confirmedAmount === 0n) {
      this._confirmedPeers.delete(sellerPeerId);
    }
    let pending = existing;
    const now = Math.floor(Date.now() / 1000);
    if (pending.deadline <= now + 30) {
      const deadline = now + this._config.defaultAuthDurationSecs;
      const signature = await signReserveAuth(this._signer, this._channelsDomain, {
        channelId: session.sessionId,
        maxAmount: pending.maxAmount,
        deadline: BigInt(deadline),
      });
      pending = { ...pending, signature, deadline };
    }

    await this._commitAndSendReserveAuth(session, sellerPeerId, pending, paymentMux);
    return session.sessionId;
  }

  /** Reconcile the locally usable ceiling with an authoritative on-chain read. */
  async reconcileReserveAmount(sellerPeerId: string, onChainAmount: bigint): Promise<void> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) return;

    const pending = this._pendingReserveAuth.get(sellerPeerId);
    const applied = pending != null && onChainAmount >= pending.maxAmount;
    // The chain is authoritative even when it is ahead of our latest locally
    // persisted authorization (for example after recovery on another device).
    this._currentReserveCeiling.set(sellerPeerId, onChainAmount);
    if (applied) {
      this._pendingReserveAuth.delete(sellerPeerId);
      // An initial ReserveAuth can land on-chain immediately before the browser
      // crashes and lose its AuthAck. The authoritative channel read is an
      // equivalent confirmation and must reopen signing before the first
      // post-reload request is allowed through.
      if (pending.confirmedAmount === 0n) this._confirmedPeers.add(sellerPeerId);
    }

    const metadata = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    await this._commitAuthorization({
      ...session,
      reserveAuthPending: pending != null && !applied,
      confirmedReserveAmount: onChainAmount.toString(),
      updatedAt: Date.now(),
    }, metadata);
  }

  private _reopenOverdraftWindowIfCollapsed(
    sellerPeerId: string,
    currentCumulative: bigint,
    maxSignable: bigint,
    context: 'extendCurrentSpendingAuth' | 'handleNeedAuth',
    verifiedCost = this._verifiedCost.get(sellerPeerId) ?? 0n,
  ): { maxSignable: bigint; verifiedCost: bigint } {
    // Overdraft-window unblock: when the buyer has already signed up to
    // `verified + maxPerRequest` and the seller returned 402 because `spent`
    // caught up, advance `verifiedCost` to the current signed cumulative so
    // the window reopens. The buyer has already committed to pay
    // `currentCumulative` via the signed SpendingAuth, so the seller can
    // already claim that much on-chain — advancing verified to match doesn't
    // expose new funds, it just reclaims overdraft headroom.
    //
    // SECURITY: the trust anchor here is `currentCumulative`, NOT any
    // seller-supplied target. A malicious seller could overstate required
    // spend in a 402 / NeedAuth path in an attempt to drain the reserve. We
    // defend by only advancing verifiedCost to the amount the buyer has
    // already signed. Seller-provided values remain destination hints bounded
    // by `verifiedCost + maxPerRequestUsdc` and are never used to mint new
    // trust directly.
    if (maxSignable > currentCumulative) return { maxSignable, verifiedCost };

    if (currentCumulative <= verifiedCost) return { maxSignable, verifiedCost };

    const reopened = this._maxSignableForVerified(sellerPeerId, currentCumulative);
    debugLog(
      `[BuyerPayment] ${context}: will advance verifiedCost ${verifiedCost} → ${currentCumulative} ` +
      `to unblock overdraft window for ${sellerPeerId.slice(0, 12)}...`,
    );
    return { maxSignable: reopened, verifiedCost: currentCumulative };
  }

  private _needsCeilingAdvance(requestedAmount: bigint, maxSignable: bigint, ceiling: bigint): boolean {
    return requestedAmount > maxSignable && maxSignable >= ceiling;
  }

  /**
   * Both signPerRequestAuth (buyer-initiated) and handleNeedAuth (seller-initiated)
   * can fire for the same delivered response. Whichever path accounts for the
   * response first records its requestId here so the other path does not
   * duplicate its service amount, token totals, or request count.
   */
  private readonly _serviceTokensCounted = new CountedRequestTracker();

  private _spendListener: BuyerSpendListener | null = null;

  /**
   * Observe per-request spend as it is signed. Used to attribute cost to the
   * caller's own unit of work (a tool conversation, say), which only the layer
   * that issued the request can know.
   */
  setSpendListener(listener: BuyerSpendListener | null): void {
    this._spendListener = listener;
  }

  private _reportSpend(event: BuyerSpendEvent): void {
    if (!this._spendListener) return;
    try {
      this._spendListener(event);
    } catch (err) {
      // Accounting is a bystander here — never let it break the payment path.
      debugWarn(`[BuyerPayment] spend listener threw: ${err instanceof Error ? err.message : err}`);
    }
  }

  private _cleanupRequestBillingCache(now = Date.now()): void {
    for (const [requestId, entry] of this._requestBillingEntries) {
      if (now - entry.createdAtMs > REQUEST_BILLING_TTL_MS) {
        this.clearRequestBilling(requestId);
      }
    }
  }

  private _trimRequestBillingCache(): void {
    while (this._requestBillingEntries.size > MAX_REQUEST_BILLING_ENTRIES) {
      const oldest = this._requestBillingEntries.keys().next().value;
      if (oldest === undefined) break;
      this.clearRequestBilling(oldest);
    }
  }

  private _clearRequestBillingForSeller(sellerPeerId: string): void {
    for (const [requestId, entry] of this._requestBillingEntries) {
      if (entry.context.sellerPeerId === sellerPeerId) {
        this.clearRequestBilling(requestId);
      }
    }
  }

  private _persistServiceMetadata(sessionId: string, metadata: SpendingAuthMetadata): void {
    this._channelStore.replaceMetadataServiceTotals(sessionId, this._sanitizeMetadata(metadata).services);
  }

  private async _commitAuthorization(
    channel: StoredChannel,
    metadata: SpendingAuthMetadata,
  ): Promise<void> {
    const sanitized = this._sanitizeMetadata(metadata);
    const services = sanitized.services;
    const snapshot: StoredChannel = {
      ...channel,
      tokensDelivered: sanitized.cumulativeInputTokens.toString(),
      previousConsumption: sanitized.cumulativeOutputTokens.toString(),
      requestCount: Number(sanitized.cumulativeRequestCount),
      latestMetadata: channel.latestMetadata ?? encodeMetadata(sanitized),
    };
    if (this._channelStore.commitAuthorization) {
      await this._channelStore.commitAuthorization(snapshot, services);
      return;
    }
    this._channelStore.replaceMetadataServiceTotals(snapshot.sessionId, services);
    this._channelStore.upsertChannel(snapshot);
    await this._channelStore.flush?.();
  }

  /**
   * Durably persist a pending ReserveAuth, then transmit it and adopt the new
   * ceiling in memory. Shared by reserve replay, pending-reserve replay, and
   * reserve top-ups.
   */
  private async _commitAndSendReserveAuth(
    session: StoredChannel,
    sellerPeerId: string,
    pending: PendingReserveAuthorization,
    paymentMux: PaymentMux,
    options: { cumulativeAmount?: string; initialReserveAmount?: string } = {},
  ): Promise<void> {
    const metadata = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    const encodedMetadata = encodeMetadata(metadata);
    await this._commitAuthorization({
      ...session,
      deadline: pending.deadline,
      latestBuyerSig: pending.signature,
      latestMetadata: encodedMetadata,
      reserveSalt: pending.salt,
      ...(options.initialReserveAmount !== undefined
        ? { initialReserveAmount: options.initialReserveAmount }
        : {}),
      reserveMaxAmount: pending.maxAmount.toString(),
      latestReserveAuthSig: pending.signature,
      latestReserveDeadline: pending.deadline,
      reserveAuthPending: true,
      confirmedReserveAmount: pending.confirmedAmount.toString(),
      updatedAt: Date.now(),
    }, metadata);
    this._pendingReserveAuth.set(sellerPeerId, pending);

    paymentMux.sendSpendingAuth({
      channelId: session.sessionId,
      cumulativeAmount: options.cumulativeAmount ?? session.authMax,
      metadataHash: computeMetadataHash(metadata),
      metadata: encodedMetadata,
      spendingAuthSig: pending.signature,
      reserveSalt: pending.salt,
      reserveMaxAmount: pending.maxAmount.toString(),
      reserveDeadline: pending.deadline,
    });
    this._currentReserveCeiling.set(sellerPeerId, pending.maxAmount);
  }

  private async _commitUpdatedSpendingAuth(
    session: StoredChannel,
    sellerPeerId: string,
    cumulativeAmount: bigint,
    metadata: SpendingAuthMetadata,
  ): Promise<SpendingAuthPayload> {
    const sanitizedMetadata = this._sanitizeMetadata(metadata);
    const metadataHashHex = computeMetadataHash(sanitizedMetadata);
    const encodedMetadata = encodeMetadata(sanitizedMetadata);
    const metadataMsg: SpendingAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount,
      metadataHash: metadataHashHex,
    };
    const spendingAuthSig = await signSpendingAuth(this._signer, this._channelsDomain, metadataMsg);

    await this._commitAuthorization({
      ...session,
      authMax: cumulativeAmount.toString(),
      latestBuyerSig: spendingAuthSig,
      latestSpendingAuthSig: spendingAuthSig,
      latestMetadata: encodedMetadata,
      updatedAt: Date.now(),
    }, sanitizedMetadata);

    this._cumulativeAmount.set(sellerPeerId, cumulativeAmount);
    return {
      channelId: session.sessionId,
      cumulativeAmount: cumulativeAmount.toString(),
      metadataHash: metadataHashHex,
      metadata: encodedMetadata,
      spendingAuthSig,
    };
  }

  private async _topUpAfterSpendAuthBestEffort(
    sellerPeerId: string,
    paymentMux: PaymentMux,
    context: 'extendCurrentSpendingAuth' | 'handleNeedAuth',
  ): Promise<void> {
    try {
      await this.topUpReserve(sellerPeerId, paymentMux);
    } catch (err) {
      debugWarn(`[BuyerPayment] ${context}: topUpReserve failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Spending Authorization ────────────────────────────────────

  /**
   * Sign and send an initial EIP-712 SpendingAuth to a seller.
   * The initial cumulativeAmount is set to the seller's minBudgetPerRequest.
   *
   * @param pricing Token pricing from the seller's 402 / peer metadata.
   * @param pricingMap Full pricing map (defaults + per-service) from peer metadata. If provided,
   *   merges with existing session pricing. The `pricing` arg is used as the service-specific
   *   override for the service that triggered the 402.
   */
  async authorizeSpending(
    sellerPeerId: string,
    paymentMux: PaymentMux,
    minBudgetPerRequest: bigint,
    reserveAmountOrPricing?: bigint | ServicePricing,
    pricingArg?: ServicePricing,
    pricingMap?: { defaults: ServicePricing; services: Record<string, ServicePricing> },
    metadataArg?: PeerMetadata,
  ): Promise<string> {
    const sellerEvmAddr = this._sellerAddressResolver
      ? await this._sellerAddressResolver.resolveSellerAddress(sellerPeerId as PeerId, metadataArg)
      : peerIdToAddress(sellerPeerId);
    const reserveAmount = typeof reserveAmountOrPricing === 'bigint'
      ? reserveAmountOrPricing
      : this._config.maxReserveAmountUsdc;
    const pricing = typeof reserveAmountOrPricing === 'bigint'
      ? pricingArg
      : reserveAmountOrPricing;

    // Budget validation: reject if seller demands more than buyer's overdraft limit
    if (minBudgetPerRequest > this._config.maxPerRequestUsdc) {
      debugWarn(
        `[BuyerPayment] Seller ${sellerPeerId.slice(0, 12)}... minBudgetPerRequest=${minBudgetPerRequest} exceeds maxPerRequestUsdc=${this._config.maxPerRequestUsdc} — not authorizing`,
      );
      return '';
    }

    // Clear confirmation state so we wait for a fresh AuthAck on the new session
    this._confirmedPeers.delete(sellerPeerId);

    // Store full pricing map (defaults + all per-service overrides).
    // Merge 402-negotiated pricing on top of peer-metadata defaults so
    // the seller's live rate takes precedence over cached peer metadata.
    if (pricingMap) {
      const mergedDefaults = pricing
        ? { ...pricingMap.defaults, ...pricing }
        : pricingMap.defaults;
      this._sessionPricing.set(sellerPeerId, { defaults: mergedDefaults, services: pricingMap.services });
    } else if (pricing) {
      // Legacy: single pricing, store as defaults
      const existing = this._sessionPricing.get(sellerPeerId);
      this._sessionPricing.set(sellerPeerId, {
        defaults: pricing,
        services: existing?.services ?? {},
      });
    }

    // Generate random salt and compute deterministic channelId
    const salt = hexlify(randomBytes(32));
    const buyerEvmAddr = this._identity.wallet.address;
    const channelId = computeChannelId(buyerEvmAddr, sellerEvmAddr, salt);
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;

    debugLog(`[BuyerPayment] authorizeSpending: channel=${channelId.slice(0, 18)}... seller=${sellerPeerId.slice(0, 12)}... amount=${minBudgetPerRequest}`);

    // Sign ReserveAuth — binds channelId, maxAmount, deadline on-chain
    const channelsDomain = this._channelsDomain;
    const maxAmount = reserveAmount;
    const reserveMsg: ReserveAuthMessage = {
      channelId,
      maxAmount,
      deadline: BigInt(deadline),
    };
    const reserveAuthSig = await signReserveAuth(this._signer, channelsDomain, reserveMsg);

    // Initialize state for this session.
    // Start cumulative at 0 — the initial message is a ReserveAuth (not a SpendingAuth).
    // The first real SpendingAuth will be sent by handleNeedAuth after the seller serves
    // the first request and reports its cost.
    this._cumulativeAmount.set(sellerPeerId, 0n);
    this._metadata.set(sellerPeerId, this._sanitizeMetadata({ ...ZERO_METADATA }));
    this._verifiedCost.set(sellerPeerId, 0n);
    this._currentReserveCeiling.set(sellerPeerId, 0n);
    this._initialReserveAmount.set(sellerPeerId, maxAmount);
    this._reserveSalt.set(sellerPeerId, salt);
    this._pendingReserveAuth.set(sellerPeerId, {
      signature: reserveAuthSig,
      salt,
      maxAmount,
      deadline,
      confirmedAmount: 0n,
    });

    // Store session
    const now = Date.now();
    const initialMetadata = this._sanitizeMetadata({ ...ZERO_METADATA });
    const encodedInitialMetadata = encodeMetadata(initialMetadata);
    const session: StoredChannel = {
      sessionId: channelId,
      peerId: sellerPeerId,
      role: CHANNEL_ROLE.BUYER,
      sellerEvmAddr,
      buyerEvmAddr: this._identity.wallet.address,
      nonce: 0,
      authMax: '0',
      deadline,
      previousSessionId: '0x' + '0'.repeat(64),
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: reserveAuthSig,
      latestSpendingAuthSig: null,
      latestMetadata: encodedInitialMetadata,
      reserveSalt: salt,
      initialReserveAmount: maxAmount.toString(),
      reserveMaxAmount: maxAmount.toString(),
      latestReserveAuthSig: reserveAuthSig,
      latestReserveDeadline: deadline,
      reserveAuthPending: true,
      confirmedReserveAmount: '0',
      createdAt: now,
      updatedAt: now,
    };
    await this._commitAuthorization(session, initialMetadata);

    // Send SpendingAuth via PaymentMux — reserve carries ReserveAuth sig
    paymentMux.sendSpendingAuth({
      channelId,
      cumulativeAmount: '0',
      metadataHash: ZERO_METADATA_HASH,
      metadata: encodedInitialMetadata,
      spendingAuthSig: reserveAuthSig,
      reserveSalt: salt,
      reserveMaxAmount: maxAmount.toString(),
      reserveDeadline: deadline,
    });
    this._currentReserveCeiling.set(sellerPeerId, maxAmount);

    return channelId;
  }

  // ── AuthAck handler ───────────────────────────────────────────

  async handleAuthAck(sellerPeerId: string, payload: AuthAckPayload): Promise<void> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] AuthAck for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }
    if (session.sessionId !== payload.channelId) {
      debugWarn(`[BuyerPayment] AuthAck channel mismatch: expected=${session.sessionId.slice(0, 18)}... got=${payload.channelId.slice(0, 18)}...`);
      return;
    }

    this._confirmedPeers.add(sellerPeerId);
    const pending = this._pendingReserveAuth.get(sellerPeerId);
    // Existing sellers acknowledge initial reserve/recovery, but top-ups have
    // no dedicated acknowledgement. Top-ups remain pending until an on-chain
    // session read observes their ceiling.
    if (pending?.confirmedAmount === 0n) {
      this._currentReserveCeiling.set(sellerPeerId, pending.maxAmount);
      this._pendingReserveAuth.delete(sellerPeerId);
      const metadata = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
      await this._commitAuthorization({
        ...session,
        reserveAuthPending: false,
        confirmedReserveAmount: pending.maxAmount.toString(),
        updatedAt: Date.now(),
      }, metadata);
    }
    debugLog(`[BuyerPayment] AuthAck confirmed: channel=${session.sessionId.slice(0, 18)}...`);
  }

  // ── Buyer-side cost verification ──────────────────────────────

  /**
   * Estimate tokens and cost from response content without updating state.
   */
  private _estimateResponseCost(
    sellerPeerId: string,
    inputBytes: Uint8Array,
    outputBytes: Uint8Array,
    service?: string,
  ): { cost: bigint; inputTokens: number; outputTokens: number } | null {
    const pricing = this.getSessionPricing(sellerPeerId, service);
    if (!pricing) return null;
    return estimateCostFromBytes(inputBytes, outputBytes, pricing);
  }

  /**
   * Accumulate a cost estimate into verifiedCost.
   */
  private _accumulateVerifiedCost(
    sellerPeerId: string,
    estimate: { cost: bigint; inputTokens: number; outputTokens: number },
  ): bigint {
    const prev = this._verifiedCost.get(sellerPeerId) ?? 0n;
    const newVerified = prev + estimate.cost;
    this._verifiedCost.set(sellerPeerId, newVerified);
    return newVerified;
  }

  /**
   * Record response content and update the buyer's verified cost.
   * Call this after receiving each response from the seller.
   *
   * NOTE: Do not call this AND signPerRequestAuth for the same response —
   * signPerRequestAuth already updates verifiedCost internally.
   *
   * @returns The updated verified cost and estimated tokens, or null if no pricing is available.
   */
  recordResponseBytes(
    sellerPeerId: string,
    inputBytes: Uint8Array,
    outputBytes: Uint8Array,
  ): { verifiedCost: bigint; inputTokens: number; outputTokens: number } | null {
    const estimate = this._estimateResponseCost(sellerPeerId, inputBytes, outputBytes);
    if (!estimate) return null;

    const newVerified = this._accumulateVerifiedCost(sellerPeerId, estimate);

    const inSize = inputBytes.length;
    const outSize = outputBytes.length;
    debugLog(
      `[BuyerPayment] recordResponseBytes: seller=${sellerPeerId.slice(0, 12)}... ` +
      `in=${inSize}B→${estimate.inputTokens}tok out=${outSize}B→${estimate.outputTokens}tok ` +
      `requestCost=${estimate.cost} verifiedCost=${newVerified}`,
    );

    return { verifiedCost: newVerified, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens };
  }

  // ── Per-request authorization (overdraft model) ─────────────

  /**
   * Compute the max signable cumulative amount based on the overdraft model:
   * maxSignable = verifiedCost + maxPerRequestUsdc, capped at reserve ceiling.
   */
  private _maxSignable(sellerPeerId: string): bigint {
    const verified = this._verifiedCost.get(sellerPeerId) ?? 0n;
    return this._maxSignableForVerified(sellerPeerId, verified);
  }

  private _maxSignableForVerified(sellerPeerId: string, verified: bigint): bigint {
    const ceiling = this._getCeiling(sellerPeerId);
    const maxSignable = verified + this._config.maxPerRequestUsdc;
    return maxSignable < ceiling ? maxSignable : ceiling;
  }

  /** Check whether the channel has reached its absolute remaining-headroom threshold. */
  private _needsTopUp(sellerPeerId: string): boolean {
    const ceiling = this._getCeiling(sellerPeerId);
    const current = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    const initialReserve = this._initialReserveAmount.get(sellerPeerId)
      ?? this._config.maxReserveAmountUsdc;
    const threshold = ceiling <= initialReserve
      ? initialReserve * INITIAL_TOPUP_HEADROOM_PERCENT / PERCENT_DENOMINATOR
      : SUBSEQUENT_TOPUP_HEADROOM_USDC;
    const remaining = ceiling > current ? ceiling - current : 0n;
    return remaining <= threshold;
  }

  /**
   * Sign an updated SpendingAuth after receiving a response.
   *
   * The buyer uses the seller's claimed cost to advance the cumulative amount,
   * but validates it against the buyer's bytes/4 estimate. If the seller's claim
   * exceeds the buyer's estimate by more than the configured tolerance, the buyer
   * caps at tolerance * buyerEstimate. The cumulative is also capped at the
   * overdraft limit (verifiedCost + maxPerRequestUsdc) and the reserve ceiling.
   *
   * @param sellerPeerId Seller peer ID.
   * @param responseStats Byte counts from the last response and seller's claimed cost.
   * @returns The signed payload and whether a reserve top-up is needed.
   */
  async signPerRequestAuth(
    sellerPeerId: string,
    responseStats: {
      inputBytes: Uint8Array;
      outputBytes: Uint8Array;
      sellerClaimedCost?: bigint;
      reportedInputTokens?: bigint;
      reportedOutputTokens?: bigint;
      reportedCachedInputTokens?: bigint;
      unitUsage?: UnitBillingUsage;
      service?: string;
      requestId?: string;
    },
  ): Promise<PerRequestAuthResult> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw buyerFault(
        `[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}... — call authorizeSpending() first`,
        'buyer-session-state',
      );
    }

    // Prefer reported token counts (from seller headers or buyer's parsed response usage)
    // over byte-based estimation. Byte estimation inflates tokens due to JSON/SSE overhead.
    // Also treat seller-claimed cost of 0 as authoritative — don't fall back to byte estimation.
    const hasReportedTokens = (responseStats.reportedInputTokens != null && responseStats.reportedInputTokens > 0n) ||
      (responseStats.reportedOutputTokens != null && responseStats.reportedOutputTokens > 0n) ||
      (responseStats.sellerClaimedCost != null && responseStats.sellerClaimedCost === 0n);

    let estimatedInputTokens: bigint;
    let estimatedOutputTokens: bigint;
    let estimatedCachedInputTokens = 0n;
    let byteEstimatedTokens = false;
    let buyerEstimatedRequestCost: bigint;
    let verifiedCostDelta = 0n;

    const requestBilling = responseStats.requestId != null
      ? this.getRequestBilling(responseStats.requestId)
      : undefined;

    const unitBillingModel = requestBilling?.unitModel;
    if (responseStats.unitUsage && unitBillingModel && requestBilling) {
      // Hybrid image path: token cost is still computed from the token
      // counts; unit billing only validates non-token unit cost.
      estimatedInputTokens = responseStats.reportedInputTokens ?? 0n;
      estimatedCachedInputTokens = responseStats.reportedCachedInputTokens ?? 0n;
      estimatedOutputTokens = responseStats.reportedOutputTokens ?? 0n;
      const freshInputTokens = estimatedCachedInputTokens > 0n
        ? BigInt(Math.max(0, Number(estimatedInputTokens) - Number(estimatedCachedInputTokens)))
        : estimatedInputTokens;
      const pricing = requestBilling.tokenPricing ?? this.getSessionPricing(sellerPeerId, responseStats.service);
      const tokenCost = pricing
        ? computeCostUsdc(Number(freshInputTokens), Number(estimatedOutputTokens), pricing, Number(estimatedCachedInputTokens))
        : 0n;
      const unitCost = validateUnitNormalizedCost(unitBillingModel, requestBilling.context, responseStats.unitUsage);
      buyerEstimatedRequestCost = tokenCost + unitCost;
      verifiedCostDelta += buyerEstimatedRequestCost;
      debugLog(
        `[BuyerPayment] Hybrid billing-estimated cost=${buyerEstimatedRequestCost} service=${responseStats.service ?? 'unknown'}`,
      );
    } else if (hasReportedTokens) {
      estimatedInputTokens = responseStats.reportedInputTokens ?? 0n;
      estimatedOutputTokens = responseStats.reportedOutputTokens ?? 0n;
      const cachedInputTokens = responseStats.reportedCachedInputTokens ?? 0n;
      estimatedCachedInputTokens = cachedInputTokens;
      // For cost estimation, reportedInputTokens is normalized to total logical
      // input tokens (fresh + cached), so split fresh by subtracting cached.
      const freshInputTokens = cachedInputTokens > 0n
        ? BigInt(Math.max(0, Number(estimatedInputTokens) - Number(cachedInputTokens)))
        : estimatedInputTokens;
      // Compute cost from reported tokens using service-specific pricing
      const pricing = this.getSessionPricing(sellerPeerId, responseStats.service);
      if (pricing) {
        const cost = computeCostUsdc(Number(freshInputTokens), Number(estimatedOutputTokens), pricing, Number(cachedInputTokens));
        buyerEstimatedRequestCost = cost;
        verifiedCostDelta += cost;
      } else if (responseStats.sellerClaimedCost != null && responseStats.sellerClaimedCost > 0n) {
        // No local pricing available (e.g. after buyer restart before session pricing is restored).
        // Use seller's claimed cost for verifiedCost accumulation so _maxSignable can grow.
        // The seller's claim is still validated against tolerance below.
        buyerEstimatedRequestCost = responseStats.sellerClaimedCost;
        verifiedCostDelta += responseStats.sellerClaimedCost;
      } else {
        buyerEstimatedRequestCost = 0n;
      }
      debugLog(
        `[BuyerPayment] Using reported tokens: in=${estimatedInputTokens} cached=${cachedInputTokens} out=${estimatedOutputTokens} cost=${buyerEstimatedRequestCost}`,
      );
    } else {
      // Fall back to byte-based estimation
      byteEstimatedTokens = true;
      const estimate = this._estimateResponseCost(sellerPeerId, responseStats.inputBytes, responseStats.outputBytes, responseStats.service);
      estimatedInputTokens = estimate ? BigInt(estimate.inputTokens) : 0n;
      estimatedOutputTokens = estimate ? BigInt(estimate.outputTokens) : 0n;
      buyerEstimatedRequestCost = estimate ? estimate.cost : 0n;
      if (estimate) {
        verifiedCostDelta += estimate.cost;
      }
      debugLog(
        `[BuyerPayment] Byte-estimated tokens (no reported): in=${estimatedInputTokens} out=${estimatedOutputTokens} cost=${buyerEstimatedRequestCost}`,
      );
    }

    // Image attribution (metadata/stats only — never cost). The count is the
    // buyer's own observation of the delivered response, so it survives a
    // headroom NeedAuth having already consumed the request-billing entry.
    const estimatedOutputImages = countOutputImages(responseStats.unitUsage);
    if (estimatedOutputImages > 0n) {
      if (byteEstimatedTokens) {
        // Byte estimates of an image response are base64 noise, not tokens.
        estimatedOutputTokens = 0n;
        estimatedInputTokens = 0n;
        estimatedCachedInputTokens = 0n;
      }
      estimatedOutputTokens += estimatedOutputImages * OUTPUT_IMAGE_TOKEN_EQUIVALENT;
      if (estimatedInputTokens <= 0n) {
        estimatedInputTokens = BigInt(requestBilling?.requestFacts.promptTokens ?? 0);
      }
    }

    // Determine the accepted cost for this request:
    // When the seller reports a cost within tolerance, accept the seller's claim so the
    // buyer doesn't underpay due to minor parsing differences. Only cap when the seller's
    // claim exceeds the tolerance threshold.
    let acceptedCost: bigint;
    if (responseStats.sellerClaimedCost != null && responseStats.sellerClaimedCost > 0n) {
      if (buyerEstimatedRequestCost > 0n) {
        const maxAcceptable = BigInt(Math.ceil(Number(buyerEstimatedRequestCost) * this._costTolerance));
        if (responseStats.sellerClaimedCost > maxAcceptable) {
          debugWarn(
            `[BuyerPayment] Seller claimed ${responseStats.sellerClaimedCost} exceeds ${this._costTolerance}x buyer estimate ${buyerEstimatedRequestCost} — capping at ${maxAcceptable}`,
          );
          acceptedCost = maxAcceptable;
        } else {
          // Seller's claim is within tolerance — accept it as-is
          acceptedCost = responseStats.sellerClaimedCost;
        }
      } else {
        // No buyer estimate available — accept seller's claim
        acceptedCost = responseStats.sellerClaimedCost;
      }
    } else {
      acceptedCost = buyerEstimatedRequestCost;
    }
    // If cost is 0, the cumulative amount stays the same — no spending auth needed
    // but we still sign one to keep the seller's session alive.

    // Advance cumulative amount by the accepted cost, then add overdraft headroom
    // for the next request (so the seller has budget to serve it).
    // maxSignable already caps at reserve ceiling, so one cap is sufficient
    const prevAmount = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    const previousVerifiedCost = this._verifiedCost.get(sellerPeerId) ?? 0n;
    const nextVerifiedCost = previousVerifiedCost + verifiedCostDelta;
    const maxSignable = this._maxSignableForVerified(sellerPeerId, nextVerifiedCost);
    let newAmount = prevAmount + acceptedCost;
    if (newAmount > maxSignable) newAmount = maxSignable;
    // A conservative recovery ceiling may temporarily be below an amount we
    // already signed. SpendingAuth is cumulative and must never move backward.
    if (newAmount < prevAmount) newAmount = prevAmount;
    const signedDelta = newAmount - prevAmount;

    // Update cumulative metadata. NeedAuth may have counted this response
    // first, so deduplicate the response's service amount and usage together.
    const alreadyCounted = this._serviceTokensCounted.has(responseStats.requestId);
    const newMeta = this._advanceUsageMetadata(
      this._metadata.get(sellerPeerId),
      responseStats.service,
      normalizeRequestUsageDelta({
        amount: signedDelta,
        inputTokens: estimatedInputTokens,
        cachedInputTokens: estimatedCachedInputTokens,
        outputTokens: estimatedOutputTokens,
        requests: 1n,
        outputImages: estimatedOutputImages,
      }, { deliveredResponse: true, alreadyCounted }),
    );
    debugLog(
      `[BuyerPayment] signPerRequestAuth #${newMeta.cumulativeRequestCount}: ` +
      `thisReq in=${estimatedInputTokens} out=${estimatedOutputTokens} | ` +
      `cumulative in=${newMeta.cumulativeInputTokens} out=${newMeta.cumulativeOutputTokens} | ` +
      `acceptedCost=${acceptedCost} cumulativeAmount=${newAmount}`,
    );

    // Compute metadata hash and encode metadata
    const metadataHashHex = computeMetadataHash(newMeta);
    const encodedMetadata = encodeMetadata(newMeta);

    // Sign EIP-712 SpendingAuth
    const channelsDomain = this._channelsDomain;
    const metadataMsg: SpendingAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount: newAmount,
      metadataHash: metadataHashHex,
    };
    const spendingAuthSig = await signSpendingAuth(this._signer, channelsDomain, metadataMsg);

    // Persist updated cumulative values to BuyerChannelStore
    await this._commitAuthorization({
      ...session,
      authMax: newAmount.toString(),
      requestCount: Number(newMeta.cumulativeRequestCount),
      latestBuyerSig: spendingAuthSig,
      latestSpendingAuthSig: spendingAuthSig,
      latestMetadata: encodedMetadata,
      updatedAt: Date.now(),
    }, newMeta);

    this._cumulativeAmount.set(sellerPeerId, newAmount);
    this._verifiedCost.set(sellerPeerId, nextVerifiedCost);
    this._metadata.set(sellerPeerId, newMeta);
    if (!alreadyCounted) this._serviceTokensCounted.mark(responseStats.requestId);
    this._reportSpend({
      sellerPeerId,
      requestId: responseStats.requestId ?? null,
      amountUsdc: signedDelta.toString(),
      inputTokens: (alreadyCounted ? 0n : estimatedInputTokens).toString(),
      cachedInputTokens: (alreadyCounted ? 0n : estimatedCachedInputTokens).toString(),
      outputTokens: (alreadyCounted ? 0n : estimatedOutputTokens).toString(),
      outputImages: (alreadyCounted ? 0n : estimatedOutputImages).toString(),
    });

    const payload: SpendingAuthPayload = {
      channelId: session.sessionId,
      cumulativeAmount: newAmount.toString(),
      metadataHash: metadataHashHex,
      metadata: encodedMetadata,
      spendingAuthSig,
    };

    const topUpNeeded = this._needsTopUp(sellerPeerId);

    return { payload, topUpNeeded };
  }

  // ── NeedAuth handler ───────────────────────────────────────────

  /**
   * Handle seller-initiated NeedAuth messages sent after every served request.
   * The seller includes the cost of the last request; the buyer validates it
   * against its own token count and signs a new SpendingAuth for the required
   * cumulative amount, capped at the reserve ceiling.
   */
  async handleNeedAuth(
    sellerPeerId: string,
    payload: NeedAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] NeedAuth for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    const requestBilling = payload.requestId ? this.getRequestBilling(payload.requestId) : undefined;
    const buyerService = requestBilling?.context.service
      ?? this._requestService.get(payload.requestId);
    const buyerBillingContext = requestBilling?.context;

    const requiredCumulativeAmount = BigInt(payload.requiredCumulativeAmount);
    const currentCumulative = this._cumulativeAmount.get(sellerPeerId) ?? 0n;

    // Reject stale/lower NeedAuth (monotonicity guard)
    if (requiredCumulativeAmount <= currentCumulative) {
      debugLog(
        `[BuyerPayment] NeedAuth stale: required=${requiredCumulativeAmount} <= current=${currentCumulative} — ignoring`,
      );
      return;
    }
    let acceptedServiceCost = 0n;
    let acceptedOutputImages = 0n;
    let verifiedCostDelta = 0n;
    const reportedInputTokens = BigInt(payload.inputTokens ?? '0');
    const reportedCachedInputTokens = BigInt(payload.cachedInputTokens ?? '0');
    const reportedOutputTokens = BigInt(payload.outputTokens ?? '0');

    const unitBillingModel = requestBilling?.unitModel;

    // Validate the seller's claimed cost if reported
    if (payload.billingUsage) {
      // Image billingUsage is surcharge evidence only. Token cost is still
      // recomputed from the token fields and service pricing below.
      try {
        const sellerTotalCost = BigInt(payload.lastRequestCost ?? '0');
        const sellerFreshExplicit = payload.freshInputTokens != null
          ? BigInt(payload.freshInputTokens)
          : null;
        const freshIn = sellerFreshExplicit ?? (reportedCachedInputTokens > 0n
          ? BigInt(Math.max(0, Number(reportedInputTokens) - Number(reportedCachedInputTokens)))
          : reportedInputTokens);
        const pricing = requestBilling?.tokenPricing ?? this.getSessionPricing(sellerPeerId, buyerService);
        const tokenEstimate = pricing
          ? computeCostUsdc(Number(freshIn), Number(reportedOutputTokens), pricing, Number(reportedCachedInputTokens))
          : 0n;
        let acceptedUnitCost = 0n;
        if (!requestBilling || !unitBillingModel) {
          if (sellerTotalCost > 0n) {
            throw new Error(
              "Positive unit billing cost is unverifiable without a unit billing model",
            );
          }
          debugLog(`[BuyerPayment] NeedAuth zero unit billing accepted without unit model`);
        } else {
          // The seller's NeedAuth can legitimately race ahead of the buyer's
          // own response processing (different muxes). Give the response path
          // a moment to record what was actually delivered before judging the
          // claim; a seller claiming delivery that never happens still gets
          // rejected once the wait expires.
          const observedUnitUsage = requestBilling.observedUnitUsage
            ?? (sellerTotalCost > 0n && payload.requestId
              ? await this._waitForObservedUnitUsage(payload.requestId, OBSERVED_UNIT_USAGE_WAIT_MS)
              : undefined);
          const claimedUnitCost = sellerTotalCost > tokenEstimate
            ? sellerTotalCost - tokenEstimate
            : 0n;
          acceptedUnitCost = validateUnitBillingUsage(
            unitBillingModel,
            requestBilling.context,
            payload.billingUsage,
            claimedUnitCost,
            this._costTolerance,
            observedUnitUsage,
          );
          acceptedOutputImages = countOutputImages(unitUsageFromReport(payload.billingUsage));
        }

        const buyerEstimate = tokenEstimate + acceptedUnitCost;
        if (sellerTotalCost > 0n && buyerEstimate <= 0n) {
          throw new Error("Positive NeedAuth total cost recomputed to zero");
        }
        const maxAcceptable = BigInt(Math.ceil(Number(buyerEstimate) * this._costTolerance));
        if (sellerTotalCost > maxAcceptable) {
          throw new Error(`Seller total cost ${sellerTotalCost} exceeds buyer estimate ${buyerEstimate}`);
        }
        acceptedServiceCost = sellerTotalCost;
        verifiedCostDelta += acceptedServiceCost;
        debugLog(
          `[BuyerPayment] NeedAuth hybrid billing: token=${tokenEstimate} unit=${acceptedUnitCost} sellerTotal=${sellerTotalCost} — validated`,
        );
      } catch (err) {
        debugWarn(`[BuyerPayment] NeedAuth billingUsage rejected: ${err instanceof Error ? err.message : err}`);
        return;
      }
    } else if (payload.lastRequestCost) {
      const sellerCost = BigInt(payload.lastRequestCost);
      if (sellerCost > 0n && unitBillingModel && buyerBillingContext?.serviceApiProtocol === 'openai-images') {
        debugWarn(
          `[BuyerPayment] NeedAuth rejected: positive unit cost omitted verifiable billingUsage`,
        );
        return;
      }
      const sellerIn = reportedInputTokens;
      const sellerOut = reportedOutputTokens;
      const sellerCached = reportedCachedInputTokens;
      acceptedServiceCost = sellerCost;
      // Prefer seller-supplied freshInputTokens to avoid OpenAI-vs-Anthropic
      // cached-semantics ambiguity (OpenAI: prompt_tokens includes cached;
      // Anthropic: input_tokens excludes cached). Fall back to OpenAI-style
      // subtraction for older sellers that don't emit the field.
      const sellerFreshExplicit = payload.freshInputTokens != null
        ? BigInt(payload.freshInputTokens)
        : null;

      // Use the buyer's own knowledge of which service it requested, not the seller's claim.
      // A malicious seller could set service to a more expensive model to inflate the ceiling.
      const pricing = requestBilling?.tokenPricing ?? this.getSessionPricing(sellerPeerId, buyerService);
      if (pricing && sellerCost > 0n) {
        const freshIn = sellerFreshExplicit ?? (sellerCached > 0n
          ? BigInt(Math.max(0, Number(sellerIn) - Number(sellerCached)))
          : sellerIn);
        const buyerEstimate = computeCostUsdc(Number(freshIn), Number(sellerOut), pricing, Number(sellerCached));
        const maxAcceptable = BigInt(Math.ceil(Number(buyerEstimate) * this._costTolerance));
        if (buyerEstimate <= 0n && sellerCost > 0n && buyerBillingContext?.serviceApiProtocol === 'openai-images') {
          debugWarn(
            `[BuyerPayment] NeedAuth rejected: positive unit cost recomputed to zero`,
          );
          return;
        }
        if (buyerEstimate > 0n && sellerCost > maxAcceptable) {
          debugWarn(
            `[BuyerPayment] NeedAuth: seller claimed cost ${sellerCost} exceeds ${this._costTolerance}x buyer estimate ${buyerEstimate} — rejecting`,
          );
          return;
        }
        debugLog(
          `[BuyerPayment] NeedAuth: seller cost=${sellerCost} buyer estimate=${buyerEstimate} (in=${sellerIn} cached=${sellerCached} out=${sellerOut}) — validated`,
        );
      } else {
        debugLog(
          `[BuyerPayment] NeedAuth: seller cost=${sellerCost} (no local pricing, accepting)`,
        );
      }

      // Accumulate verified cost from the seller's report
      verifiedCostDelta += sellerCost;
    }

    // Cap at overdraft limit: verifiedCost + maxPerRequestUsdc, then at reserve ceiling.
    // This prevents a malicious seller from claiming a small cost but requesting the full reserve.
    const previousVerifiedCost = this._verifiedCost.get(sellerPeerId) ?? 0n;
    let nextVerifiedCost = previousVerifiedCost + verifiedCostDelta;
    let maxSignable = this._maxSignableForVerified(sellerPeerId, nextVerifiedCost);
    const ceiling = this._getCeiling(sellerPeerId);
    let needsTopUp = this._needsCeilingAdvance(requiredCumulativeAmount, maxSignable, ceiling);
    if (maxSignable <= currentCumulative && !needsTopUp) {
      const reopened = this._reopenOverdraftWindowIfCollapsed(
        sellerPeerId,
        currentCumulative,
        maxSignable,
        'handleNeedAuth',
        nextVerifiedCost,
      );
      maxSignable = reopened.maxSignable;
      nextVerifiedCost = reopened.verifiedCost;
      needsTopUp = this._needsCeilingAdvance(requiredCumulativeAmount, maxSignable, ceiling);
      if (maxSignable <= currentCumulative && !needsTopUp) {
        debugWarn(
          `[BuyerPayment] NeedAuth: maxSignable=${maxSignable} <= currentCumulative=${currentCumulative} — overdraft limit reached`,
        );
        return;
      }
    }

    // When a topUp is needed, first sign at the current ceiling so the seller
    // has a high-enough settled amount to pass the on-chain TopUpThresholdNotMet
    // check (contract requires 85% of deposit to be settleable before topUp).
    // We cap at the old ceiling here; the topUp is sent AFTER so the seller
    // processes the SpendingAuth first, then the topUp with adequate settle amount.
    const effectiveAmount = needsTopUp
      ? (maxSignable > currentCumulative ? maxSignable : currentCumulative)
      : (requiredCumulativeAmount < maxSignable ? requiredCumulativeAmount : maxSignable);
    if (effectiveAmount <= currentCumulative) {
      // Nothing to sign — trigger topUp anyway to extend ceiling for next round
      if (needsTopUp) {
        await this._topUpAfterSpendAuthBestEffort(sellerPeerId, paymentMux, 'handleNeedAuth');
      }
      debugWarn(
        `[BuyerPayment] NeedAuth: effectiveAmount=${effectiveAmount} <= currentCumulative=${currentCumulative} — cannot advance`,
      );
      return;
    }

    debugLog(`[BuyerPayment] NeedAuth: channel=${session.sessionId.slice(0, 18)}... required=${requiredCumulativeAmount} effective=${effectiveAmount}`);

    // Only NeedAuth frames with response cost/usage evidence represent a
    // completed request. Budget-exhausted/headroom frames can advance the
    // channel authorization, but must not increment request or token usage.
    const deliveredResponse = payload.lastRequestCost != null || payload.billingUsage != null;
    const signedDelta = effectiveAmount - currentCumulative;
    const serviceAmountDelta = acceptedServiceCost > 0n
      ? (acceptedServiceCost < signedDelta ? acceptedServiceCost : signedDelta)
      : 0n;
    // If post-response signing counted this response first, deduplicate the
    // response's service amount and usage together.
    const alreadyCounted = this._serviceTokensCounted.has(payload.requestId);
    // Attribution only — never cost; mirrors signPerRequestAuth.
    let attributedInputTokens = reportedInputTokens;
    let attributedOutputTokens = reportedOutputTokens;
    if (acceptedOutputImages > 0n) {
      attributedOutputTokens += acceptedOutputImages * OUTPUT_IMAGE_TOKEN_EQUIVALENT;
      if (attributedInputTokens <= 0n) {
        attributedInputTokens = BigInt(requestBilling?.requestFacts.promptTokens ?? 0);
      }
    }
    const newMeta = this._advanceUsageMetadata(
      this._metadata.get(sellerPeerId),
      buyerService,
      normalizeRequestUsageDelta({
        amount: serviceAmountDelta,
        inputTokens: attributedInputTokens,
        cachedInputTokens: reportedCachedInputTokens,
        outputTokens: attributedOutputTokens,
        requests: 1n,
        outputImages: acceptedOutputImages,
      }, { deliveredResponse, alreadyCounted }),
    );
    // Persistence and transport failures must propagate to the connection
    // owner. In particular, swallowing an IndexedDB failure leaves the browser
    // connected with advanced in-memory counters but no durable signature.
    const spendingAuth = await this._commitUpdatedSpendingAuth(
      session,
      sellerPeerId,
      effectiveAmount,
      newMeta,
    );
    this._verifiedCost.set(sellerPeerId, nextVerifiedCost);
    this._metadata.set(sellerPeerId, newMeta);
    if (deliveredResponse && !alreadyCounted) this._serviceTokensCounted.mark(payload.requestId);
    this._reportSpend({
      sellerPeerId,
      requestId: payload.requestId ?? null,
      amountUsdc: signedDelta.toString(),
      inputTokens: (deliveredResponse && !alreadyCounted ? attributedInputTokens : 0n).toString(),
      cachedInputTokens: (deliveredResponse && !alreadyCounted ? reportedCachedInputTokens : 0n).toString(),
      outputTokens: (deliveredResponse && !alreadyCounted ? attributedOutputTokens : 0n).toString(),
      outputImages: (deliveredResponse && !alreadyCounted ? acceptedOutputImages : 0n).toString(),
    });
    paymentMux.sendSpendingAuth(spendingAuth);
    debugLog(`[BuyerPayment] NeedAuth responded: new cumulativeAmount=${effectiveAmount}`);

    // Send topUp AFTER the SpendingAuth so the seller processes the higher
    // cumulative first — this ensures the on-chain settle amount meets the
    // contract's TopUpThresholdNotMet requirement (85% of deposit must be
    // settleable before topUp is allowed). Also proactively send the top-up
    // once the signed cumulative reaches the buyer's remaining-headroom
    // threshold; the seller may defer it until the contract gate is satisfied.
    if (needsTopUp || this._needsTopUp(sellerPeerId)) {
      await this._topUpAfterSpendAuthBestEffort(sellerPeerId, paymentMux, 'handleNeedAuth');
    }
    if (payload.requestId) {
      this.clearRequestBilling(payload.requestId);
    }
  }

  // ── Reserve top-up ─────────────────────────────────────────────

  /**
   * Sign a new ReserveAuth with a higher maxAmount to extend the session's reserve ceiling.
   * The seller must call reserve() on-chain again with the new signature.
   * Note: requires contract support for top-up (increaseDeposit on existing channelId).
   */
  async topUpReserve(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] topUpReserve: no active session for ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    const prevCeiling = this._getCeiling(sellerPeerId);
    const newCeiling = prevCeiling + this._config.maxReserveAmountUsdc;
    const additionalReserve = newCeiling - prevCeiling;
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;

    try {
      const balance = await this.getBalance();
      if (balance.available < additionalReserve) {
        throw buyerFault(
          `Insufficient buyer deposits for reserve top-up: available=${balance.available} required=${additionalReserve}`,
          'buyer-deposits-insufficient',
        );
      }
    } catch (err) {
      if (faultCodeOf(err) === 'buyer-deposits-insufficient') {
        throw err;
      }
      debugWarn(
        `[BuyerPayment] topUpReserve: unable to verify buyer deposits before signing top-up: ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }

    debugLog(`[BuyerPayment] topUpReserve: channel=${session.sessionId.slice(0, 18)}... ceiling ${prevCeiling} → ${newCeiling}`);

    // Sign ReserveAuth with new maxAmount
    const channelsDomain = this._channelsDomain;
    const reserveMsg: ReserveAuthMessage = {
      channelId: session.sessionId,
      maxAmount: newCeiling,
      deadline: BigInt(deadline),
    };
    const reserveAuthSig = await signReserveAuth(this._signer, channelsDomain, reserveMsg);

    const currentCumulative = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    const salt = this._reserveSalt.get(sellerPeerId) ?? '0x' + '00'.repeat(32);
    const pending: PendingReserveAuthorization = {
      signature: reserveAuthSig,
      salt,
      maxAmount: newCeiling,
      deadline,
      confirmedAmount: prevCeiling,
    };

    // Send ReserveAuth sig with reserve fields (same pattern as initial authorizeSpending).
    // The seller uses this to call topUp() on-chain with the new maxAmount.
    await this._commitAndSendReserveAuth(session, sellerPeerId, pending, paymentMux, {
      cumulativeAmount: currentCumulative.toString(),
      initialReserveAmount: session.initialReserveAmount ?? prevCeiling.toString(),
    });
    debugLog(`[BuyerPayment] topUpReserve sent: newCeiling=${newCeiling}`);
  }

  // ── Queries ───────────────────────────────────────────────────

  /** Max USDC overdraft (unverified exposure) from buyer config. */
  get maxPerRequestUsdc(): bigint {
    return this._config.maxPerRequestUsdc;
  }

  /** Max USDC per ReserveAuth signature from buyer config. */
  get maxReserveAmountUsdc(): bigint {
    return this._config.maxReserveAmountUsdc;
  }

  /** Current buyer-verified cost for a seller. */
  getVerifiedCost(sellerPeerId: string): bigint {
    return this._verifiedCost.get(sellerPeerId) ?? 0n;
  }

  /** Current reserve ceiling for a seller (may be higher than initial after top-ups). */
  getReserveCeiling(sellerPeerId: string): bigint {
    return this._currentReserveCeiling.get(sellerPeerId) ?? this._config.maxReserveAmountUsdc;
  }

  /** Current cumulative signed amount for a seller. */
  getCumulativeAmount(sellerPeerId: string): bigint {
    return this._cumulativeAmount.get(sellerPeerId) ?? 0n;
  }

  /** Live cumulative token counts for a seller (in-memory, always up-to-date). */
  getCumulativeTokens(sellerPeerId: string): { inputTokens: bigint; outputTokens: bigint } {
    const meta = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    return { inputTokens: meta.cumulativeInputTokens, outputTokens: meta.cumulativeOutputTokens };
  }

  /**
   * Accumulate response token counts and persist to the channel store.
   * Tracks its own running totals independently of signPerRequestAuth metadata,
   * so the persisted data is always up-to-date after each response.
   */
  recordAndPersistTokens(sellerPeerId: string, inputTokens: number, outputTokens: number): void {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) return;

    const prev = this._responseTokenTotals.get(sellerPeerId) ?? {
      input: Number(session.tokensDelivered),
      output: Number(session.previousConsumption),
      requests: session.requestCount,
    };
    debugLog(
      `[BuyerPayment] recordTokens: thisReq in=${inputTokens} out=${outputTokens} | ` +
      `prevTotal in=${prev.input} out=${prev.output} reqs=${prev.requests}`,
    );
    const totals = {
      input: prev.input + inputTokens,
      output: prev.output + outputTokens,
      requests: prev.requests + 1,
    };
    this._responseTokenTotals.set(sellerPeerId, totals);

    this._channelStore.upsertChannel({
      ...session,
      tokensDelivered: String(totals.input),
      previousConsumption: String(totals.output),
      requestCount: totals.requests,
      updatedAt: Date.now(),
    });
  }

  /** Register which service the buyer requested for a given requestId. */
  trackRequestService(requestId: string, service: string): void {
    this._requestService.track(requestId, service);
  }

  trackRequestBilling(requestId: string, entry: BuyerRequestBillingEntry): void {
    this._cleanupRequestBillingCache();
    this._requestService.track(requestId, entry.context.service);
    this._requestBillingEntries.set(requestId, {
      ...entry,
      createdAtMs: Date.now(),
    });
    this._trimRequestBillingCache();
  }

  /** Record unit usage extracted from the response the buyer received, so
   *  NeedAuth validation can cap seller claims at what was actually delivered. */
  recordObservedUnitUsage(requestId: string, usage: UnitBillingUsage): void {
    const entry = this._requestBillingEntries.get(requestId);
    if (entry) entry.observedUnitUsage = usage;
    const waiters = this._observedUsageWaiters.get(requestId);
    if (waiters) {
      this._observedUsageWaiters.delete(requestId);
      for (const waiter of waiters) waiter(usage);
    }
  }

  /** Wait for observed unit usage while the buyer's response path catches up. */
  private _waitForObservedUnitUsage(
    requestId: string,
    timeoutMs: number,
  ): Promise<UnitBillingUsage | undefined> {
    const existing = this._requestBillingEntries.get(requestId)?.observedUnitUsage;
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const onUsage = (usage: UnitBillingUsage): void => {
        clearTimeout(timer);
        resolve(usage);
      };
      const timer = setTimeout(() => {
        const waiters = this._observedUsageWaiters.get(requestId);
        if (waiters) {
          const index = waiters.indexOf(onUsage);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) this._observedUsageWaiters.delete(requestId);
        }
        resolve(this._requestBillingEntries.get(requestId)?.observedUnitUsage);
      }, timeoutMs);
      timer.unref?.();
      const waiters = this._observedUsageWaiters.get(requestId) ?? [];
      waiters.push(onUsage);
      this._observedUsageWaiters.set(requestId, waiters);
    });
  }

  getRequestBilling(requestId: string): BuyerRequestBillingEntry | undefined {
    this._cleanupRequestBillingCache();
    const entry = this._requestBillingEntries.get(requestId);
    if (!entry) return undefined;
    const { createdAtMs: _createdAtMs, ...publicEntry } = entry;
    return publicEntry;
  }

  clearRequestBilling(requestId: string): void {
    this._requestBillingEntries.delete(requestId);
    this._requestService.take(requestId);
  }

  trackRequestBillingContext(requestId: string, context: UnitBillingContext): void {
    this.trackRequestBilling(requestId, {
      context,
      requestFacts: {},
    });
  }

  /** Get the live response token totals for a seller, or null if none recorded this session. */
  getResponseTokenTotals(sellerPeerId: string): { input: number; output: number; requests: number } | null {
    return this._responseTokenTotals.get(sellerPeerId) ?? null;
  }

  /** Get the session pricing for a seller+service. Resolves service-specific pricing first, then defaults. */
  getSessionPricing(sellerPeerId: string, service?: string): ServicePricing | null {
    const map = this._sessionPricing.get(sellerPeerId);
    if (!map) return null;
    if (service) {
      const servicePricing = map.services[service];
      if (servicePricing) return servicePricing;
    }
    return map.defaults;
  }

  /** Check if a session has been confirmed via AuthAck. */
  isAuthorized(sellerPeerId: string): boolean {
    return this._confirmedPeers.has(sellerPeerId);
  }

  /** Alias for isAuthorized (used by polling loop). */
  isLockConfirmed(sellerPeerId: string): boolean {
    return this.isAuthorized(sellerPeerId);
  }

  /** Check if the lock was explicitly rejected (not just never-contacted). */
  isLockRejected(sellerPeerId: string): boolean {
    return this._rejectedPeers.has(sellerPeerId);
  }

  /** Mark a peer as having rejected our spending auth. */
  markRejected(sellerPeerId: string): void {
    this._rejectedPeers.add(sellerPeerId);
    debugLog(`[BuyerPayment] Peer ${sellerPeerId.slice(0, 12)}... marked as rejected`);
  }

  getSessionHistory(sellerPeerId: string): StoredChannel[] {
    const session = this._channelStore.getLatestChannelByPeerAndBuyer(
      sellerPeerId,
      'buyer',
      this._identity.wallet.address,
    );
    return session ? [session] : [];
  }

  // ── Deposit operations ──────────────────────────────────────────

  async deposit(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Depositing ${amount} to deposits`);
    const buyer = this._identity.wallet.address;
    return this._depositsClient.deposit(this._signer, buyer, amount);
  }

  async withdraw(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Withdrawing ${amount} from deposits`);
    return this._depositsClient.withdraw(this._signer, this._identity.wallet.address, amount);
  }

  async getBalance(): Promise<{ available: bigint; reserved: bigint }> {
    const buyerAddr = this._identity.wallet.address;
    const info = await this._depositsClient.getBuyerBalance(buyerAddr);
    return { available: info.available, reserved: info.reserved };
  }

  // parseResponseCost removed — cost data now flows through NeedAuth on PaymentMux.
}
