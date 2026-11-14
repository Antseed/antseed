import { hexlify, randomBytes } from 'ethers';
import { type AbstractSigner } from 'ethers';
import type { BuyerIdentity } from './interfaces.js';
import type { PaymentMux } from './payment-mux.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  NeedAuthPayload,
  CloseChannelRequestPayload,
  OneOffChannelPlan,
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
  boundServiceMetadata,
} from '@antseed/protocol/signatures';
import type { SpendingAuthMessage, SpendingAuthMetadata } from '@antseed/protocol/signatures';
import { decodeWorkerTail, MAX_WORKERS_PER_CHANNEL, withWorkerAttribution } from '@antseed/protocol/worker-attribution';
import { debugLog, debugWarn } from './debug.js';
import { peerIdToAddress, type PeerId } from '@antseed/protocol/peer-id';
import type { SellerAddressResolver } from './seller-address-resolver.js';
import type { PeerMetadata } from '@antseed/protocol/peer-metadata';
import { BuyerChannelStore, CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS, type StoredChannel } from './channel-store-types.js';
import {
  advanceUsageMetadata,
  normalizeRequestUsageDelta,
  RequestServiceTracker,
} from './channel-usage-accounting.js';
import {
  estimateCostFromBytes,
  computeCostUsdc,
  computeUsageCostUsdc,
  type ServicePricing,
} from './pricing.js';
import type { UnitBillingContext, UnitBillingModelV1, UnitBillingUnitV1, UnitBillingUsage } from '@antseed/protocol/billing';
import type { BillingRequestFacts } from './unit-billing.js';
import { evaluateUnitBilling, unitUsageFromReport, validateUnitBillingUsage } from '@antseed/protocol/billing';
import { isUnitBilledProtocol, nativeVideoUnitUsage } from './unit-billing.js';
import { buyerFault, faultCodeOf } from './errors.js';
import type { WorkerUsage } from './worker-e2e.js';
import { WorkerDeliveryTracker, type WorkerDelivery } from './worker-delivery-tracker.js';

/** Default tolerance: accept seller claims up to 1.4x buyer's estimate. */
const DEFAULT_COST_TOLERANCE = 1.4;
/** Remaining headroom that triggers the first top-up (35% of the initial reserve). */
const INITIAL_TOPUP_HEADROOM_PERCENT = 35n;
/** Fixed remaining headroom that triggers every later top-up ($0.50). */
const SUBSEQUENT_TOPUP_HEADROOM_USDC = 500_000n;
const PERCENT_DENOMINATOR = 100n;
/**
 * Paid requests still in flight cost about the channel's average request
 * each, and are charged after they finish: keep twice that much headroom so
 * a top-up lands before the work in flight passes the locked reserve.
 */
const IN_FLIGHT_HEADROOM_FACTOR = 2n;
/** Largest load-sized top-up, in multiples of the configured reserve step. */
const MAX_LOAD_TOPUP_MULTIPLE = 10n;
/** Default max price of one video generation ($5.00). */
export const DEFAULT_MAX_VIDEO_REQUEST_USDC = 5_000_000n;
const REQUEST_BILLING_TTL_MS = 5 * 60_000;
/** How long and how many allowance-covered requests are remembered, so a late NeedAuth for one is still refused. */
const COVERED_REQUEST_TTL_MS = 60 * 60_000;
const MAX_COVERED_REQUESTS = 10_000;
const coveredRequestKey = (sellerPeerId: string, requestId: string): string => `${sellerPeerId.toLowerCase()}\n${requestId}`;
/** Accepted video jobs awaiting delivery are remembered this long (matches job routes). */
const VIDEO_JOB_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_VIDEO_JOBS = 1_000;
const MAX_REQUEST_BILLING_ENTRIES = 512;
/** How long NeedAuth validation waits for the buyer's own response processing
 *  to record delivered unit usage before rejecting a positive claim. */
const OBSERVED_UNIT_USAGE_WAIT_MS = 5_000;
/** How long a NeedAuth for a colony-pool request waits for the buyer to verify the worker's sealed answer. */
const WORKER_DELIVERY_WAIT_MS = 15_000;
/**
 * Whole units of `unit` in `usage`, never negative. Speech billing reports no
 * `input_characters` for undelivered audio.
 */
function countUnits(usage: UnitBillingUsage | undefined, unit: UnitBillingUnitV1): bigint {
  return BigInt(Math.max(0, Math.floor(usage?.units[unit] ?? 0)));
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
  /**
   * Max price of one video generation the buyer will pay for (base units).
   * Default: 5000000 ($5.00).
   */
  maxVideoRequestUsdc?: bigint;
  /** Max ratio of seller-claimed cost to buyer's bytes/4 estimate. Default: 1.4. */
  costToleranceMultiplier?: number;
  /** Disable per-service attribution in metadata v2. Default: false. */
  disableMetadataV2Services?: boolean;
  dataDir: string;
}

/** A wire cost that is a positive integer; malformed values are judged later, where they are caught. */
/** Why a NeedAuth for a colony-pool request must not be signed, or null when it may be judged as usual. */
function workerDeliveryProblem(
  delivery: WorkerDelivery,
  payload: NeedAuthPayload,
  pricing: ServicePricing | null | undefined,
  unitBilled: boolean,
): string | null {
  // Before anything is priced: a request sent free owes nothing, whatever the session's paid pricing says.
  if (delivery.free && (hasPositiveCost(payload.lastRequestCost) || payload.billingUsage != null)) {
    return 'it was sent as a free request, so its answer owes nothing';
  }
  if (delivery.state === 'pending') return 'the worker\'s answer was not verified in time';
  if (delivery.state === 'failed' || !delivery.usage) return 'the worker\'s answer did not verify';
  const usage = delivery.usage;
  const input = BigInt(payload.inputTokens ?? '0');
  const cached = BigInt(payload.cachedInputTokens ?? '0');
  const output = BigInt(payload.outputTokens ?? '0');
  // The fresh count the cost checks below price, derived the same way they derive it.
  const fresh = payload.freshInputTokens != null
    ? BigInt(payload.freshInputTokens)
    : cached > 0n ? (input > cached ? input - cached : 0n) : input;
  const authenticatedFresh = usage.inputTokens - usage.cachedInputTokens;
  // Each priced component on its own: moving cached input to fresh (or
  // inflating either) would raise the price without raising the total.
  if (
    input > usage.inputTokens || fresh > authenticatedFresh
    || cached > usage.cachedInputTokens || output > usage.outputTokens
  ) {
    return `billed tokens (in=${input} fresh=${fresh} cached=${cached} out=${output}) exceed the worker's authenticated usage `
      + `(in=${usage.inputTokens} fresh=${authenticatedFresh} cached=${usage.cachedInputTokens} out=${usage.outputTokens})`;
  }
  // A token-billed request's cost is capped by the authenticated usage itself,
  // without the tolerance an estimate gets. Unit-billed costs are judged as usual.
  if (pricing && !unitBilled && payload.lastRequestCost != null) {
    const allowed = computeCostUsdc(
      Number(authenticatedFresh), Number(usage.outputTokens), pricing, Number(usage.cachedInputTokens),
    );
    if (BigInt(payload.lastRequestCost) > allowed) {
      return `billed cost ${payload.lastRequestCost} exceeds ${allowed} for the worker's authenticated usage`;
    }
  }
  return null;
}

function hasPositiveCost(cost: string | undefined): boolean {
  try {
    return BigInt(cost ?? '0') > 0n;
  } catch {
    return false;
  }
}

/**
 * Run `run` after everything queued under `key` has finished, whether it
 * succeeded or not. The queue entry removes itself once it is the last.
 */
function runQueued<T>(queues: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** What the buyer saw of a served response, for signPerRequestAuth. */
export type PerRequestResponseStats = {
  inputBytes: Uint8Array;
  outputBytes: Uint8Array;
  sellerClaimedCost?: bigint;
  reportedInputTokens?: bigint;
  reportedOutputTokens?: bigint;
  reportedCachedInputTokens?: bigint;
  unitUsage?: UnitBillingUsage;
  service?: string;
  requestId?: string;
};

/** What the buyer made of a seller's answer to a paid request. */
export interface DeliveredResponse {
  /**
   * The buyer's own cost for the response: the usage in the response it
   * received, at the pricing it agreed to. For an attempt the caller aborted,
   * the most the seller may bill for it instead: its prompt plus the output it
   * allows. 0 when nothing verifies what the seller bills: the attempt timed
   * out, its connection closed, or the buyer cannot price it.
   */
  costUsdc: bigint;
  /** The attempt ended after it was sent, with no answer. */
  cutOff?: boolean;
  /** Its cost is counted already (no claim can count it again); only its usage is still to be attributed. */
  costCounted?: boolean;
  /** A received response's service and usage, attributed to it if the buyer's signing before a close pays it. */
  service?: string;
  usage?: { inputTokens: bigint; cachedInputTokens: bigint; outputTokens: bigint; unitUsage?: UnitBillingUsage };
}

/** Result of signPerRequestAuth — includes the payload and whether a reserve top-up is needed. */
export interface PerRequestAuthResult {
  payload: SpendingAuthPayload;
  topUpNeeded: boolean;
}

export interface BuyerRequestBillingEntry {
  context: UnitBillingContext;
  /** Absent for requests tracked only for attribution (no unit billing). */
  requestFacts?: BillingRequestFacts;
  unitModel?: UnitBillingModelV1;
  tokenPricing?: ServicePricing;
  observedUnitUsage?: UnitBillingUsage;
  /** Buyer-computed price of a video create, from the seller's advertised unit pricing. */
  estimatedCostUsdc?: bigint;
}

interface StoredBuyerRequestBillingEntry extends BuyerRequestBillingEntry {
  createdAtMs: number;
  /** Video jobs only: the one-off channel that pays for the job. */
  oneOffChannelId?: string;
  /** A video retrieve the buyer did not take as the job's delivery: no NeedAuth for it waits for one. */
  notDelivered?: boolean;
}

/** Identity of a not-yet-opened buyer channel: fresh salt, derived channelId, auth deadline. */
interface NewChannelTerms {
  sellerPeerId: string;
  sellerEvmAddr: string;
  buyerEvmAddr: string;
  salt: string;
  channelId: string;
  deadline: number;
}

/** In-memory state of a buyer one-off channel (one video). */
/** An accepted video job as stored on its one-off channel row. */
interface PersistedVideoJob {
  protocol: string;
  jobId: string;
  createdAtMs: number;
  entry: BuyerRequestBillingEntry;
}

interface OneOffChannelState {
  sellerPeerId: string;
  requestId: string;
  /** The video price: the only amount this channel will ever be asked for. */
  price: bigint;
  cumulative: bigint;
  confirmed: boolean;
  ackWaiters: Array<(confirmed: boolean) => void>;
}

interface PendingReserveAuthorization {
  signature: string;
  salt: string;
  maxAmount: bigint;
  deadline: number;
  confirmedAmount: bigint;
}

/**
 * How committing a signed SpendingAuth ended. `superseded`: a concurrent write
 * committed a higher cumulative while this one was signed, so nothing was
 * written and its target is already met. `retired`: the channel stopped being
 * live, before the write or during it.
 */
type CommitOutcome = 'committed' | 'superseded' | 'retired';
type DroppedCommit = Exclude<CommitOutcome, 'committed'>;

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

  /** sellerPeerId -> the highest cumulative the seller reported accepting on the active channel */
  private readonly _sellerAccepted = new Map<string, { channelId: string; amount: bigint }>();

  /** sellerPeerId -> cumulative metadata for SpendingAuth */
  private readonly _metadata = new Map<string, SpendingAuthMetadata>();

  /** sellerPeerId -> buyer-verified cumulative cost from bytes/4 */
  private readonly _verifiedCost = new Map<string, bigint>();
  /** sellerPeerId -> paid requests dispatched and not yet answered */
  private readonly _inFlightPaidRequests = new Map<string, number>();
  /** Per seller: the tail of the queue of reserve top-ups (see topUpReserve). */
  private readonly _topUpLocks = new Map<string, Promise<unknown>>();
  /** Per seller: top-ups queued or running, so one that waited can tell. */
  private readonly _topUpsQueued = new Map<string, number>();
  /** Reads a channel's locked deposit on-chain (set by the negotiator when it has a channels client). */
  private _readChannelDeposit: ((channelId: string) => Promise<bigint>) | null = null;
  /**
   * Per seller: the tail of the queue of signing steps. Reading the signed
   * amount and verified cost, signing and committing happen one at a time
   * per seller, so concurrent requests can neither lose a cost nor commit a
   * lower cumulative after a higher one.
   */
  private readonly _sellerLocks = new Map<string, Promise<unknown>>();

  /** requestId -> service/model the buyer requested (from its own request body).
   *  Used in handleNeedAuth to validate cost with the correct pricing tier
   *  without trusting the seller's claim of which service was used. */
  private readonly _requestService = new RequestServiceTracker();
  /** Colony-pool requests and their worker deliveries, for the node's lifetime (see WorkerDeliveryTracker). */
  // A verified worker request is kept while it is still owed: recorded but not
  // counted yet, or counted with credit its worker has not been signed yet.
  private readonly _workerDeliveries: WorkerDeliveryTracker = new WorkerDeliveryTracker((requestId: string): boolean => {
    const seller = this._workerDeliveries.get(requestId)?.sellerPeerId;
    return seller != null && (this._requestLedgers.get(seller)?.has(requestId) === true
      || this._workerCreditDue.get(seller)?.has(requestId) === true);
  });
  /**
   * requestId -> trusted buyer-owned billing identity, request facts, and mode.
   *
   * Used by NeedAuth validation so seller-reported billingUsage cannot choose
   * the provider, protocol, service, billing model, or size/quality tier after
   * the fact.
   */
  private readonly _requestBillingEntries = new Map<string, StoredBuyerRequestBillingEntry>();
  /**
   * Requests a seller served from a priced service's free allowance, with when
   * they were marked. Nothing is owed for them, so a NeedAuth naming one is refused.
   */
  private readonly _coveredRequests = new Map<string, number>();
  /**
   * sellerPeerId -> requestId -> what the seller can still be paid for on the
   * active channel: a response the buyer received and priced, or an attempt it
   * cut off. Counting a request toward verified cost removes it, and a request
   * with no entry is owed nothing. Only the buyer's own request path adds
   * entries, and the map is dropped with the seller's verified cost.
   */
  private readonly _requestLedgers = new Map<string, Map<string, DeliveredResponse>>();
  /**
   * sellerPeerId -> requestId -> the part of a verified worker answer's
   * counted cost not yet credited to its worker in a signed SpendingAuth,
   * oldest first. Every signed advance pays these down (_creditWorkers), so a
   * worker is credited even when its answer's cost was counted without being
   * signed at once (the reserve ceiling, a 402 reopen). Dropped with the
   * request records.
   */
  private readonly _workerCreditDue = new Map<string, Map<string, bigint>>();
  private readonly _observedUsageWaiters = new Map<string, Array<(usage: UnitBillingUsage | undefined) => void>>();

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
  /**
   * `${sellerPeerId}\n${protocol}\n${jobId}` -> billing of an accepted video
   * that has not been delivered yet. Its price is signed only after the buyer
   * receives the finished video.
   */
  private readonly _videoJobs = new Map<string, StoredBuyerRequestBillingEntry>();
  /** Delivered jobs whose stored copy could not be cleared yet, by job key: their one-off channel. */
  private readonly _unsavedVideoDeliveries = new Map<string, string>();
  /** One-off channels keyed by channelId. Never a seller's session channel. */
  private readonly _oneOffChannels = new Map<string, OneOffChannelState>();

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

    for (const channel of this._channelStore.getActiveChannelsByBuyer(
      CHANNEL_ROLE.BUYER,
      this._identity.wallet.address,
      CHANNEL_KIND.ONE_OFF,
    )) {
      if (!channel.oneOffRequestId) continue;
      this._oneOffChannels.set(channel.sessionId, {
        sellerPeerId: channel.peerId,
        requestId: channel.oneOffRequestId,
        price: BigInt(channel.reserveMaxAmount ?? '0'),
        cumulative: BigInt(channel.authMax || '0'),
        confirmed: channel.reserveAuthPending !== true,
        ackWaiters: [],
      });
      this._restoreVideoJob(channel);
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
    const stored = this._channelStore.getChannelMetadata(channel);
    // Worker attribution lives only in the signed metadata bytes, not in store columns.
    const workers = channel.latestMetadata ? decodeWorkerTail(channel.latestMetadata) : null;
    const metadata = this._sanitizeMetadata(workers ? { ...stored, workers } : stored);
    this._metadata.set(peerId, metadata);
    if (persistServiceMetadata && !this._disableMetadataV2Services) {
      this._persistServiceMetadata(channel.sessionId, metadata);
    }
    // Hydrate verifiedCost to authMax so _maxSignable can grow beyond maxPerRequestUsdc.
    // Without this, maxSignable = 0 + maxPerRequestUsdc after restart, permanently capping
    // the cumulative and causing non-monotonic SpendingAuth rejections on the seller.
    this._verifiedCost.set(peerId, persistedCumulative);
    this._dropRequestRecords(peerId);
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

  /**
   * A video's price is fixed by the seller's advertised unit pricing, known
   * before the job starts and reported to callers as its price: it is paid
   * exactly, never with the tolerance that covers token estimates.
   */
  private _costToleranceFor(billing: BuyerRequestBillingEntry | undefined | null): number {
    return billing?.requestFacts?.kind === 'video' ? 1 : this._costTolerance;
  }

  private get _disableMetadataV2Services(): boolean {
    return this._config.disableMetadataV2Services === true;
  }

  private _sanitizeMetadata(metadata: SpendingAuthMetadata | undefined): SpendingAuthMetadata {
    const current = metadata ?? ZERO_METADATA;
    // Bounds service lists persisted before MAX_METADATA_SERVICES existed, so a
    // channel whose SpendingAuth outgrew the payment frame can be signed again.
    if (!this._disableMetadataV2Services) return boundServiceMetadata(current);
    return {
      cumulativeInputTokens: current.cumulativeInputTokens,
      cumulativeOutputTokens: current.cumulativeOutputTokens,
      cumulativeRequestCount: current.cumulativeRequestCount,
      cumulativeOutputImages: current.cumulativeOutputImages ?? 0n,
      cumulativeVideoGenerations: current.cumulativeVideoGenerations ?? 0n,
      cumulativeVideoSeconds: current.cumulativeVideoSeconds ?? 0n,
      cumulativeInputCharacters: current.cumulativeInputCharacters ?? 0n,
      services: [],
      ...(current.workers ? { workers: current.workers } : {}),
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

  /**
   * `metadata` with the worker credit a SpendingAuth signing `signedDelta`
   * more pays, once the verified worker answers it counts (`counted`, with
   * their cost) join what the seller's workers are still owed; oldest first.
   * The advance may also pay the seller's own requests, so a worker is
   * credited at most its answers' counted cost, and never more than is signed.
   *
   * With `signedCumulative` (the amount the SpendingAuth signs), signed money
   * no counted cost has used yet (headroom a seller prompt or a top-up signed
   * ahead) pays workers too, even when the amount does not grow: the auth is
   * re-signed at the same amount with the worker in its tail. What is
   * allocated is every cost counted before this auth, less what workers are
   * still owed, so attribution never exceeds the signed amount.
   *
   * Commit the returned `due` (_commitWorkerCredit) once the SpendingAuth is.
   */
  private _creditWorkers(
    sellerPeerId: string,
    metadata: SpendingAuthMetadata,
    signedDelta: bigint,
    counted: Iterable<readonly [string, bigint]> = [],
    signedCumulative?: bigint,
  ): { metadata: SpendingAuthMetadata; due: Map<string, bigint> } {
    const owedBefore = [...this._workerCreditDue.get(sellerPeerId)?.values() ?? []].reduce((sum, owed) => sum + owed, 0n);
    const allocated = (this._verifiedCost.get(sellerPeerId) ?? 0n) - owedBefore;
    const headroom = signedCumulative !== undefined ? signedCumulative - allocated : 0n;
    const due = new Map(this._workerCreditDue.get(sellerPeerId));
    for (const [requestId, cost] of counted) {
      // Only the seller the request went to, and only for an answer that verified.
      if (cost > 0n && this._workerDeliveries.verifiedWorker(requestId, sellerPeerId)) {
        due.set(requestId, (due.get(requestId) ?? 0n) + cost);
      }
    }
    let workers = metadata.workers;
    let left = headroom > signedDelta ? headroom : signedDelta;
    for (const [requestId, owed] of due) {
      if (left <= 0n) break;
      const worker = this._workerDeliveries.verifiedWorker(requestId, sellerPeerId);
      const paid = !worker ? 0n : owed < left ? owed : left;
      if (worker) workers = withWorkerAttribution(workers, worker, paid);
      left -= paid;
      if (paid === owed || !worker) due.delete(requestId);
      else due.set(requestId, owed - paid);
    }
    return { metadata: workers === metadata.workers ? metadata : { ...metadata, workers }, due };
  }

  /** Keep `due` as the seller's worker credit still owed, and retire the worker requests now paid. */
  private _commitWorkerCredit(sellerPeerId: string, due: Map<string, bigint>, counted: Iterable<readonly [string, bigint]> = []): void {
    const before = [...this._workerCreditDue.get(sellerPeerId)?.keys() ?? []];
    if (due.size > 0) this._workerCreditDue.set(sellerPeerId, due);
    else this._workerCreditDue.delete(sellerPeerId);
    for (const requestId of before) this._retireWorkerDeliveryIfPaid(sellerPeerId, requestId);
    for (const [requestId] of counted) this._retireWorkerDeliveryIfPaid(sellerPeerId, requestId);
  }

  /** Forget what the seller can still charge for, and its workers' credit still owed: its verified cost was reset. */
  private _dropRequestRecords(sellerPeerId: string): void {
    this._requestLedgers.delete(sellerPeerId);
    this._workerCreditDue.delete(sellerPeerId);
  }

  /**
   * The latest SpendingAuth signed on the seller's active channel, with its
   * metadata (worker attribution included): a colony-pool request carries it
   * so its worker can check its earlier answers were paid. Null before any.
   */
  latestSpendingAuth(sellerPeerId: string): { channelId: string; cumulativeAmount: string; metadata: string; signature: string } | null {
    const session = this.getActiveSession(sellerPeerId);
    if (!session?.latestSpendingAuthSig || !session.latestMetadata) return null;
    return { channelId: session.sessionId, cumulativeAmount: session.authMax, metadata: session.latestMetadata, signature: session.latestSpendingAuthSig };
  }

  /**
   * Which of `assigned` (in order) a new paid request to the seller may be
   * encrypted for, so every worker that could answer it can be credited: a
   * channel's attribution names at most MAX_WORKERS_PER_CHANNEL workers.
   * Workers it already credits, or that requests still outstanding may
   * credit, take no new slot; new ones fill what is left. Callers record the
   * request (recordWorkerAttribution) before anything else runs, so
   * concurrent requests see each other's reservations.
   */
  creditableWorkers(sellerPeerId: string, assigned: readonly string[]): string[] {
    const known = this._workerDeliveries.reservedWorkers(sellerPeerId);
    if (this.getActiveSession(sellerPeerId)) {
      for (const entry of this._metadata.get(sellerPeerId)?.workers ?? []) known.add(entry.worker.toLowerCase());
    }
    let slots = MAX_WORKERS_PER_CHANNEL - known.size;
    return assigned.filter((worker) => {
      if (known.has(worker.toLowerCase())) return true;
      if (slots <= 0) return false;
      slots--;
      return true;
    });
  }

  /**
   * A request was encrypted for these pool workers. Its signed amount is
   * attributed to the one whose sealed answer verifies (recordWorkerDelivery):
   * only a recipient can decrypt it, and each answers under its own key.
   */
  recordWorkerAttribution(sellerPeerId: string, requestId: string, workers: string | readonly string[], free = false): void {
    this._workerDeliveries.recordAttribution(sellerPeerId, requestId, workers, free);
  }

  /** Retire a verified worker request once it is counted and its worker credited in full. */
  private _retireWorkerDeliveryIfPaid(sellerPeerId: string, requestId: string | undefined): void {
    if (requestId == null) return;
    if (
      this._workerDeliveries.verifiedWorker(requestId, sellerPeerId)
      && !this._requestLedgers.get(sellerPeerId)?.has(requestId)
      && !this._workerCreditDue.get(sellerPeerId)?.has(requestId)
    ) {
      this._workerDeliveries.retire(requestId);
    }
  }

  /**
   * The seller announces colony-pool workers. From now on a delivered cost it
   * claims is paid only for a request the buyer sent it: a worker request
   * (judged by its verified answer) or one tracked with trackPoolSellerRequest.
   * A claim naming no request, or one the buyer never sent, is refused, so a
   * pool cannot turn a failed worker answer into an ordinary claim by
   * changing or dropping its request ID.
   */
  markWorkerSeller(sellerPeerId: string): void {
    this._workerDeliveries.markSeller(sellerPeerId);
  }

  /** The buyer sent a pool seller a request that is not encrypted to a worker (an ordinary provider of that seller). */
  trackPoolSellerRequest(sellerPeerId: string, requestId: string): void {
    this._workerDeliveries.trackPoolSellerRequest(sellerPeerId, requestId);
  }

  /**
   * The buyer checked the worker's sealed answer to a pool request: `usage` is
   * what the answering `worker` authenticated, or null when the answer did not
   * verify (or never came). A NeedAuth for the request is signed only after a
   * verified answer, only for the tokens that worker reported, and only that
   * worker is credited. An answer from a worker the request was not encrypted
   * for (or, with several recipients, an unnamed one) counts as failed.
   */
  recordWorkerDelivery(requestId: string, usage: WorkerUsage | null, worker?: string | null): void {
    this._workerDeliveries.recordDelivery(requestId, usage, worker);
    const sellerPeerId = this._workerDeliveries.get(requestId)?.sellerPeerId;
    if (sellerPeerId) this._priceFromWorkerUsage(sellerPeerId, requestId);
  }

  /**
   * A verified worker answer is owed what the worker authenticated, never the
   * buyer's estimate from the response it parsed: its ledger record is priced
   * (and its usage set) from the authenticated usage, at the request's own
   * pricing. An answer that authenticated no usage owes nothing.
   */
  private _priceFromWorkerUsage(sellerPeerId: string, requestId: string): void {
    const record = this._requestLedgers.get(sellerPeerId)?.get(requestId);
    const delivery = this._workerDeliveries.get(requestId);
    // Unit-billed answers are judged by their unit usage, as any other.
    if (!record || record.cutOff || record.costCounted || record.usage?.unitUsage || !delivery?.usage
      || delivery.state !== 'verified' || delivery.sellerPeerId !== sellerPeerId) return;
    const usage = delivery.usage;
    const pricing = this.getRequestBilling(requestId)?.tokenPricing ?? this.getSessionPricing(sellerPeerId, record.service);
    const authenticated = pricing
      ? computeUsageCostUsdc(usage, pricing)
      : usage.inputTokens + usage.outputTokens + usage.cachedInputTokens > 0n ? record.costUsdc : 0n;
    record.costUsdc = authenticated < record.costUsdc ? authenticated : record.costUsdc;
    record.usage = { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens };
  }

  private _getCeiling(sellerPeerId: string): bigint {
    return this._currentReserveCeiling.get(sellerPeerId) ?? this._config.maxReserveAmountUsdc;
  }

  /** The most the pool can settle on the channel now: while a top-up is pending, only the deposit already locked. */
  private _settleableCeiling(sellerPeerId: string): bigint {
    const pending = this._pendingReserveAuth.get(sellerPeerId);
    return pending ? pending.confirmedAmount : this._getCeiling(sellerPeerId);
  }

  /** Clean up all in-memory state for a seller when the session ends. */
  cleanupSession(sellerPeerId: string): void {
    this._cumulativeAmount.delete(sellerPeerId);
    this._sellerAccepted.delete(sellerPeerId);
    this._metadata.delete(sellerPeerId);
    this._verifiedCost.delete(sellerPeerId);
    this._dropRequestRecords(sellerPeerId);
    this._sessionPricing.delete(sellerPeerId);
    this._currentReserveCeiling.delete(sellerPeerId);
    this._initialReserveAmount.delete(sellerPeerId);
    this._reserveSalt.delete(sellerPeerId);
    this._pendingReserveAuth.delete(sellerPeerId);
    this._confirmedPeers.delete(sellerPeerId);
    this._rejectedPeers.delete(sellerPeerId);
    this._responseTokenTotals.delete(sellerPeerId);
    this._clearRequestBillingForSeller(sellerPeerId);
    // Worker delivery state outlives the session: a NeedAuth names a request,
    // and a forgotten worker request must stay refused on the next channel too.
    // Answered ones lost their records above, so they free their worker slots.
    this._workerDeliveries.retireAnswered(sellerPeerId);
  }

  getActiveSession(sellerPeerId: string): StoredChannel | null {
    return this._channelStore.getActiveChannelByPeerAndBuyer(sellerPeerId, CHANNEL_ROLE.BUYER, this._identity.wallet.address);
  }

  /**
   * Whether `channel` is still where its writer started: the seller's active
   * session, or a one-off channel not yet retired. Payment work reads the
   * channel, awaits, then writes per-seller state; once the session is retired
   * and replaced during that await, those writes would land on the new channel.
   */
  private _isLive(channel: StoredChannel): boolean {
    return channel.channelKind === CHANNEL_KIND.ONE_OFF
      ? this._oneOffChannels.has(channel.sessionId)
      : this.getActiveSession(channel.peerId)?.sessionId === channel.sessionId;
  }

  /** Commit a SpendingAuth to a live channel, unless a higher one was committed while it was signed. */
  private async _commitLive(channel: StoredChannel, metadata: SpendingAuthMetadata): Promise<CommitOutcome> {
    if (!this._isLive(channel)) return 'retired';
    if (BigInt(channel.authMax) < this.getHighestSignedAmount(channel)) return 'superseded';
    await this._commitAuthorization(channel, metadata);
    return this._isLive(channel) ? 'committed' : 'retired';
  }

  /** The highest cumulative signed on a live channel: in memory, or committed to the store. */
  getHighestSignedAmount(channel: StoredChannel): bigint {
    const committed = BigInt(this._channelStore.getChannel(channel.sessionId)?.authMax ?? '0');
    const inMemory = (channel.channelKind === CHANNEL_KIND.ONE_OFF
      ? this._oneOffChannels.get(channel.sessionId)?.cumulative
      : this._cumulativeAmount.get(channel.peerId)) ?? 0n;
    return committed > inMemory ? committed : inMemory;
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

  resendCurrentSpendingAuth(sellerPeerId: string, paymentMux: PaymentMux): Promise<string> {
    return this._withSellerLock(sellerPeerId, () => this._resendCurrentSpendingAuth(sellerPeerId, paymentMux));
  }

  private async _resendCurrentSpendingAuth(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<string> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw buyerFault(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}...`, 'buyer-session-state');
    }

    const cumulativeAmount = this._cumulativeAmount.get(sellerPeerId) ?? BigInt(session.authMax);
    const currentMeta = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    const spendingAuth = await this._signAndCommitSpendingAuth(session, cumulativeAmount, currentMeta);
    if (spendingAuth === 'retired') throw writeDropped(sellerPeerId);
    // The higher authorization committed meanwhile was sent by its own writer.
    if (spendingAuth === 'superseded') return session.sessionId;

    paymentMux.sendSpendingAuth(spendingAuth);

    return session.sessionId;
  }

  async extendCurrentSpendingAuth(
    sellerPeerId: string,
    minBudgetPerRequest: bigint,
    paymentMux: PaymentMux,
    targetCumulative?: bigint,
    requestId?: string,
    inFlightRequests = 1,
  ): Promise<string> {
    const { sessionId, topUp } = await this._withSellerLock(sellerPeerId, () => this._extendCurrentSpendingAuth(
      sellerPeerId, minBudgetPerRequest, paymentMux, targetCumulative, requestId, inFlightRequests,
    ));
    // Sent after the SpendingAuth so the seller processes the higher cumulative
    // first, meeting the on-chain settle threshold for topUp.
    if (topUp) await this._topUpAfterSpendAuthBestEffort(sellerPeerId, paymentMux, 'extendCurrentSpendingAuth');
    return sessionId;
  }

  private async _extendCurrentSpendingAuth(
    sellerPeerId: string,
    minBudgetPerRequest: bigint,
    paymentMux: PaymentMux,
    targetCumulative: bigint | undefined,
    requestId: string | undefined,
    inFlightRequests: number,
  ): Promise<{ sessionId: string; topUp: boolean }> {
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
    // A seller catch-up target covers every request served on the channel, so
    // with several requests in flight allow one per-request window for each,
    // still capped at the reserve ceiling.
    if (targetCumulative != null && inFlightRequests > 1) {
      const catchUpMax = reopened.verifiedCost
        + this._config.maxPerRequestUsdc * BigInt(Math.floor(inFlightRequests));
      maxSignable = catchUpMax < ceiling ? catchUpMax : ceiling;
    }
    // The seller's target is what it has delivered. Signing more would make
    // undelivered work claimable on-chain, and signing less than the target
    // would leave the seller rejecting us in a 402 loop.
    const minAdvance = currentCumulative + minBudgetPerRequest;
    const requestedAmount = targetCumulative ?? minAdvance;

    const nextCumulative = requestedAmount < maxSignable ? requestedAmount : maxSignable;
    // The top-up still asks for room for the next request: a target at the
    // ceiling fills the reserve, and the seller closes a full channel as
    // exhausted. A top-up locks more deposit but makes nothing claimable.
    const extendNeedsTopUp = this._needsCeilingAdvance(
      requestedAmount > minAdvance ? requestedAmount : minAdvance,
      maxSignable,
      ceiling,
    );
    if (nextCumulative <= currentCumulative) {
      // Nothing to sign at current ceiling; a top-up still extends it for the next round.
      debugWarn(
        `[BuyerPayment] Cannot extend active session for ${sellerPeerId.slice(0, 12)}... ` +
        `(current=${currentCumulative} maxSignable=${maxSignable} target=${targetCumulative ?? 'n/a'})`,
      );
      return { sessionId: session.sessionId, topUp: extendNeedsTopUp };
    }

    // Reopening takes everything signed so far as verified. The seller's 402
    // asked for all it had served, so the requests recorded before now are
    // paid: counting one on top later would pay for it twice. Their workers
    // are credited from this advance.
    const paysRecorded = reopened.verifiedCost !== (this._verifiedCost.get(sellerPeerId) ?? 0n);
    const counted = paysRecorded
      ? [...this._requestLedgers.get(sellerPeerId) ?? []].filter(([, record]) => !record.cutOff).map(([id, record]) => [id, record.costUsdc] as const)
      : [];
    const credit = this._creditWorkers(sellerPeerId, this._sanitizeMetadata(this._metadata.get(sellerPeerId)), nextCumulative - currentCumulative, counted);
    const spendingAuth = await this._commitUpdatedSpendingAuth(
      session,
      sellerPeerId,
      nextCumulative,
      credit.metadata,
    );
    if (spendingAuth === 'retired') throw writeDropped(sellerPeerId);
    // A SpendingAuth committed while this one was signed already signed past the target.
    if (spendingAuth === 'superseded') return { sessionId: session.sessionId, topUp: extendNeedsTopUp };
    this._metadata.set(sellerPeerId, credit.metadata);
    if (paysRecorded) this._requestLedgers.delete(sellerPeerId);
    this._commitWorkerCredit(sellerPeerId, credit.due, counted);
    this._verifiedCost.set(sellerPeerId, reopened.verifiedCost);
    this._reportSpend({
      sellerPeerId,
      requestId: requestId ?? null,
      amountUsdc: (nextCumulative - currentCumulative).toString(),
      inputTokens: '0',
      cachedInputTokens: '0',
      outputTokens: '0',
      outputImages: '0',
    });
    paymentMux.sendSpendingAuth(spendingAuth);
    return { sessionId: session.sessionId, topUp: extendNeedsTopUp };
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
    { includeAuth = true, maxCumulative }: { includeAuth?: boolean; maxCumulative?: bigint } = {},
  ): Promise<CloseChannelRequestPayload> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw buyerFault(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}...`, 'buyer-session-state');
    }

    const signedCumulative = this._cumulativeAmount.get(sellerPeerId) ?? BigInt(session.authMax);
    // The contract rejects a close above the channel's deposit, so a close
    // authorization above it could never settle. Capping it there still covers
    // everything the seller could claim.
    const capped = maxCumulative != null && signedCumulative > maxCumulative;
    const cumulativeAmount = capped ? maxCumulative : signedCumulative;
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
    // A capped close authorization is below the signed high-water mark; keep
    // the persisted latest authorization consistent with authMax.
    const live = capped
      ? this._isLive(session)
      : await this._commitLive({
        ...session,
        authMax: cumulativeAmount.toString(),
        latestBuyerSig: spendingAuthSig,
        latestSpendingAuthSig: spendingAuthSig,
        latestMetadata: encodedMetadata,
        updatedAt: Date.now(),
      }, currentMeta) === 'committed';
    if (!live) throw writeDropped(sellerPeerId);

    return {
      version: 1,
      channelId: session.sessionId,
      cumulativeAmount: cumulativeAmount.toString(),
      metadataHash,
      metadata: encodedMetadata,
      spendingAuthSig,
    };
  }

  /** The reserve ceiling `resendReserveAuth` would sign for this seller: what the seller's reserve() then locks. */
  replayReserveAmount(sellerPeerId: string): bigint {
    const replayAmount = this._initialReserveAmount.get(sellerPeerId)
      ?? this._currentReserveCeiling.get(sellerPeerId)
      ?? this._config.maxReserveAmountUsdc;
    return replayAmount > this._config.maxReserveAmountUsdc
      ? this._config.maxReserveAmountUsdc
      : replayAmount;
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

    const maxAmount = this.replayReserveAmount(sellerPeerId);
    const deadline = this._authDeadline();
    const reserveAuthSig = await this._signReserveAuth(session.sessionId, maxAmount, deadline);

    const pending: PendingReserveAuthorization = {
      signature: reserveAuthSig,
      salt,
      maxAmount,
      deadline,
      confirmedAmount: 0n,
    };
    const live = await this._commitAndSendReserveAuth(session, sellerPeerId, pending, paymentMux, {
      initialReserveAmount: maxAmount.toString(),
    });
    if (!live) throw writeDropped(sellerPeerId);

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
      const signature = await this._signReserveAuth(session.sessionId, pending.maxAmount, deadline);
      pending = { ...pending, signature, deadline };
    }

    if (!await this._commitAndSendReserveAuth(session, sellerPeerId, pending, paymentMux)) throw writeDropped(sellerPeerId);
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
    // A video paid from its own one-off channel outlives the session channel:
    // keep its job and in-flight retrieve so its delivery can still be signed.
    for (const [key, job] of this._videoJobs) {
      if (job.context.sellerPeerId === sellerPeerId && !job.oneOffChannelId) this._videoJobs.delete(key);
    }
    for (const [requestId, entry] of this._requestBillingEntries) {
      if (entry.context.sellerPeerId === sellerPeerId && !entry.oneOffChannelId) {
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
   * reserve top-ups. The reserve fields go over the stored row, not `session`:
   * a SpendingAuth committed while the ReserveAuth was signed keeps its higher
   * cumulative, which is also the one sent. False, with nothing sent or
   * adopted, once the session is no longer live.
   */
  private async _commitAndSendReserveAuth(
    session: StoredChannel,
    sellerPeerId: string,
    pending: PendingReserveAuthorization,
    paymentMux: PaymentMux,
    options: { initialReserveAmount?: string } = {},
  ): Promise<boolean> {
    const current = this._isLive(session) ? this._channelStore.getChannel(session.sessionId) : null;
    if (!current) return false;
    const metadata = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
    const encodedMetadata = encodeMetadata(metadata);
    await this._commitAuthorization({
      ...current,
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
    if (!this._isLive(session)) return false;
    this._pendingReserveAuth.set(sellerPeerId, pending);

    paymentMux.sendSpendingAuth({
      channelId: session.sessionId,
      cumulativeAmount: current.authMax,
      metadataHash: computeMetadataHash(metadata),
      metadata: encodedMetadata,
      spendingAuthSig: pending.signature,
      reserveSalt: pending.salt,
      reserveMaxAmount: pending.maxAmount.toString(),
      reserveDeadline: pending.deadline,
    });
    this._currentReserveCeiling.set(sellerPeerId, pending.maxAmount);
    return true;
  }

  /** A dropped commit leaves the per-seller cumulative as it was; see `_commitLive`. */
  private async _commitUpdatedSpendingAuth(
    session: StoredChannel,
    sellerPeerId: string,
    cumulativeAmount: bigint,
    metadata: SpendingAuthMetadata,
  ): Promise<SpendingAuthPayload | DroppedCommit> {
    const sanitizedMetadata = this._sanitizeMetadata(metadata);
    const spendingAuth = await this._signAndCommitSpendingAuth(
      session,
      cumulativeAmount,
      sanitizedMetadata,
    );
    if (typeof spendingAuth === 'string') return spendingAuth;

    this._cumulativeAmount.set(sellerPeerId, cumulativeAmount);
    return spendingAuth;
  }

  /** See `_commitLive` for a dropped commit. */
  private async _signAndCommitSpendingAuth(
    channel: StoredChannel,
    cumulativeAmount: bigint,
    metadata: SpendingAuthMetadata,
  ): Promise<SpendingAuthPayload | DroppedCommit> {
    const sanitizedMetadata = this._sanitizeMetadata(metadata);
    const metadataHash = computeMetadataHash(sanitizedMetadata);
    const encodedMetadata = encodeMetadata(sanitizedMetadata);
    const spendingAuthSig = await signSpendingAuth(this._signer, this._channelsDomain, {
      channelId: channel.sessionId,
      cumulativeAmount,
      metadataHash,
    });

    const outcome = await this._commitLive({
      ...channel,
      authMax: cumulativeAmount.toString(),
      latestBuyerSig: spendingAuthSig,
      latestSpendingAuthSig: spendingAuthSig,
      latestMetadata: encodedMetadata,
      updatedAt: Date.now(),
    }, sanitizedMetadata);
    if (outcome !== 'committed') return outcome;

    return {
      channelId: channel.sessionId,
      cumulativeAmount: cumulativeAmount.toString(),
      metadataHash,
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
    const terms = await this._newChannelTerms(sellerPeerId, metadataArg);
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

    const { channelId, salt, deadline } = terms;
    debugLog(`[BuyerPayment] authorizeSpending: channel=${channelId.slice(0, 18)}... seller=${sellerPeerId.slice(0, 12)}... amount=${minBudgetPerRequest}`);

    const maxAmount = reserveAmount;
    const reserveAuthSig = await this._signReserveAuth(channelId, maxAmount, deadline);
    const initialMetadata = this._sanitizeMetadata({ ...ZERO_METADATA });

    this._cumulativeAmount.set(sellerPeerId, 0n);
    this._metadata.set(sellerPeerId, initialMetadata);
    this._verifiedCost.set(sellerPeerId, 0n);
    this._dropRequestRecords(sellerPeerId);
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

    await this._commitAuthorization(this._newBuyerChannel(terms, maxAmount, reserveAuthSig, initialMetadata), initialMetadata);
    this._sendOpeningReserveAuth(paymentMux, terms, maxAmount, reserveAuthSig, initialMetadata);
    this._currentReserveCeiling.set(sellerPeerId, maxAmount);

    return channelId;
  }

  private async _newChannelTerms(sellerPeerId: string, metadata?: PeerMetadata): Promise<NewChannelTerms> {
    const sellerEvmAddr = this._sellerAddressResolver
      ? await this._sellerAddressResolver.resolveSellerAddress(sellerPeerId as PeerId, metadata)
      : peerIdToAddress(sellerPeerId);
    const buyerEvmAddr = this._identity.wallet.address;
    const salt = hexlify(randomBytes(32));
    return {
      sellerPeerId,
      sellerEvmAddr,
      buyerEvmAddr,
      salt,
      channelId: computeChannelId(buyerEvmAddr, sellerEvmAddr, salt),
      deadline: this._authDeadline(),
    };
  }

  private _newBuyerChannel(
    terms: NewChannelTerms,
    openingReserve: bigint,
    openingReserveSig: string,
    metadata: SpendingAuthMetadata,
    overrides: Partial<StoredChannel> = {},
  ): StoredChannel {
    const now = Date.now();
    return {
      sessionId: terms.channelId,
      peerId: terms.sellerPeerId,
      role: CHANNEL_ROLE.BUYER,
      sellerEvmAddr: terms.sellerEvmAddr,
      buyerEvmAddr: terms.buyerEvmAddr,
      nonce: 0,
      authMax: '0',
      deadline: terms.deadline,
      previousSessionId: '0x' + '0'.repeat(64),
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: openingReserveSig,
      latestSpendingAuthSig: null,
      latestMetadata: encodeMetadata(metadata),
      reserveSalt: terms.salt,
      initialReserveAmount: openingReserve.toString(),
      reserveMaxAmount: openingReserve.toString(),
      latestReserveAuthSig: openingReserveSig,
      latestReserveDeadline: terms.deadline,
      reserveAuthPending: true,
      confirmedReserveAmount: '0',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  private _sendOpeningReserveAuth(
    paymentMux: PaymentMux,
    terms: NewChannelTerms,
    openingReserve: bigint,
    openingReserveSig: string,
    metadata: SpendingAuthMetadata,
    extra: Partial<SpendingAuthPayload> = {},
  ): void {
    paymentMux.sendSpendingAuth({
      channelId: terms.channelId,
      cumulativeAmount: '0',
      metadataHash: ZERO_METADATA_HASH,
      metadata: encodeMetadata(metadata),
      spendingAuthSig: openingReserveSig,
      reserveSalt: terms.salt,
      reserveMaxAmount: openingReserve.toString(),
      reserveDeadline: terms.deadline,
      ...extra,
    });
  }

  /** Sign the threshold SpendingAuth and the final ReserveAuth that let the seller run topUp() right after reserve(). */
  private async _signReserveBatch(
    channelId: string,
    cumulativeAmount: bigint,
    metadata: SpendingAuthMetadata,
    maxAmount: bigint,
    deadline: number,
  ): Promise<NonNullable<SpendingAuthPayload['reserveBatch']>> {
    const metadataHash = computeMetadataHash(metadata);
    const spendingAuthSig = await signSpendingAuth(this._signer, this._channelsDomain, { channelId, cumulativeAmount, metadataHash });
    return {
      cumulativeAmount: cumulativeAmount.toString(),
      metadataHash,
      metadata: encodeMetadata(metadata),
      spendingAuthSig,
      maxAmount: maxAmount.toString(),
      deadline,
      reserveAuthSig: await this._signReserveAuth(channelId, maxAmount, deadline),
    };
  }

  private _authDeadline(): number {
    return Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;
  }

  private _signReserveAuth(channelId: string, maxAmount: bigint, deadline: number): Promise<string> {
    return signReserveAuth(this._signer, this._channelsDomain, { channelId, maxAmount, deadline: BigInt(deadline) });
  }

  /** Report a unit-billed charge that carries no token usage. */
  private _reportUnitSpend(sellerPeerId: string, requestId: string | null, amount: bigint): void {
    this._reportSpend({
      sellerPeerId,
      requestId,
      amountUsdc: amount.toString(),
      inputTokens: '0',
      cachedInputTokens: '0',
      outputTokens: '0',
      outputImages: '0',
    });
  }

  // ── AuthAck handler ───────────────────────────────────────────

  async handleAuthAck(sellerPeerId: string, payload: AuthAckPayload): Promise<void> {
    const oneOff = this._oneOffChannels.get(payload.channelId);
    if (oneOff) {
      if (oneOff.sellerPeerId !== sellerPeerId) return;
      await this._confirmOneOffChannel(payload.channelId, oneOff);
      return;
    }
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
    const fixedThreshold = ceiling <= initialReserve
      ? initialReserve * INITIAL_TOPUP_HEADROOM_PERCENT / PERCENT_DENOMINATOR
      : SUBSEQUENT_TOPUP_HEADROOM_USDC;
    const loadThreshold = this._inFlightHeadroom(sellerPeerId);
    const threshold = loadThreshold > fixedThreshold ? loadThreshold : fixedThreshold;
    const remaining = ceiling > current ? ceiling - current : 0n;
    return remaining <= threshold;
  }

  setChannelDepositReader(reader: (channelId: string) => Promise<bigint>): void {
    this._readChannelDeposit = reader;
  }

  /**
   * Whether this seller has a paid request running or a reserve top-up queued
   * or running. The channel reconcile pass leaves such a seller's session alone.
   */
  hasPaymentInFlight(sellerPeerId: string): boolean {
    return (this._inFlightPaidRequests.get(sellerPeerId) ?? 0) > 0 || (this._topUpsQueued.get(sellerPeerId) ?? 0) > 0;
  }

  /** Count a paid request to this seller as in flight until endPaidRequest. */
  beginPaidRequest(sellerPeerId: string): void {
    this._inFlightPaidRequests.set(sellerPeerId, (this._inFlightPaidRequests.get(sellerPeerId) ?? 0) + 1);
  }

  /**
   * The attempt is over. Record what arrived (recordDeliveredResponse) before
   * this: an attempt that ends with nothing recorded owes nothing when the
   * seller `answered` it (an error answer, a 402 the buyer retries). When it
   * did not, the attempt was cut off with nothing the buyer can price: the
   * seller may still bill it, and only the overdraft window pays for that.
   */
  endPaidRequest(sellerPeerId: string, requestId?: string, answered = false): void {
    if (requestId && !answered && !this._requestLedgers.get(sellerPeerId)?.has(requestId)) {
      this.recordDeliveredResponse(sellerPeerId, requestId, { costUsdc: 0n, cutOff: true });
    }
    const remaining = (this._inFlightPaidRequests.get(sellerPeerId) ?? 0) - 1;
    if (remaining > 0) this._inFlightPaidRequests.set(sellerPeerId, remaining);
    else this._inFlightPaidRequests.delete(sellerPeerId);
  }

  /**
   * The buyer received `sellerPeerId`'s response to paid request `requestId`
   * and priced it itself, or cut the attempt off (`cutOff`). The seller may
   * charge for it once, up to that cost, on the channel live now (the ledger
   * is dropped when a channel starts or ends).
   */
  recordDeliveredResponse(sellerPeerId: string, requestId: string, delivered: DeliveredResponse): void {
    let ledger = this._requestLedgers.get(sellerPeerId);
    if (!ledger) this._requestLedgers.set(sellerPeerId, ledger = new Map());
    // Bounded like request billing: forgetting a request only ever pays the seller less.
    // A verified worker answer not yet counted is kept, since forgetting it would
    // also lose its worker's credit; those are bounded by the delivery tracker,
    // which refuses new worker requests to a seller with too many unpaid.
    if (ledger.size >= MAX_REQUEST_BILLING_ENTRIES && !ledger.has(requestId)) {
      for (const [id, record] of ledger) {
        if (record.cutOff || record.costUsdc <= 0n || !this._workerDeliveries.verifiedWorker(id, sellerPeerId)) {
          ledger.delete(id);
          break;
        }
      }
    }
    ledger.set(requestId, { ...delivered });
    this._priceFromWorkerUsage(sellerPeerId, requestId);
  }

  /**
   * How much of the current ceiling is a top-up not yet locked on-chain. A
   * landed top-up the buyer has not heard about is reconciled first, so it is
   * not counted against the available balance twice. Without a chain read,
   * the whole pending increase counts. Null when the channel was replaced
   * during the read.
   */
  private async _outstandingTopUp(sellerPeerId: string, channelId: string, ceiling: bigint): Promise<bigint | null> {
    const pending = this._pendingReserveAuth.get(sellerPeerId);
    if (!pending || pending.confirmedAmount <= 0n || ceiling <= pending.confirmedAmount) return 0n;
    let locked = pending.confirmedAmount;
    if (this._readChannelDeposit) {
      try {
        const deposit = await this._readChannelDeposit(channelId);
        // Only act on the read if nothing replaced the channel or the authorization meanwhile.
        if (this.getActiveSession(sellerPeerId)?.sessionId !== channelId) return null;
        if (this._pendingReserveAuth.get(sellerPeerId) !== pending) {
          return this._outstandingTopUp(sellerPeerId, channelId, this._getCeiling(sellerPeerId));
        }
        if (deposit >= pending.maxAmount) {
          await this.reconcileReserveAmount(sellerPeerId, deposit);
          return 0n;
        }
        if (deposit > locked) locked = deposit;
      } catch (err) {
        debugWarn(`[BuyerPayment] topUpReserve: could not read the channel deposit: ${err instanceof Error ? err.message : err}`);
      }
    }
    return ceiling > locked ? ceiling - locked : 0n;
  }

  /**
   * Headroom the paid requests in flight to this seller need: their count
   * times the channel's average verified cost per request, doubled. Zero until
   * the channel has served a request, so a fresh channel keeps the fixed rules.
   */
  private _inFlightHeadroom(sellerPeerId: string): bigint {
    const inFlight = BigInt(this._inFlightPaidRequests.get(sellerPeerId) ?? 0);
    const requests = this._metadata.get(sellerPeerId)?.cumulativeRequestCount ?? 0n;
    if (inFlight <= 0n || requests <= 0n) return 0n;
    const averageCost = (this._verifiedCost.get(sellerPeerId) ?? 0n) / requests;
    return inFlight * averageCost * IN_FLIGHT_HEADROOM_FACTOR;
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
  signPerRequestAuth(
    sellerPeerId: string,
    responseStats: PerRequestResponseStats,
  ): Promise<PerRequestAuthResult> {
    return this._withSellerLock(sellerPeerId, () => this._signPerRequestAuth(sellerPeerId, responseStats));
  }

  private async _signPerRequestAuth(
    sellerPeerId: string,
    stats: PerRequestResponseStats,
  ): Promise<PerRequestAuthResult> {
    const workerDelivery = stats.requestId != null ? this._workerDeliveries.get(stats.requestId) : undefined;
    if (
      this._workerDeliveries.isForgotten(sellerPeerId, stats.requestId)
      || this._workerDeliveries.isUntrackedPoolSellerClaim(sellerPeerId, stats.requestId, workerDelivery)
      || (workerDelivery && (workerDelivery.sellerPeerId !== sellerPeerId || workerDelivery.state !== 'verified' || !workerDelivery.usage))
    ) {
      throw buyerFault(
        `[BuyerPayment] Request ${stats.requestId} to a colony-pool worker has no verified answer to pay for`,
        'buyer-session-state',
      );
    }
    if (workerDelivery?.free) {
      throw buyerFault(
        `[BuyerPayment] Request ${stats.requestId} to a colony-pool worker was sent free: its answer owes nothing`,
        'buyer-session-state',
      );
    }
    // A colony-pool request is priced from the usage the worker authenticated, not reported counts.
    const responseStats: PerRequestResponseStats = workerDelivery?.usage
      ? {
        ...stats,
        reportedInputTokens: workerDelivery.usage.inputTokens,
        reportedCachedInputTokens: workerDelivery.usage.cachedInputTokens,
        reportedOutputTokens: workerDelivery.usage.outputTokens,
      }
      : stats;
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
    // A worker's authenticated usage is the count, even when it is zero.
    const workerUsage = workerDelivery?.usage;
    const hasReportedTokens = workerUsage != null || (responseStats.reportedInputTokens != null && responseStats.reportedInputTokens > 0n) ||
      (responseStats.reportedOutputTokens != null && responseStats.reportedOutputTokens > 0n) ||
      (responseStats.sellerClaimedCost != null && responseStats.sellerClaimedCost === 0n);

    let estimatedInputTokens: bigint;
    let estimatedOutputTokens: bigint;
    let estimatedCachedInputTokens = 0n;
    let byteEstimatedTokens = false;
    let buyerEstimatedRequestCost: bigint;

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
      // (a worker's at the request's own pricing, as NeedAuth checks it).
      const pricing = (workerUsage ? requestBilling?.tokenPricing : undefined)
        ?? this.getSessionPricing(sellerPeerId, responseStats.service);
      if (pricing) {
        const cost = computeCostUsdc(Number(freshInputTokens), Number(estimatedOutputTokens), pricing, Number(cachedInputTokens));
        buyerEstimatedRequestCost = cost;
      } else if (responseStats.sellerClaimedCost != null && responseStats.sellerClaimedCost > 0n) {
        // No local pricing available (e.g. after buyer restart before session pricing is restored).
        // Use seller's claimed cost for verifiedCost accumulation so _maxSignable can grow.
        // The seller's claim is still validated against tolerance below.
        buyerEstimatedRequestCost = responseStats.sellerClaimedCost;
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
      debugLog(
        `[BuyerPayment] Byte-estimated tokens (no reported): in=${estimatedInputTokens} out=${estimatedOutputTokens} cost=${buyerEstimatedRequestCost}`,
      );
    }

    // Image attribution (metadata/stats only — never cost). The count is the
    // buyer's own observation of the delivered response, so it survives a
    // headroom NeedAuth having already consumed the request-billing entry.
    const estimatedOutputImages = countUnits(responseStats.unitUsage, 'output_images');
    const estimatedVideoGenerations = countUnits(responseStats.unitUsage, 'video_generations');
    const estimatedVideoSeconds = countUnits(responseStats.unitUsage, 'video_seconds');
    const estimatedInputCharacters = countUnits(responseStats.unitUsage, 'input_characters');
    if (estimatedOutputImages > 0n) {
      if (byteEstimatedTokens) {
        // Byte estimates of an image response are base64 noise, not tokens.
        estimatedOutputTokens = 0n;
        estimatedInputTokens = 0n;
        estimatedCachedInputTokens = 0n;
      }
      estimatedOutputTokens += estimatedOutputImages * OUTPUT_IMAGE_TOKEN_EQUIVALENT;
      if (estimatedInputTokens <= 0n) {
        estimatedInputTokens = BigInt(imagePromptTokens(requestBilling));
      }
    }

    // Determine the accepted cost for this request:
    // When the seller reports a cost within tolerance, accept the seller's claim so the
    // buyer doesn't underpay due to minor parsing differences. Only cap when the seller's
    // claim exceeds the tolerance threshold.
    let acceptedCost: bigint;
    if (responseStats.sellerClaimedCost != null && responseStats.sellerClaimedCost > 0n) {
      if (buyerEstimatedRequestCost > 0n) {
        const maxAcceptable = BigInt(Math.ceil(Number(buyerEstimatedRequestCost) * this._costToleranceFor(requestBilling)));
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

    // A response with a request ID is owed only while the ledger holds it: with
    // no open record it was counted already or nothing is owed for it. What is
    // owed is every response the buyer received whose cost frame never
    // arrived, each at the buyer's own cost; an attempt the buyer cut off is
    // paid only through its NeedAuth. A response with no request ID cannot be
    // recorded, and is paid as reported.
    const ledger = this._requestLedgers.get(sellerPeerId);
    const counted = [...ledger ?? []].filter(([, record]) => !record.cutOff);
    const alreadyCounted = responseStats.requestId != null && !counted.some(([requestId]) => requestId === responseStats.requestId);
    const reportedCost = responseStats.requestId != null ? 0n : acceptedCost;
    acceptedCost = reportedCost;
    for (const [, record] of counted) acceptedCost += record.costUsdc;

    // Sign up to the verified cost once these are counted. A cost a NeedAuth
    // counted but could not sign (reserve ceiling, pending top-up) is signed
    // here; what a seller prompt or a 402 retry already signed past verified
    // cost is not signed again.
    // maxSignable already caps at reserve ceiling, so one cap is sufficient
    const prevAmount = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    const nextVerifiedCost = (this._verifiedCost.get(sellerPeerId) ?? 0n) + acceptedCost;
    const maxSignable = this._maxSignableForVerified(sellerPeerId, nextVerifiedCost);
    let newAmount = prevAmount + reportedCost;
    if (newAmount < nextVerifiedCost) newAmount = nextVerifiedCost;
    if (newAmount > maxSignable) newAmount = maxSignable;
    // A conservative recovery ceiling may temporarily be below an amount we
    // already signed. SpendingAuth is cumulative and must never move backward.
    if (newAmount < prevAmount) newAmount = prevAmount;
    const signedDelta = newAmount - prevAmount;

    // Update cumulative metadata, deduplicating usage for a response NeedAuth already counted.
    // Each other response counted here goes to its own service, with its own usage.
    let otherMeta = this._metadata.get(sellerPeerId);
    let othersAmount = 0n;
    for (const [requestId, { costUsdc, service, usage }] of counted) {
      if (requestId === responseStats.requestId || !usage) continue;
      const images = countUnits(usage.unitUsage, 'output_images');
      otherMeta = this._advanceUsageMetadata(otherMeta, service, {
        amount: costUsdc,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens + images * OUTPUT_IMAGE_TOKEN_EQUIVALENT,
        requests: 1n,
        outputImages: images,
        videoGenerations: countUnits(usage.unitUsage, 'video_generations'),
        videoSeconds: countUnits(usage.unitUsage, 'video_seconds'),
        inputCharacters: countUnits(usage.unitUsage, 'input_characters'),
      });
      othersAmount += costUsdc;
    }
    const usageMeta = this._advanceUsageMetadata(
      otherMeta,
      responseStats.service,
      {
        ...normalizeRequestUsageDelta({
          amount: signedDelta,
          inputTokens: estimatedInputTokens,
          cachedInputTokens: estimatedCachedInputTokens,
          outputTokens: estimatedOutputTokens,
          requests: 1n,
          outputImages: estimatedOutputImages,
          videoGenerations: estimatedVideoGenerations,
          videoSeconds: estimatedVideoSeconds,
          inputCharacters: estimatedInputCharacters,
        }, { deliveredResponse: true, alreadyCounted }),
        // Any remainder of a NeedAuth-counted request is still this service's amount,
        // as is a cost counted here that a seller prompt had already signed for.
        amount: (signedDelta > acceptedCost ? signedDelta : acceptedCost) - othersAmount,
      },
    );
    // The verified worker answers counted here are credited to their workers.
    const countedCosts = counted.map(([requestId, record]) => [requestId, record.costUsdc] as const);
    // Worker credit from headroom already signed rides an auth one base unit
    // higher, so the pool can settle it even when it already settled that
    // headroom (AntseedChannels never re-settles, or checks the signature of a
    // close at, an amount already settled; see countUnsigned). At the reserve
    // ceiling nothing can advance: then that credit stays owed for a later advance.
    let credit = this._creditWorkers(sellerPeerId, usageMeta, signedDelta, countedCosts, newAmount);
    if (credit.metadata !== usageMeta && newAmount === prevAmount) {
      if (newAmount < this._settleableCeiling(sellerPeerId)) newAmount += 1n;
      else credit = this._creditWorkers(sellerPeerId, usageMeta, signedDelta, countedCosts);
    }
    const newMeta = credit.metadata;
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
    const outcome = await this._commitLive({
      ...session,
      authMax: newAmount.toString(),
      requestCount: Number(newMeta.cumulativeRequestCount),
      latestBuyerSig: spendingAuthSig,
      latestSpendingAuthSig: spendingAuthSig,
      latestMetadata: encodedMetadata,
      updatedAt: Date.now(),
    }, newMeta);
    if (outcome !== 'committed') throw writeDropped(sellerPeerId);

    this._cumulativeAmount.set(sellerPeerId, newAmount);
    this._verifiedCost.set(sellerPeerId, nextVerifiedCost);
    this._metadata.set(sellerPeerId, newMeta);
    // Counted: no later NeedAuth may claim a cost for them.
    for (const [requestId] of counted) ledger!.delete(requestId);
    this._commitWorkerCredit(sellerPeerId, credit.due, countedCosts);
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
  private _withSellerLock<T>(sellerPeerId: string, run: () => Promise<T>): Promise<T> {
    return runQueued(this._sellerLocks, sellerPeerId, run);
  }

  async handleNeedAuth(
    sellerPeerId: string,
    payload: NeedAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    if (this._oneOffChannels.has(payload.channelId)) {
      await this._handleOneOffNeedAuth(sellerPeerId, payload, paymentMux);
      return;
    }
    const topUp = await this._withSellerLock(sellerPeerId, () => this._signForNeedAuth(sellerPeerId, payload, paymentMux));
    if (topUp) await this._topUpAfterSpendAuthBestEffort(sellerPeerId, paymentMux, 'handleNeedAuth');
  }

  /**
   * Validates a NeedAuth and signs the next cumulative authorization. Runs
   * under the seller lock, so it reads the latest signed amount and verified
   * cost. Returns whether a reserve top-up should follow.
   */
  private async _signForNeedAuth(
    sellerPeerId: string,
    payload: NeedAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<boolean> {
    // The seller's NeedAuth can legitimately race ahead of the buyer's own
    // response processing (different muxes). Give the response path a moment
    // to record a unit-billed delivery before judging the claim. This waits
    // inside the lock on purpose: NeedAuths must be judged in arrival order,
    // or a later one signs past this request's cost and this one is dropped
    // as stale, never counted, and charged again at close.
    if (
      payload.billingUsage && payload.requestId && hasPositiveCost(payload.lastRequestCost)
      && this.getRequestBilling(payload.requestId)?.unitModel
    ) {
      await this._waitForObservedUnitUsage(payload.requestId, OBSERVED_UNIT_USAGE_WAIT_MS);
    }
    // A colony-pool request is paid only once the buyer has verified the
    // worker's sealed answer, and only for the tokens the worker authenticated:
    // the pool could otherwise bill for an answer that was tampered with,
    // truncated or never came. Waits inside the lock for the same reason as
    // above; the response path records the result without taking the lock.
    // Any frame reporting a delivered response is judged, a zero-cost one too:
    // it would otherwise count (and so retire) a request whose answer failed.
    const reportsDelivery = payload.lastRequestCost != null || payload.billingUsage != null;
    const workerDelivery = payload.requestId && reportsDelivery
      ? await this._workerDeliveries.awaitDelivery(sellerPeerId, payload.requestId, WORKER_DELIVERY_WAIT_MS)
      : undefined;
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] NeedAuth for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return false;
    }
    if (session.sessionId !== payload.channelId) {
      debugWarn(`[BuyerPayment] NeedAuth for unknown channel ${payload.channelId.slice(0, 18)}... — ignoring`);
      return false;
    }
    if (payload.currentAcceptedCumulative != null) this._recordSellerAccepted(sellerPeerId, session.sessionId, BigInt(payload.currentAcceptedCumulative));

    if (this.isRequestCovered(sellerPeerId, payload.requestId)) {
      debugWarn(
        `[BuyerPayment] Refusing NeedAuth from ${sellerPeerId.slice(0, 12)}... for request ${payload.requestId} it served from a free allowance`,
      );
      return false;
    }

    const requestBilling = payload.requestId ? this.getRequestBilling(payload.requestId) : undefined;
    const buyerService = requestBilling?.context.service
      ?? this._requestService.get(payload.requestId);
    const buyerBillingContext = requestBilling?.context;
    if (reportsDelivery && this._workerDeliveries.isForgotten(sellerPeerId, payload.requestId)) {
      debugWarn(`[BuyerPayment] Refusing NeedAuth from ${sellerPeerId.slice(0, 12)}... for colony-pool request ${payload.requestId}: its delivery was never verified`);
      return false;
    }
    if (reportsDelivery && this._workerDeliveries.isCompleted(sellerPeerId, payload.requestId)) {
      debugWarn(`[BuyerPayment] Refusing NeedAuth from ${sellerPeerId.slice(0, 12)}... for colony-pool request ${payload.requestId}: it is already paid`);
      return false;
    }
    if (workerDelivery && workerDelivery.sellerPeerId !== sellerPeerId) {
      debugWarn(`[BuyerPayment] Refusing NeedAuth from ${sellerPeerId.slice(0, 12)}... for request ${payload.requestId} sent to another seller`);
      return false;
    }
    if (reportsDelivery && this._workerDeliveries.isUntrackedPoolSellerClaim(sellerPeerId, payload.requestId, workerDelivery)) {
      debugWarn(`[BuyerPayment] Refusing NeedAuth from colony-pool seller ${sellerPeerId.slice(0, 12)}... for request ${payload.requestId ?? '(none)'} it was never sent`);
      return false;
    }
    if (workerDelivery) {
      const pricing = requestBilling?.tokenPricing ?? this.getSessionPricing(sellerPeerId, buyerService);
      const problem = workerDeliveryProblem(workerDelivery, payload, pricing, Boolean(requestBilling?.unitModel));
      if (problem) {
        debugWarn(`[BuyerPayment] Refusing NeedAuth from ${sellerPeerId.slice(0, 12)}... for request ${payload.requestId}: ${problem}`);
        return false;
      }
    }

    const requiredCumulativeAmount = BigInt(payload.requiredCumulativeAmount);
    const currentCumulative = this._cumulativeAmount.get(sellerPeerId) ?? 0n;

    // A cost counts toward verified cost only for a request the buyer holds an
    // open record of, and only up to the buyer's own cost in that record. The
    // token counts in the frame are the seller's own, so they prove nothing:
    // without this any claimed cost would count as verified, for a request
    // that failed, was never sent, or was already paid.
    const ledger = this._requestLedgers.get(sellerPeerId);
    let record = payload.lastRequestCost != null && payload.requestId ? ledger?.get(payload.requestId) : undefined;
    if (record?.costCounted) record = undefined;
    if (hasPositiveCost(payload.lastRequestCost) && !record) {
      debugWarn(
        `[BuyerPayment] Refusing NeedAuth from ${sellerPeerId.slice(0, 12)}... claiming a cost for request ` +
        `${payload.requestId ?? '(none)'}: nothing is owed for it`,
      );
      return false;
    }
    if (record && hasPositiveCost(payload.lastRequestCost) !== record.costUsdc > 0n) {
      // One side puts a cost on the request and the other none: the buyer cut
      // the attempt off with nothing it can price, or the frame is for an
      // earlier attempt (a retry keeps the request ID). Nothing counts as
      // verified and the record stays: the frame is answered as a prompt,
      // signed only while it fits the overdraft window.
      payload = { ...payload, lastRequestCost: undefined, billingUsage: undefined };
      record = undefined;
    } else if (record?.costUsdc === 0n) {
      // Both sides put no cost on it: nothing is owed for it.
      ledger!.delete(payload.requestId!);
      record = undefined;
    }

    // A verified worker answer whose cost the buyer already signed ahead of
    // (headroom from a seller prompt or a top-up): nothing new to sign, but it
    // is counted below and its worker credited from that headroom.
    const coveredByHeadroom = requiredCumulativeAmount <= currentCumulative && record !== undefined && workerDelivery !== undefined;
    // Reject stale/lower NeedAuth (monotonicity guard)
    if (requiredCumulativeAmount <= currentCumulative && !coveredByHeadroom) {
      // A catch-up prompt (no response cost) for what is already signed but
      // not accepted (lost on the wire, or the seller restarted): resend the
      // same authorization, no higher. A post-response NeedAuth is not
      // answered this way: its authorization is usually still in flight.
      const catchUpPrompt = payload.lastRequestCost == null && payload.billingUsage == null;
      if (catchUpPrompt && payload.currentAcceptedCumulative != null && BigInt(payload.currentAcceptedCumulative) < currentCumulative) {
        debugLog(
          `[BuyerPayment] NeedAuth stale but seller accepted ${payload.currentAcceptedCumulative} < signed ${currentCumulative} — resending`,
        );
        await this._resendCurrentSpendingAuth(sellerPeerId, paymentMux);
        return false;
      }
      debugLog(
        `[BuyerPayment] NeedAuth stale: required=${requiredCumulativeAmount} <= current=${currentCumulative} — ignoring`,
      );
      return false;
    }
    let acceptedServiceCost = 0n;
    let acceptedOutputImages = 0n;
    let acceptedVideoGenerations = 0n;
    let acceptedVideoSeconds = 0n;
    let acceptedInputCharacters = 0n;
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
          // Waited for at the top of _signForNeedAuth.
          const observedUnitUsage = requestBilling.observedUnitUsage;
          const claimedUnitCost = sellerTotalCost > tokenEstimate
            ? sellerTotalCost - tokenEstimate
            : 0n;
          acceptedUnitCost = validateUnitBillingUsage(
            unitBillingModel,
            requestBilling.context,
            payload.billingUsage,
            claimedUnitCost,
            this._costToleranceFor(requestBilling),
            observedUnitUsage,
          );
          const acceptedUnitUsage = unitUsageFromReport(payload.billingUsage);
          acceptedOutputImages = countUnits(acceptedUnitUsage, 'output_images');
          acceptedVideoGenerations = countUnits(acceptedUnitUsage, 'video_generations');
          acceptedVideoSeconds = countUnits(acceptedUnitUsage, 'video_seconds');
          acceptedInputCharacters = countUnits(acceptedUnitUsage, 'input_characters');
        }

        const buyerEstimate = tokenEstimate + acceptedUnitCost;
        if (sellerTotalCost > 0n && buyerEstimate <= 0n) {
          throw new Error("Positive NeedAuth total cost recomputed to zero");
        }
        const maxAcceptable = BigInt(Math.ceil(Number(buyerEstimate) * this._costToleranceFor(requestBilling)));
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
        return false;
      }
    } else if (payload.lastRequestCost) {
      const sellerCost = BigInt(payload.lastRequestCost);
      if (sellerCost > 0n && unitBillingModel && isUnitBilledProtocol(buyerBillingContext?.serviceApiProtocol)) {
        debugWarn(
          `[BuyerPayment] NeedAuth rejected: positive unit cost omitted verifiable billingUsage`,
        );
        return false;
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
        if (buyerEstimate <= 0n && sellerCost > 0n && isUnitBilledProtocol(buyerBillingContext?.serviceApiProtocol)) {
          debugWarn(
            `[BuyerPayment] NeedAuth rejected: positive unit cost recomputed to zero`,
          );
          return false;
        }
        if (buyerEstimate > 0n && sellerCost > maxAcceptable) {
          debugWarn(
            `[BuyerPayment] NeedAuth: seller claimed cost ${sellerCost} exceeds ${this._costTolerance}x buyer estimate ${buyerEstimate} — rejecting`,
          );
          return false;
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

    // The most of the claim that counts as verified. A seller can honestly
    // claim more than the response shows (an agent's internal tool turns, a
    // different usage report), so the frame is not refused: the rest is signed
    // only while it fits the overdraft window, like any prompt.
    const verifiableCost = record
      ? BigInt(Math.ceil(Number(record.costUsdc) * this._costToleranceFor(requestBilling)))
      : 0n;
    if (verifiedCostDelta > verifiableCost) {
      debugWarn(
        `[BuyerPayment] NeedAuth from ${sellerPeerId.slice(0, 12)}... claims ${verifiedCostDelta} for request ${payload.requestId}; ` +
        `the buyer's own cost for it is ${record?.costUsdc ?? 0n}: counting ${verifiableCost}`,
      );
      verifiedCostDelta = verifiableCost;
      if (acceptedServiceCost > verifiableCost) acceptedServiceCost = verifiableCost;
    }
    // Cap at overdraft limit: verifiedCost + maxPerRequestUsdc, then at reserve ceiling.
    // This prevents a malicious seller from claiming a small cost but requesting the full reserve.
    const previousVerifiedCost = this._verifiedCost.get(sellerPeerId) ?? 0n;
    const nextVerifiedCost = previousVerifiedCost + verifiedCostDelta;
    const maxSignable = this._maxSignableForVerified(sellerPeerId, nextVerifiedCost);
    const ceiling = this._getCeiling(sellerPeerId);
    const needsTopUp = this._needsCeilingAdvance(requiredCumulativeAmount, maxSignable, ceiling);
    // A cost the buyer cannot sign for in this frame (the overdraft window is
    // used up, or the reserve ceiling is reached and a top-up is pending)
    // still counts, once, toward verified cost. The seller's next prompt, or
    // the buyer's own signing before a close, signs up to it. The record stays,
    // counted at no cost, so that close still attributes the response's usage.
    // Its worker is credited from signed headroom when there is some (the auth
    // is re-signed with the worker in its tail), otherwise from a later signed
    // advance. The re-signed auth is one base unit higher whenever the reserve
    // allows: the pool contract trusts a tail only from a settlement that
    // advances the channel (it pays it from what the earlier one held), and
    // AntseedChannels never re-settles, or checks the signature of a close at,
    // an amount already settled.
    const countUnsigned = async (): Promise<void> => {
      if (!record) return;
      const counted = [[payload.requestId!, verifiedCostDelta] as const];
      const metadata = this._sanitizeMetadata(this._metadata.get(sellerPeerId));
      // At the reserve ceiling no auth can advance, so none can carry the credit
      // to the pool: it stays owed until a top-up or a later advance pays it.
      const canAdvance = currentCumulative < this._settleableCeiling(sellerPeerId);
      const credit = this._creditWorkers(sellerPeerId, metadata, 0n, counted, canAdvance ? currentCumulative : undefined);
      if (credit.metadata !== metadata) {
        const spendingAuth = await this._commitUpdatedSpendingAuth(session, sellerPeerId, currentCumulative + 1n, credit.metadata);
        if (typeof spendingAuth === 'string') return;
        this._metadata.set(sellerPeerId, credit.metadata);
        paymentMux.sendSpendingAuth(spendingAuth);
      }
      ledger!.set(payload.requestId!, { ...record, costUsdc: 0n, costCounted: true });
      this._verifiedCost.set(sellerPeerId, nextVerifiedCost);
      this._commitWorkerCredit(sellerPeerId, credit.due, counted);
    };
    if (coveredByHeadroom) {
      await countUnsigned();
      debugLog(`[BuyerPayment] NeedAuth: request ${payload.requestId} is covered by signed headroom (required=${requiredCumulativeAmount} <= current=${currentCumulative})`);
      return false;
    }
    // A NeedAuth never reopens a used-up overdraft window: the seller could
    // repeat the frame and have the buyer sign one more window each time,
    // with no work to show for it. Only the buyer's own 402 retry reopens it
    // (extendCurrentSpendingAuth).
    if (maxSignable <= currentCumulative && !needsTopUp) {
      await countUnsigned();
      debugWarn(
        `[BuyerPayment] NeedAuth: maxSignable=${maxSignable} <= currentCumulative=${currentCumulative} — overdraft limit reached`,
      );
      return false;
    }

    // When a topUp is needed, first sign at the current ceiling so the seller
    // has a high-enough settled amount to pass the on-chain TopUpThresholdNotMet
    // check (contract requires TOP_UP_SETTLED_THRESHOLD_BPS of deposit to be settleable before topUp).
    // We cap at the old ceiling here; the topUp is sent AFTER so the seller
    // processes the SpendingAuth first, then the topUp with adequate settle amount.
    let effectiveAmount = needsTopUp
      ? (maxSignable > currentCumulative ? maxSignable : currentCumulative)
      : (requiredCumulativeAmount < maxSignable ? requiredCumulativeAmount : maxSignable);
    // While a top-up is pending, the seller can only accept up to the deposit
    // locked on-chain, and the contract runs topUp() only once enough of that
    // deposit is settled. Crossing it in one jump (from below the settle
    // threshold to above the deposit) leaves the seller with no auth it can
    // use: it rejects the new one, can never submit the top-up, and the
    // channel strands work above the deposit. Sign exactly the confirmed
    // deposit first; the next prompt signs the rest.
    const confirmedDeposit = this._pendingReserveAuth.get(sellerPeerId)?.confirmedAmount ?? 0n;
    if (confirmedDeposit > 0n && currentCumulative < confirmedDeposit && effectiveAmount > confirmedDeposit) {
      debugLog(`[BuyerPayment] NeedAuth: signing the confirmed deposit ${confirmedDeposit} first (target ${effectiveAmount}) while a top-up is pending`);
      effectiveAmount = confirmedDeposit;
    }
    if (effectiveAmount <= currentCumulative) {
      // Nothing to sign; a top-up still extends the ceiling for the next round.
      await countUnsigned();
      debugWarn(
        `[BuyerPayment] NeedAuth: effectiveAmount=${effectiveAmount} <= currentCumulative=${currentCumulative} — cannot advance`,
      );
      return needsTopUp;
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
    // Attribution only — never cost; mirrors signPerRequestAuth.
    let attributedInputTokens = reportedInputTokens;
    let attributedOutputTokens = reportedOutputTokens;
    if (acceptedOutputImages > 0n) {
      attributedOutputTokens += acceptedOutputImages * OUTPUT_IMAGE_TOKEN_EQUIVALENT;
      if (attributedInputTokens <= 0n) {
        attributedInputTokens = BigInt(imagePromptTokens(requestBilling));
      }
    }
    const usageMeta = this._advanceUsageMetadata(
      this._metadata.get(sellerPeerId),
      buyerService,
      normalizeRequestUsageDelta({
        amount: serviceAmountDelta,
        inputTokens: attributedInputTokens,
        cachedInputTokens: reportedCachedInputTokens,
        outputTokens: attributedOutputTokens,
        requests: 1n,
        outputImages: acceptedOutputImages,
        videoGenerations: acceptedVideoGenerations,
        videoSeconds: acceptedVideoSeconds,
        inputCharacters: acceptedInputCharacters,
      }, { deliveredResponse, alreadyCounted: false }),
    );
    // A verified worker answer counted here is credited to its worker.
    const countedCosts = record ? [[payload.requestId!, verifiedCostDelta] as const] : [];
    const credit = this._creditWorkers(sellerPeerId, usageMeta, signedDelta, countedCosts, effectiveAmount);
    const newMeta = credit.metadata;
    // Persistence and transport failures must propagate to the connection
    // owner. In particular, swallowing an IndexedDB failure leaves the browser
    // connected with advanced in-memory counters but no durable signature.
    const spendingAuth = await this._commitUpdatedSpendingAuth(
      session,
      sellerPeerId,
      effectiveAmount,
      newMeta,
    );
    if (typeof spendingAuth === 'string') return false;
    this._verifiedCost.set(sellerPeerId, nextVerifiedCost);
    this._metadata.set(sellerPeerId, newMeta);
    if (record) ledger!.delete(payload.requestId!);
    this._commitWorkerCredit(sellerPeerId, credit.due, countedCosts);
    this._reportSpend({
      sellerPeerId,
      requestId: payload.requestId ?? null,
      amountUsdc: signedDelta.toString(),
      inputTokens: (deliveredResponse ? attributedInputTokens : 0n).toString(),
      cachedInputTokens: (deliveredResponse ? reportedCachedInputTokens : 0n).toString(),
      outputTokens: (deliveredResponse ? attributedOutputTokens : 0n).toString(),
      outputImages: (deliveredResponse ? acceptedOutputImages : 0n).toString(),
    });
    paymentMux.sendSpendingAuth(spendingAuth);
    debugLog(`[BuyerPayment] NeedAuth responded: new cumulativeAmount=${effectiveAmount}`);

    // Send topUp AFTER the SpendingAuth so the seller processes the higher
    // cumulative first — this ensures the on-chain settle amount meets the
    // contract's TopUpThresholdNotMet requirement (TOP_UP_SETTLED_THRESHOLD_BPS of deposit must be
    // settleable before topUp is allowed). Also proactively send the top-up
    // once the signed cumulative reaches the buyer's remaining-headroom
    // threshold; the seller may defer it until the contract gate is satisfied.
    // Only a NeedAuth that reports a request's delivered cost is done with its
    // billing context; a catch-up or headroom prompt may name a request that is
    // still being served.
    if (payload.requestId && deliveredResponse) this.clearRequestBilling(payload.requestId);
    return needsTopUp || this._needsTopUp(sellerPeerId);
  }

  // ── Reserve top-up ─────────────────────────────────────────────

  /**
   * Sign a new ReserveAuth with a higher maxAmount to extend the session's reserve ceiling.
   * The seller must call reserve() on-chain again with the new signature.
   * Note: requires contract support for top-up (increaseDeposit on existing channelId).
   */
  /**
   * Top-ups for one seller run one at a time: each reads the chain and the
   * pending authorization before signing, and a parallel one would budget or
   * reconcile against state the other is about to replace. Kept apart from the
   * signing lock so authorizations never wait on these chain reads.
   */
  topUpReserve(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<void> {
    // A top-up that waited behind another is asked for again only if the
    // channel still needs one: the earlier top-up usually restored headroom.
    const ahead = this._topUpsQueued.get(sellerPeerId) ?? 0;
    this._topUpsQueued.set(sellerPeerId, ahead + 1);
    return runQueued(this._topUpLocks, sellerPeerId, async () => {
      try {
        if (ahead > 0 && !this._needsTopUp(sellerPeerId)) return;
        await this._topUpReserve(sellerPeerId, paymentMux);
      } finally {
        const left = (this._topUpsQueued.get(sellerPeerId) ?? 1) - 1;
        if (left > 0) this._topUpsQueued.set(sellerPeerId, left);
        else this._topUpsQueued.delete(sellerPeerId);
      }
    });
  }

  private async _topUpReserve(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] topUpReserve: no active session for ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    // A top-up still waiting on-chain will lock its increase from the same
    // deposits: budget only what is left after it, so stacked top-ups never
    // authorize more than the buyer holds. One that already landed is out of
    // the available balance already, so read the deposit before counting it.
    const firstOutstanding = await this._outstandingTopUp(sellerPeerId, session.sessionId, this._getCeiling(sellerPeerId));
    if (firstOutstanding === null) {
      debugWarn(`[BuyerPayment] topUpReserve: channel for ${sellerPeerId.slice(0, 12)}... was replaced; skipping the top-up`);
      return;
    }
    let outstanding = firstOutstanding;
    const prevCeiling = this._getCeiling(sellerPeerId);
    // Under parallel load one configured step can be smaller than the work in
    // flight, which then runs past the locked reserve before the next top-up
    // is allowed: grow by enough to cover it, up to a bound.
    const step = this._config.maxReserveAmountUsdc;
    const maxStep = step * MAX_LOAD_TOPUP_MULTIPLE;
    const loadHeadroom = this._inFlightHeadroom(sellerPeerId);
    let additionalReserve = step;
    if (loadHeadroom > step) additionalReserve = loadHeadroom < maxStep ? loadHeadroom : maxStep;
    const deadline = this._authDeadline();

    try {
      let balance = await this.getBalance();
      let budget = balance.available > outstanding ? balance.available - outstanding : 0n;
      // The pending top-up may have landed between the two reads, which counts
      // it twice: read both again before calling the budget short.
      if (outstanding > 0n && budget < additionalReserve) {
        const reread = await this._outstandingTopUp(sellerPeerId, session.sessionId, this._getCeiling(sellerPeerId));
        if (reread === null) return;
        outstanding = reread;
        balance = await this.getBalance();
        budget = balance.available > outstanding ? balance.available - outstanding : 0n;
      }
      // A load-sized step shrinks to the budget; the configured step is the floor.
      if (additionalReserve > step && budget < additionalReserve) {
        additionalReserve = budget > step ? budget : step;
      }
      if (budget < additionalReserve) {
        throw buyerFault(
          `Insufficient buyer deposits for reserve top-up: available=${balance.available} pending=${outstanding} required=${additionalReserve}`,
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

    const newCeiling = prevCeiling + additionalReserve;
    debugLog(`[BuyerPayment] topUpReserve: channel=${session.sessionId.slice(0, 18)}... ceiling ${prevCeiling} → ${newCeiling}`);

    const reserveAuthSig = await this._signReserveAuth(session.sessionId, newCeiling, deadline);

    const salt = this._reserveSalt.get(sellerPeerId) ?? '0x' + '00'.repeat(32);
    const pending: PendingReserveAuthorization = {
      signature: reserveAuthSig,
      salt,
      maxAmount: newCeiling,
      deadline,
      // Stacked on a top-up still pending: the chain has confirmed only what that one had.
      confirmedAmount: prevCeiling - outstanding,
    };

    // Send ReserveAuth sig with reserve fields (same pattern as initial authorizeSpending).
    // The seller uses this to call topUp() on-chain with the new maxAmount.
    const sent = await this._commitAndSendReserveAuth(session, sellerPeerId, pending, paymentMux, {
      initialReserveAmount: session.initialReserveAmount ?? prevCeiling.toString(),
    });
    if (sent) debugLog(`[BuyerPayment] topUpReserve sent: newCeiling=${newCeiling}`);
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

  /** Max price of one video generation from buyer config. */
  get maxVideoRequestUsdc(): bigint {
    return this._config.maxVideoRequestUsdc ?? DEFAULT_MAX_VIDEO_REQUEST_USDC;
  }

  // ── One-off channels ─────────────────────────────────────────

  /**
   * Open a one-off channel that pays for exactly one video. It is a fresh
   * on-chain channel (new salt), never this seller's session channel: chat
   * and image spending cannot touch it, and the seller closes it once the
   * video is paid or abandoned.
   *
   * For a price above the opening reserve, signs the opening ReserveAuth, the
   * contract-required threshold SpendingAuth (the serious fee, credited toward
   * the price) and the final ReserveAuth together; the seller runs reserve()
   * and topUp() before acknowledging. Returns the channelId once persisted
   * and sent; await `waitForOneOffAck` for the seller's confirmation.
   */
  async openOneOffChannel(
    sellerPeerId: string,
    requestId: string,
    plan: OneOffChannelPlan,
    paymentMux: PaymentMux,
    metadataArg?: PeerMetadata,
  ): Promise<string> {
    const price = BigInt(plan.requestCost);
    const openingReserve = BigInt(plan.openingReserveAmount);
    const requiredCumulative = BigInt(plan.requiredCumulativeAmount);
    const billing = this.getRequestBilling(requestId);
    const facts = billing?.requestFacts;
    if (
      !billing || facts?.kind !== 'video' || facts.video.action !== 'create'
      || billing.context.sellerPeerId !== sellerPeerId || billing.estimatedCostUsdc !== price
    ) {
      throw buyerFault(`[BuyerPayment] One-off channel requires a tracked video create (${requestId})`, 'buyer-session-state');
    }
    if (price > this.maxVideoRequestUsdc || requiredCumulative >= price) {
      throw buyerFault(`[BuyerPayment] Refusing one-off channel: price=${price} fee=${requiredCumulative}`, 'buyer-session-state');
    }
    const existing = this.getOneOffChannelForRequest(sellerPeerId, requestId);
    if (existing) return existing;
    const terms = await this._newChannelTerms(sellerPeerId, metadataArg);
    const { channelId, deadline } = terms;
    const metadata = this._sanitizeMetadata({ ...ZERO_METADATA });
    const openingReserveSig = await this._signReserveAuth(channelId, openingReserve, deadline);
    const reserveBatch = requiredCumulative > 0n
      ? await this._signReserveBatch(channelId, requiredCumulative, metadata, price, deadline)
      : undefined;

    await this._commitAuthorization(this._newBuyerChannel(terms, openingReserve, openingReserveSig, metadata, {
      channelKind: CHANNEL_KIND.ONE_OFF,
      oneOffRequestId: requestId,
      reserveMaxAmount: price.toString(),
      ...(reserveBatch ? {
        authMax: reserveBatch.cumulativeAmount,
        latestBuyerSig: reserveBatch.spendingAuthSig,
        latestSpendingAuthSig: reserveBatch.spendingAuthSig,
        latestReserveAuthSig: reserveBatch.reserveAuthSig,
      } : {}),
    }), metadata);
    this._oneOffChannels.set(channelId, {
      sellerPeerId,
      requestId,
      price,
      cumulative: requiredCumulative,
      confirmed: false,
      ackWaiters: [],
    });

    this._sendOpeningReserveAuth(paymentMux, terms, openingReserve, openingReserveSig, metadata, {
      ...(reserveBatch ? { reserveBatch } : {}),
      oneOffRequestId: requestId,
    });
    debugLog(`[BuyerPayment] One-off channel ${channelId.slice(0, 18)}... sent for request ${requestId} (price=${price}, fee=${requiredCumulative})`);
    return channelId;
  }

  /** The active one-off channel opened for this request, or null. */
  getOneOffChannelForRequest(sellerPeerId: string, requestId: string): string | null {
    for (const [channelId, state] of this._oneOffChannels) {
      if (state.sellerPeerId === sellerPeerId && state.requestId === requestId) return channelId;
    }
    return null;
  }

  isOneOffChannelConfirmed(channelId: string): boolean {
    return this._oneOffChannels.get(channelId)?.confirmed === true;
  }

  /** Resolve true once the seller acknowledges the channel, false on timeout. */
  waitForOneOffAck(channelId: string, timeoutMs: number): Promise<boolean> {
    const state = this._oneOffChannels.get(channelId);
    if (!state) return Promise.resolve(false);
    if (state.confirmed) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (confirmed: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(confirmed);
      };
      const timer = setTimeout(() => {
        state.ackWaiters = state.ackWaiters.filter((waiter) => waiter !== finish);
        finish(false);
      }, timeoutMs);
      timer.unref?.();
      state.ackWaiters.push(finish);
    });
  }

  /** Mark the one-off channel confirmed once its full reserve is seen on-chain. */
  async confirmOneOffChannelOnChain(channelId: string, onChainDeposit: bigint): Promise<void> {
    const state = this._oneOffChannels.get(channelId);
    if (state && onChainDeposit >= state.price) await this._confirmOneOffChannel(channelId, state);
  }

  /**
   * Forget a one-off channel locally once it is closed or abandoned. If it is
   * still open on-chain, the buyer can still requestClose() it.
   */
  retireOneOffChannel(channelId: string, status: typeof CHANNEL_STATUS[keyof typeof CHANNEL_STATUS] = CHANNEL_STATUS.SETTLED): void {
    if (!this._oneOffChannels.has(channelId)) return;
    this.forgetOneOffChannel(channelId);
    this._channelStore.updateChannelStatus(channelId, status);
  }

  /** Drop a one-off channel's in-memory state, failing anyone still waiting for its AuthAck. The store is not touched. */
  forgetOneOffChannel(channelId: string): void {
    const state = this._oneOffChannels.get(channelId);
    if (!state) return;
    this._oneOffChannels.delete(channelId);
    for (const waiter of state.ackWaiters.splice(0)) waiter(false);
  }

  /**
   * Record that a tracked video job ended without a video (the seller
   * answered FAILED). The seller
   * closes the job's one-off channel at what the buyer signed so far (the
   * serious fee, if any); the buyer forgets the job and the channel, but keeps
   * it stored as active until the close is seen, so it can still be
   * request-closed if the seller never closes it. True when a tracked job was
   * ended.
   */
  recordVideoFailed(sellerPeerId: string, protocol: string, jobId: string): boolean {
    const key = videoJobKey(sellerPeerId, protocol, jobId);
    const job = this._videoJobs.get(key);
    if (!job) return false;
    this._videoJobs.delete(key);
    if (job.oneOffChannelId) {
      this._persistVideoJob(job.oneOffChannelId, null);
      this.retireOneOffChannel(job.oneOffChannelId, CHANNEL_STATUS.ACTIVE);
    }
    debugLog(`[BuyerPayment] Video job ${jobId} failed; its one-off channel is retired`);
    return true;
  }

  private async _confirmOneOffChannel(channelId: string, state: OneOffChannelState): Promise<void> {
    if (!state.confirmed) {
      const channel = this._channelStore.getChannel(channelId);
      if (channel) {
        this._channelStore.upsertChannel({
          ...channel,
          reserveAuthPending: false,
          confirmedReserveAmount: channel.reserveMaxAmount ?? state.price.toString(),
          updatedAt: Date.now(),
        });
        await this._channelStore.flush?.();
      }
      // Re-checked after the flush: an AuthAck and an on-chain confirmation
      // can both get here, and only the first may report the fee.
      if (!state.confirmed) {
        state.confirmed = true;
        // The serious fee counts as spent only once the channel holds it: a
        // channel the seller never opened (or released at 0) charged nothing.
        if (state.cumulative > 0n) this._reportUnitSpend(state.sellerPeerId, state.requestId, state.cumulative);
        debugLog(`[BuyerPayment] One-off channel confirmed: ${channelId.slice(0, 18)}...`);
      }
    }
    for (const waiter of state.ackWaiters.splice(0)) waiter(true);
  }

  /**
   * Sign a one-off channel's only charge: the video price, after the buyer
   * received the finished video. Anything else is refused: the channel never
   * pays for more than its video, and never before delivery.
   */
  private async _handleOneOffNeedAuth(
    sellerPeerId: string,
    payload: NeedAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const { channelId, requestId } = payload;
    const state = this._oneOffChannels.get(channelId);
    const channel = this._channelStore.getChannel(channelId);
    if (!state || !channel || state.sellerPeerId !== sellerPeerId) return;
    const required = BigInt(payload.requiredCumulativeAmount);
    if (required <= state.cumulative) return;
    const billing = requestId ? this._requestBillingEntries.get(requestId) : undefined;
    if (
      required !== state.price || BigInt(payload.lastRequestCost ?? '0') !== state.price
      || !requestId || !billing?.unitModel || billing.oneOffChannelId !== channelId || !payload.billingUsage
    ) {
      debugWarn(`[BuyerPayment] One-off NeedAuth rejected: request ${requestId ?? 'n/a'} required=${required} price=${state.price}`);
      return;
    }
    let usage: UnitBillingUsage;
    try {
      const observed = billing.observedUnitUsage ?? await this._waitForObservedUnitUsage(requestId, OBSERVED_UNIT_USAGE_WAIT_MS);
      validateUnitBillingUsage(billing.unitModel, billing.context, payload.billingUsage, state.price, this._costTolerance, observed);
      usage = observed ?? unitUsageFromReport(payload.billingUsage);
    } catch (err) {
      debugWarn(`[BuyerPayment] One-off NeedAuth billingUsage rejected: ${err instanceof Error ? err.message : err}`);
      return;
    }

    const metadata = this._advanceUsageMetadata(this._channelStore.getChannelMetadata(channel), billing.context.service, {
      amount: state.price,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 1n,
      outputImages: 0n,
      videoGenerations: countUnits(usage, 'video_generations'),
      videoSeconds: countUnits(usage, 'video_seconds'),
      inputCharacters: countUnits(usage, 'input_characters'),
    });
    const spendingAuth = await this._signAndCommitSpendingAuth(channel, state.price, metadata);
    if (typeof spendingAuth === 'string') return;
    this._reportUnitSpend(sellerPeerId, requestId, state.price - state.cumulative);
    state.cumulative = state.price;
    paymentMux.sendSpendingAuth(spendingAuth);
    this.clearRequestBilling(requestId);
    // The seller closes the channel on receiving this; it pays for nothing else.
    this.retireOneOffChannel(channelId);
  }

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

  /** The highest cumulative the seller has reported accepting on the active channel (0 if none yet). */
  getSellerAcceptedCumulative(sellerPeerId: string): bigint {
    const accepted = this._sellerAccepted.get(sellerPeerId);
    return accepted && accepted.channelId === this.getActiveSession(sellerPeerId)?.sessionId ? accepted.amount : 0n;
  }

  private _recordSellerAccepted(sellerPeerId: string, channelId: string, amount: bigint): void {
    const known = this._sellerAccepted.get(sellerPeerId);
    if (known?.channelId === channelId && known.amount >= amount) return;
    this._sellerAccepted.set(sellerPeerId, { channelId, amount });
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

  /** Nothing was delivered for the request: a NeedAuth waiting for it is judged now, as after the wait. */
  private _noObservedUnitUsage(requestId: string): void {
    const entry = this._requestBillingEntries.get(requestId);
    if (entry) entry.notDelivered = true;
    const waiters = this._observedUsageWaiters.get(requestId);
    if (!waiters) return;
    this._observedUsageWaiters.delete(requestId);
    for (const waiter of waiters) waiter(undefined);
  }

  /** Wait for observed unit usage while the buyer's response path catches up. */
  private _waitForObservedUnitUsage(
    requestId: string,
    timeoutMs: number,
  ): Promise<UnitBillingUsage | undefined> {
    const entry = this._requestBillingEntries.get(requestId);
    if (entry?.observedUnitUsage) return Promise.resolve(entry.observedUnitUsage);
    if (entry?.notDelivered) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onUsage = (usage: UnitBillingUsage | undefined): void => {
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

  /**
   * The one-off channel a video create was paid from, for ResponseAuth
   * verification. Only the create itself is signed with that channel; the
   * seller signs retrieves of the same job with the session channel, so they
   * return null and fall back to it.
   */
  getResponseAuthChannelId(sellerPeerId: string, requestId: string): string | null {
    return this.getOneOffChannelForRequest(sellerPeerId, requestId);
  }

  /** Remember an accepted video job; its price is charged on delivery. */
  trackVideoJob(
    sellerPeerId: string,
    protocol: string,
    jobId: string,
    entry: BuyerRequestBillingEntry,
    requestId?: string,
  ): void {
    const now = Date.now();
    for (const [key, job] of this._videoJobs) {
      if (now - job.createdAtMs > VIDEO_JOB_TTL_MS) this._videoJobs.delete(key);
    }
    const oneOffChannelId = requestId ? this.getOneOffChannelForRequest(sellerPeerId, requestId) ?? undefined : undefined;
    this._videoJobs.set(videoJobKey(sellerPeerId, protocol, jobId), {
      ...entry,
      createdAtMs: now,
      ...(oneOffChannelId ? { oneOffChannelId } : {}),
    });
    if (oneOffChannelId) this._persistVideoJob(oneOffChannelId, { protocol, jobId, createdAtMs: now, entry });
    while (this._videoJobs.size > MAX_VIDEO_JOBS) {
      const oldest = this._videoJobs.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this._videoJobs.get(oldest);
      this._videoJobs.delete(oldest);
      // Gone for good, also after a restart: a job this buyer stopped tracking is never charged, and a later
      // download of it may already have been taken as delivered.
      if (evicted?.oneOffChannelId) this._persistVideoJob(evicted.oneOffChannelId, null);
    }
  }

  /**
   * Bind a retrieve request to its accepted job so the seller's delivery
   * NeedAuth is validated against the job's own billing facts.
   */
  trackVideoRetrieve(sellerPeerId: string, protocol: string, jobId: string, requestId: string): boolean {
    const job = this._videoJobs.get(videoJobKey(sellerPeerId, protocol, jobId));
    if (!job) return false;
    const { createdAtMs: _createdAtMs, observedUnitUsage: _observed, oneOffChannelId, ...entry } = job;
    this.trackRequestBilling(requestId, entry);
    const tracked = this._requestBillingEntries.get(requestId);
    if (tracked && oneOffChannelId) tracked.oneOffChannelId = oneOffChannelId;
    return true;
  }

  /**
   * Record that the buyer received the finished video. Only now may the
   * seller's NeedAuth for the job's price be signed, and only once.
   * `untracked`: the buyer no longer has the job (it can never be charged).
   * `unsaved`: the delivery is recorded (the seller's charge is signed, so it
   * is paid for what it delivered) but the job could not be removed from
   * storage yet, where a restart would find it again; until that is saved
   * (see `videoDeliveryUnsaved`) the download is not reported as delivered,
   * so a gateway keeps the price held until the charge reaches it.
   */
  recordVideoDelivered(sellerPeerId: string, protocol: string, jobId: string, requestId: string): 'recorded' | 'unsaved' | 'untracked' {
    const key = videoJobKey(sellerPeerId, protocol, jobId);
    const job = this._videoJobs.get(key);
    // The job's own facts, not the request's cache entry, which other requests may have evicted meanwhile.
    const facts = job?.requestFacts;
    if (!job || facts?.kind !== 'video') {
      this._noObservedUnitUsage(requestId);
      return 'untracked';
    }
    const saved = !job.oneOffChannelId || this._persistVideoJob(job.oneOffChannelId, null);
    if (!this._requestBillingEntries.has(requestId)) this.trackVideoRetrieve(sellerPeerId, protocol, jobId, requestId);
    this._videoJobs.delete(key);
    if (!saved) this._unsavedVideoDeliveries.set(key, job.oneOffChannelId!);
    this.recordObservedUnitUsage(requestId, nativeVideoUnitUsage(facts.video));
    return saved ? 'recorded' : 'unsaved';
  }

  /**
   * Whether a delivered job's stored copy is still to be cleared (retried
   * now). While it is, a restart could restore the job, so another download
   * of it is not reported as delivered either; its one-off channel never pays
   * more than the price already signed.
   */
  videoDeliveryUnsaved(sellerPeerId: string, protocol: string, jobId: string): boolean {
    const key = videoJobKey(sellerPeerId, protocol, jobId);
    const channelId = this._unsavedVideoDeliveries.get(key);
    if (channelId === undefined) return false;
    if (!this._persistVideoJob(channelId, null)) return true;
    this._unsavedVideoDeliveries.delete(key);
    return false;
  }

  /** The duration a tracked video job asked for, if it is tracked. */
  videoJobDuration(sellerPeerId: string, protocol: string, jobId: string): number | undefined {
    const facts = this._videoJobs.get(videoJobKey(sellerPeerId, protocol, jobId))?.requestFacts;
    return facts?.kind === 'video' ? facts.video.duration : undefined;
  }

  /** Store (or clear) the undelivered job on its one-off channel row. */
  /** Whether the job is stored as given (true too when its channel is gone: nothing can restore the job). */
  private _persistVideoJob(channelId: string, job: PersistedVideoJob | null): boolean {
    try {
      const channel = this._channelStore.getChannel(channelId);
      if (!channel) return true;
      this._channelStore.upsertChannel({
        ...channel,
        oneOffVideoJob: job ? JSON.stringify(job, (_key, value) => typeof value === 'bigint' ? { $bigint: value.toString() } : value) : null,
        updatedAt: Date.now(),
      });
      return true;
    } catch (err) {
      debugWarn(`[BuyerPayment] Failed to persist video job for ${channelId.slice(0, 18)}...: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private _restoreVideoJob(channel: StoredChannel): void {
    if (!channel.oneOffVideoJob) return;
    try {
      const job = JSON.parse(channel.oneOffVideoJob, (_key, value) => (
        value && typeof value === 'object' && typeof value.$bigint === 'string' ? BigInt(value.$bigint) : value
      )) as PersistedVideoJob;
      if (Date.now() - job.createdAtMs > VIDEO_JOB_TTL_MS) return;
      this._videoJobs.set(videoJobKey(channel.peerId, job.protocol, job.jobId), {
        ...job.entry,
        createdAtMs: job.createdAtMs,
        oneOffChannelId: channel.sessionId,
      });
    } catch (err) {
      debugWarn(`[BuyerPayment] Ignoring unreadable video job on ${channel.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  clearRequestBilling(requestId: string): void {
    this._requestBillingEntries.delete(requestId);
    this._requestService.take(requestId);
  }

  /**
   * `sellerPeerId` marked `requestId` as covered by a free allowance: forget its
   * billing and refuse any later NeedAuth from that seller claiming a charge for it.
   */
  markRequestCovered(sellerPeerId: string, requestId: string): void {
    this.clearRequestBilling(requestId);
    // A covered worker answer is never signed for: it must not stay owed.
    this._workerDeliveries.markFree(sellerPeerId, requestId);
    // Nothing is owed for it, even once the covered record below expires.
    this._requestLedgers.get(sellerPeerId)?.delete(requestId);
    const key = coveredRequestKey(sellerPeerId, requestId);
    const now = Date.now();
    for (const [id, markedAt] of this._coveredRequests) {
      if (this._coveredRequests.size < MAX_COVERED_REQUESTS && now - markedAt < COVERED_REQUEST_TTL_MS) break;
      this._coveredRequests.delete(id);
    }
    this._coveredRequests.delete(key);
    this._coveredRequests.set(key, now);
  }

  /**
   * A new attempt of `requestId` is going to `sellerPeerId`: a retry keeps the
   * request ID, and if this attempt is paid its NeedAuth is legitimate even when
   * an earlier attempt was covered.
   */
  releaseRequestCoverage(sellerPeerId: string, requestId: string): void {
    this._coveredRequests.delete(coveredRequestKey(sellerPeerId, requestId));
  }

  /** Whether `sellerPeerId` served the current attempt of `requestId` from a free allowance. */
  isRequestCovered(sellerPeerId: string, requestId: string | undefined): boolean {
    return requestId !== undefined && this._coveredRequests.has(coveredRequestKey(sellerPeerId, requestId));
  }

  trackRequestBillingContext(requestId: string, context: UnitBillingContext): void {
    this.trackRequestBilling(requestId, { context });
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

function writeDropped(sellerPeerId: string): Error {
  return buyerFault(
    `[BuyerPayment] Authorization for seller ${sellerPeerId.slice(0, 12)}... was dropped: its session was retired, or signed higher, while it was being signed`,
    'buyer-session-state',
  );
}

function videoJobKey(sellerPeerId: string, protocol: string, jobId: string): string {
  return `${sellerPeerId.toLowerCase()}\n${protocol}\n${jobId}`;
}

function imagePromptTokens(billing: BuyerRequestBillingEntry | undefined): number {
  const facts = billing?.requestFacts;
  return facts?.kind === 'image' ? facts.image.promptTokens ?? 0 : 0;
}
