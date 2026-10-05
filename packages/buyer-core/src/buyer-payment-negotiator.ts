import type { BuyerIdentity } from './interfaces.js';
import type { BuyerConnection } from './interfaces.js';
import { PaymentMux } from './payment-mux.js';
import type { PeerId } from '@antseed/protocol/peer-id';
import type { BuyerPeerView } from './interfaces.js';
import {
  ANTSEED_FAULT_ATTRIBUTION_HEADER,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from '@antseed/protocol/http';
import {
  PAYMENT_CODE_CHANNEL_EXHAUSTED,
  type PaymentRequiredPayload,
  type CloseChannelResultPayload,
} from '@antseed/protocol/messages';
import type { BuyerPaymentManager } from './buyer-payment-manager.js';
import type { BuyerFreeUsageManager } from './buyer-free-usage-manager.js';
import type { DepositsClient } from './deposits-client.js';
import type { ChannelsClient } from './channels-client.js';
import {
  CHANNEL_ROLE,
  CHANNEL_STATUS,
  type BuyerChannelStore,
  type StoredChannel,
} from './channel-store-types.js';
import { classifyOnChainChannel } from './channel-session-state.js';
import { peerIdToAddress } from '@antseed/protocol/peer-id';
import { debugLog, debugWarn } from './debug.js';
import type { SellerAddressResolver } from './seller-address-resolver.js';
import { SellerAuthorizationError } from './seller-address-resolver.js';
import { parseResponseUsage } from './response-usage.js';
import { computeCostUsdc, type ServicePricing } from './pricing.js';
import { formatUsdc } from './usdc-utils.js';
import { parseJsonObject, tryParseJsonObject } from '@antseed/protocol/json-codec';
import type { UnitBillingModelV1, UnitBillingUsage } from '@antseed/protocol/billing';
import type { ServiceApiProtocol } from '@antseed/protocol/service-api';
import {
  captureUnitBillingContext,
  computeFinalUnitBilling,
  extractUnitResponseUsage,
  type FinalUnitBillingResult,
} from './unit-billing.js';
import { buyerFault, peerFault } from './errors.js';

export interface BuyerNegotiatorConfig {
  /**
   * Live chain-RPC reachability signal. When it returns false the negotiator
   * skips best-effort on-chain reads (like the pre-negotiation balance check)
   * instead of letting them fail or hang — off-chain signing continues either
   * way, so payments keep working through RPC outages.
   */
  isChainReachable?: () => boolean;
  /**
   * Called when a best-effort on-chain read fails, so the reachability
   * monitor can re-detect a mid-session RPC outage instead of staying
   * optimistically "ready" forever.
   */
  onChainReadFailure?: () => void;
}

/** How long to wait for a seller's CloseChannelResult before giving up. */
const CLOSE_REQUEST_TIMEOUT_MS = 60_000;

/** Emitter interface — subset of EventEmitter used by the negotiator. */
export interface NegotiationEmitter {
  emit(event: string, ...args: unknown[]): boolean;
}

/** Result of handling a 402 response. */
export type Handle402Result =
  | { action: 'return'; response: SerializedHttpResponse }
  | { action: 'retry' };

/** Per-peer cost tracking from the last response. */
interface LastResponseCost {
  costUsdc: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  unitUsage?: UnitBillingUsage;
  cumulativeCost: bigint;
  inputContent: Uint8Array;
  outputContent: Uint8Array;
  latencyMs: number;
  service?: string;
  requestId?: string;
}

export interface SelectedBillingRoute {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  unitModel?: UnitBillingModelV1;
  tokenPricing?: ServicePricing;
}

function parsePaymentRequiredBody(body: Uint8Array): Record<string, unknown> | null {
  return tryParseJsonObject(body);
}

function safeBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Manages all buyer-side payment negotiation state and logic.
 *
 * Extracted from AntseedNode to separate buyer payment concerns
 * (402 handling, SpendingAuth negotiation, per-request auth, cost tracking)
 * from core node orchestration.
 */
export class BuyerPaymentNegotiator {
  private readonly _bpm: BuyerPaymentManager;
  private readonly _depositsClient: DepositsClient | null;
  private readonly _channelsClient: ChannelsClient | null;
  private readonly _channelStore: BuyerChannelStore | null;
  private readonly _freeUsageManager: BuyerFreeUsageManager | null;
  private readonly _identity: BuyerIdentity;
  private readonly _emit: NegotiationEmitter;
  private readonly _sellerAddressResolver?: SellerAddressResolver;
  private readonly _isChainReachable: (() => boolean) | null;
  private readonly _onChainReadFailure: (() => void) | null;

  /** Tracks which seller peers the buyer has already negotiated payment for. */
  private readonly _lockedPeers = new Set<string>();
  /** Pending PaymentRequired payloads from sellers, keyed by peerId. */
  private readonly _pendingPaymentRequired = new Map<string, {
    resolve: (payload: PaymentRequiredPayload) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** Buffered PaymentRequired that arrived before negotiation registered its listener. */
  private readonly _bufferedPaymentRequired = new Map<string, PaymentRequiredPayload>();
  /** Per-peer mutex to prevent concurrent payment negotiations. */
  private readonly _negotiationLocks = new Map<string, Promise<void>>();
  /** Peers that have sent their first request after session establishment. */
  private readonly _firstRequestSent = new Set<string>();
  /** Per-peer last response cost, raw content, and latency from the seller. */
  private readonly _lastResponseCost = new Map<string, LastResponseCost>();
  /** Buyer-side payment muxes keyed by seller peerId. */
  private readonly _muxes = new Map<PeerId, PaymentMux>();
  /** Every in-flight NeedAuth handler, retained until its work settles. */
  private readonly _pendingNeedAuth = new Set<Promise<void>>();
  /** In-flight cooperative-close requests keyed by seller peerId. */
  private readonly _pendingCloseRequests = new Map<string, {
    channelId: string;
    resolve: (payload: CloseChannelResultPayload) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    identity: BuyerIdentity,
    bpm: BuyerPaymentManager,
    depositsClient: DepositsClient | null,
    channelsClient: ChannelsClient | null,
    channelStore: BuyerChannelStore | null,
    _config: BuyerNegotiatorConfig,
    emitter: NegotiationEmitter,
    sellerAddressResolver?: SellerAddressResolver,
    freeUsageManager?: BuyerFreeUsageManager | null,
  ) {
    this._identity = identity;
    this._bpm = bpm;
    this._depositsClient = depositsClient;
    this._channelsClient = channelsClient;
    this._channelStore = channelStore;
    this._freeUsageManager = freeUsageManager ?? null;
    this._emit = emitter;
    this._sellerAddressResolver = sellerAddressResolver;
    this._isChainReachable = _config.isChainReachable ?? null;
    this._onChainReadFailure = _config.onChainReadFailure ?? null;
  }

  get bpm(): BuyerPaymentManager {
    return this._bpm;
  }

  private async _resolveSellerAddr(peer: BuyerPeerView): Promise<string> {
    if (!this._sellerAddressResolver) return peerIdToAddress(peer.peerId);
    try {
      return await this._sellerAddressResolver.resolveSellerAddress(peer.peerId, peer.metadata);
    } catch (err) {
      if (err instanceof SellerAuthorizationError) {
        debugWarn(`[BuyerNegotiator] Dropping peer ${peer.peerId.slice(0, 12)}...: ${err.message}`);
      }
      throw err;
    }
  }

  getOrCreatePaymentMux(peerId: PeerId, conn: BuyerConnection): PaymentMux {
    const existing = this._muxes.get(peerId);
    if (existing) return existing;

    const pmux = new PaymentMux(conn);
    this._muxes.set(peerId, pmux);

    pmux.onAuthAck((payload) => this._bpm.handleAuthAck(peerId, payload));

    pmux.onFreeUsageAck((payload) => {
      this._freeUsageManager?.handleAck(peerId, payload);
    });

    pmux.onNeedFreeUsageAuth((payload) => {
      const p = this._freeUsageManager?.handleNeedAuth(peerId, payload, pmux);
      if (p) {
        this._pendingNeedAuth.add(p);
        return p.finally(() => {
          this._pendingNeedAuth.delete(p);
        });
      }
      return undefined;
    });

    pmux.onNeedAuth((payload) => {
      const p = this._bpm.handleNeedAuth(peerId, payload, pmux);
      this._pendingNeedAuth.add(p);
      return p.finally(() => {
        this._pendingNeedAuth.delete(p);
      });
    });

    pmux.onCloseChannelResult((payload) => {
      const pending = this._pendingCloseRequests.get(peerId);
      if (!pending) {
        debugWarn(`[BuyerNegotiator] Unsolicited CloseChannelResult from ${peerId.slice(0, 12)}... — ignoring`);
        return;
      }
      if (pending.channelId.toLowerCase() !== payload.channelId.toLowerCase()) {
        debugWarn(
          `[BuyerNegotiator] CloseChannelResult from ${peerId.slice(0, 12)}... is for ` +
          `${payload.channelId.slice(0, 18)}..., expected ${pending.channelId.slice(0, 18)}... — ignoring`,
        );
        return;
      }
      clearTimeout(pending.timer);
      this._pendingCloseRequests.delete(peerId);
      pending.resolve(payload);
    });

    pmux.onPaymentRequired((payload) => {
      const pending = this._pendingPaymentRequired.get(peerId);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingPaymentRequired.delete(peerId);
        pending.resolve(payload);
      } else {
        this._bufferedPaymentRequired.set(peerId, payload);
        debugLog(`[BuyerNegotiator] PaymentRequired from ${peerId.slice(0, 12)}... buffered`);
      }
    });

    return pmux;
  }

  getPaymentMux(peerId: PeerId): PaymentMux | undefined {
    return this._muxes.get(peerId);
  }

  trackRequestBillingContext(
    request: SerializedHttpRequest,
    service: string,
    route: SelectedBillingRoute | null,
  ): void {
    if (route) {
      const captured = captureUnitBillingContext({
        sellerPeerId: route.sellerPeerId,
        provider: route.provider,
        service: route.service,
        serviceApiProtocol: route.serviceApiProtocol,
        request,
      });
      this._bpm.trackRequestBilling(request.requestId, {
        context: captured.context,
        requestFacts: captured.requestFacts,
        ...(route.unitModel ? { unitModel: route.unitModel } : {}),
        ...(route.tokenPricing ? { tokenPricing: route.tokenPricing } : {}),
      });
    } else {
      this._bpm.trackRequestService(request.requestId, service);
    }
  }

  trackFreeUsageRequestService(requestId: string, service: string): void {
    this._freeUsageManager?.trackRequestService(requestId, service);
  }

  async prepareFreeUsageOpen(peer: BuyerPeerView, conn: BuyerConnection): Promise<void> {
    if (!this._freeUsageManager) return;
    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);
    await this._freeUsageManager.prepareOpen(peer, pmux);
    void this._freeUsageManager.waitForOpenAck(peer.peerId).catch((err) => {
      debugWarn(`[BuyerNegotiator] Free usage open ack unavailable for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
    });
  }

  // ── Pre-request auth ────────────────────────────────────────

  /**
   * If this peer has an active payment session, send a per-request SpendingAuth.
   * Handles first-request skip automatically (initial auth already sent during negotiation).
   * No-ops if the peer has no established session or if cost data was already
   * consumed by sendPostResponseAuth.
   */
  async preparePreRequestAuth(peer: BuyerPeerView, conn: BuyerConnection): Promise<void> {
    if (!this._lockedPeers.has(peer.peerId)) return;
    if (!this._firstRequestSent.has(peer.peerId)) {
      this._firstRequestSent.add(peer.peerId);
      return;
    }
    // Skip if cost data was already consumed by post-response auth
    if (!this._lastResponseCost.has(peer.peerId)) return;
    await this._sendPerRequestAuth(peer.peerId, conn);
  }

  /**
   * Resolve an ambiguously delivered ReserveAuth before a reloaded browser can
   * issue its first request. Waiting for a seller 402 is insufficient: a seller
   * that committed the reserve before the browser crashed may still recognize
   * the channel and serve immediately.
   */
  async recoverPendingReserveBeforeRequest(
    peer: BuyerPeerView,
    conn: BuyerConnection,
  ): Promise<void> {
    if (!this._bpm.hasPendingReserveAuth(peer.peerId)) return;
    if (!this._channelsClient) {
      throw buyerFault(
        `Cannot recover pending reserve for ${peer.peerId.slice(0, 12)}... without an on-chain channels client`,
        'buyer-session-state',
      );
    }

    const recovered = await this._recoverExistingSession(peer, conn);
    if (!recovered && this._bpm.hasPendingReserveAuth(peer.peerId)) {
      throw buyerFault(
        `Unable to reconcile pending reserve for ${peer.peerId.slice(0, 12)}...`,
        'buyer-session-state',
      );
    }
  }

  /**
   * Send a SpendingAuth to the seller immediately after receiving a response.
   * This ensures the seller always has a valid SpendingAuth for close(),
   * even if the buyer disconnects before the next request.
   */
  async sendPostResponseAuth(peer: BuyerPeerView, conn: BuyerConnection): Promise<void> {
    await this.sendPostResponseAuthTo(peer.peerId, conn);
  }

  /** peerId-only variant of sendPostResponseAuth. */
  async sendPostResponseAuthTo(peerId: PeerId, conn: BuyerConnection): Promise<void> {
    if (!this._lockedPeers.has(peerId)) return;
    if (!this._lastResponseCost.has(peerId)) return;
    await this._sendPerRequestAuth(peerId, conn);
  }

  private async _sendPerRequestAuth(peerId: PeerId, conn: BuyerConnection): Promise<void> {
    const peer = { peerId };
    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);

    const lastCost = this._lastResponseCost.get(peer.peerId);
    const inputBytes = lastCost?.inputContent ?? new Uint8Array(0);
    const outputBytes = lastCost?.outputContent ?? new Uint8Array(0);
    const sellerClaimedCost = lastCost?.costUsdc;
    const reportedInputTokens = lastCost?.inputTokens;
    const reportedOutputTokens = lastCost?.outputTokens;
    const reportedCachedInputTokens = lastCost?.cachedInputTokens;
    const unitUsage = lastCost?.unitUsage;
    const service = lastCost?.service;
    const requestId = lastCost?.requestId;
    try {
      const { payload, topUpNeeded } = await this._bpm.signPerRequestAuth(
        peer.peerId,
        { inputBytes, outputBytes, sellerClaimedCost, reportedInputTokens, reportedOutputTokens, reportedCachedInputTokens, unitUsage, service, requestId },
      );
      pmux.sendSpendingAuth(payload);
      // Release held content to free memory — no longer needed after signing
      this._lastResponseCost.delete(peer.peerId);
      debugLog(`[BuyerNegotiator] Per-request SpendingAuth sent to ${peer.peerId.slice(0, 12)}... cumulative=${payload.cumulativeAmount}`);

      if (topUpNeeded) {
        debugLog(`[BuyerNegotiator] Reserve top-up needed for ${peer.peerId.slice(0, 12)}...`);
        await this._bpm.topUpReserve(peer.peerId, pmux);
      }
    } catch (err) {
      debugWarn(`[BuyerNegotiator] Failed to send per-request SpendingAuth: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  /**
   * Ask a seller to close the buyer's payment channel now, bypassing the
   * on-chain `requestClose()` → grace period → `withdraw()` flow.
   *
   * Resolves with the seller's verdict — `status: 'closed'` carries the
   * transaction hash. A rejection is a normal outcome (the seller may still be
   * serving requests, or be owed for work the buyer hasn't signed for), so it
   * resolves rather than throws; only "we never got an answer" throws.
   */
  async requestChannelClose(
    peerId: PeerId,
    conn: BuyerConnection,
    { includeAuth = true, timeoutMs = CLOSE_REQUEST_TIMEOUT_MS }: {
      includeAuth?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<CloseChannelResultPayload> {
    if (this._pendingCloseRequests.has(peerId)) {
      throw new Error(`A channel close request is already in flight for ${peerId.slice(0, 12)}...`);
    }

    const session = this._bpm.getActiveSession(peerId);
    if (!session) {
      throw new Error(`No active payment channel with seller ${peerId.slice(0, 12)}...`);
    }

    // Flush any SpendingAuth the buyer still owes for the last response first —
    // otherwise the seller rejects with 'pending_auth' on the very first try.
    await this.drainPendingNeedAuth();
    // A close request can carry a claimable SpendingAuth. If persisting the
    // outstanding response authorization fails, abort rather than signing and
    // transmitting another authorization from non-durable in-memory state.
    await this.sendPostResponseAuthTo(peerId, conn);

    const pmux = this.getOrCreatePaymentMux(peerId, conn);
    const payload = await this._bpm.buildCloseChannelRequest(peerId, { includeAuth });

    const result = await new Promise<CloseChannelResultPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCloseRequests.delete(peerId);
        reject(new Error(
          `Seller ${peerId.slice(0, 12)}... did not answer the channel close request within ${timeoutMs}ms. ` +
          `The channel is unchanged — retry, or fall back to the on-chain request-close flow.`,
        ));
      }, timeoutMs);
      this._pendingCloseRequests.set(peerId, { channelId: payload.channelId, resolve, reject, timer });

      try {
        pmux.sendCloseChannelRequest(payload);
        debugLog(`[BuyerNegotiator] CloseChannelRequest sent to ${peerId.slice(0, 12)}... channel=${payload.channelId.slice(0, 18)}...`);
      } catch (err) {
        clearTimeout(timer);
        this._pendingCloseRequests.delete(peerId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    if (result.status === 'closed') {
      const finalAmount = result.finalAmount != null ? safeBigInt(result.finalAmount) : null;
      this._bpm.retireSession(peerId, CHANNEL_STATUS.SETTLED, finalAmount ?? undefined);
      this._lockedPeers.delete(peerId);
      this._firstRequestSent.delete(peerId);
      this._lastResponseCost.delete(peerId);
      debugLog(
        `[BuyerNegotiator] Seller ${peerId.slice(0, 12)}... closed channel ` +
        `${result.channelId.slice(0, 18)}... at ${result.finalAmount ?? '?'} (tx=${result.txHash ?? '?'})`,
      );
      this._emit.emit('payment:channel-closed', {
        peerId,
        channelId: result.channelId,
        txHash: result.txHash,
        finalAmount: result.finalAmount,
      });
    } else {
      debugWarn(
        `[BuyerNegotiator] Seller ${peerId.slice(0, 12)}... declined to close ` +
        `${result.channelId.slice(0, 18)}...: ${result.code ?? 'unknown'} — ${result.reason ?? 'no reason given'}`,
      );
    }

    return result;
  }

  async handle402(
    response: SerializedHttpResponse,
    peer: BuyerPeerView,
    conn: BuyerConnection,
    req: SerializedHttpRequest,
  ): Promise<Handle402Result> {
    const hadLockedSession = this._lockedPeers.has(peer.peerId);
    const directPaymentBody = parsePaymentRequiredBody(response.body);
    const responseAlreadyHasRequirements = Boolean(directPaymentBody?.minBudgetPerRequest);
    const waitMs = 2_000;
    const buffered = responseAlreadyHasRequirements
      ? null
      : await this._awaitPaymentRequired(peer.peerId, conn, waitMs);
    if (buffered) this._bufferedPaymentRequired.delete(peer.peerId);

    const bodyRequirements: PaymentRequiredPayload | null = responseAlreadyHasRequirements && directPaymentBody != null
      ? {
        minBudgetPerRequest: String(directPaymentBody.minBudgetPerRequest ?? '10000'),
        suggestedAmount: String(directPaymentBody.suggestedAmount ?? '100000'),
        requestId: req.requestId,
        ...(directPaymentBody.inputUsdPerMillion != null ? { inputUsdPerMillion: Number(directPaymentBody.inputUsdPerMillion) } : {}),
        ...(directPaymentBody.outputUsdPerMillion != null ? { outputUsdPerMillion: Number(directPaymentBody.outputUsdPerMillion) } : {}),
        ...(directPaymentBody.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: Number(directPaymentBody.cachedInputUsdPerMillion) } : {}),
      }
      : null;
    const paymentRequirements = buffered ?? bodyRequirements;

    const requestedReserveAmount = (() => {
      if (!paymentRequirements) return null;
      const suggested = safeBigInt(paymentRequirements.suggestedAmount);
      if (suggested == null || suggested <= 0n) return null;
      return suggested > this._bpm.maxReserveAmountUsdc ? this._bpm.maxReserveAmountUsdc : suggested;
    })();

    // Stable machine-readable codes for the 402 body. Kept deliberately small
    // so callers (desktop UI, other SDK consumers) can switch on them without
    // being coupled to internal debug strings.
    type PaymentRequiredCode = 'insufficient_deposits';
    const returnPaymentRequired = (code: PaymentRequiredCode, debugReason: string): Handle402Result => {
      debugLog(`[BuyerNegotiator] Got 402 from ${peer.peerId.slice(0, 12)}... — returning to caller (${debugReason})`);
      // Always return a normalized buyer-authored body so the desktop UI can
      // render a proper "top up your deposits" CTA instead of the raw seller
      // 402 JSON (which leaks internal fields like requiredCumulativeAmount,
      // currentSpent, and per-service pricing).
      const req = buffered
        ?? (responseAlreadyHasRequirements && directPaymentBody != null
          ? {
            minBudgetPerRequest: directPaymentBody.minBudgetPerRequest != null
              ? String(directPaymentBody.minBudgetPerRequest)
              : undefined,
            suggestedAmount: directPaymentBody.suggestedAmount != null
              ? String(directPaymentBody.suggestedAmount)
              : undefined,
          }
          : null);
      const enrichedBody = JSON.stringify({
        error: 'payment_required',
        code,
        peerId: peer.peerId,
        ...(req?.minBudgetPerRequest != null ? { minBudgetPerRequest: req.minBudgetPerRequest } : {}),
        ...(req?.suggestedAmount != null ? { suggestedAmount: req.suggestedAmount } : {}),
        message: 'You are out of AntSeed credits for this request. Add funds in the AntSeed app, or run "antseed buyer deposit <amount>" from the CLI, then retry.',
      });
      return {
        action: 'return',
        response: {
          ...response,
          headers: {
            ...response.headers,
            'content-type': 'application/json',
            [ANTSEED_FAULT_ATTRIBUTION_HEADER]: 'buyer',
          },
          body: new TextEncoder().encode(enrichedBody),
        },
      };
    };

    const returnNegotiationFailure = (reason: string, message: string, statusCode = 409): Handle402Result => {
      debugWarn(
        `[BuyerNegotiator] Auto-negotiation failed for ${peer.peerId.slice(0, 12)}... — ` +
        `${reason}; returning non-payment error to caller`,
      );
      return {
        action: 'return',
        response: {
          ...response,
          statusCode,
          headers: { ...response.headers, 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({
            error: 'payment_negotiation_failed',
            reason,
            message,
          })),
        },
      };
    };

    // Reconcile any active stored session before opening a fresh reserve.
    const existingSessionBudgetRequest = buffered
      ? BigInt(buffered.minBudgetPerRequest)
      : responseAlreadyHasRequirements && directPaymentBody?.minBudgetPerRequest != null
        ? BigInt(String(directPaymentBody.minBudgetPerRequest))
        : null;

    // Absolute cumulative target the seller needs us to sign to unblock the
    // channel (sent by the seller in the budget-exhausted branch). When
    // present we pass it through to extendCurrentSpendingAuth so the buyer
    // catches up in one step instead of creeping by minBudgetPerRequest and
    // repeatedly being rejected as underfunded.
    const requiredCumulativeTarget = buffered?.requiredCumulativeAmount != null
      ? safeBigInt(buffered.requiredCumulativeAmount)
      : responseAlreadyHasRequirements && directPaymentBody?.requiredCumulativeAmount != null
        ? safeBigInt(String(directPaymentBody.requiredCumulativeAmount))
        : null;

    // On-chain reserve ceiling the seller is willing to accept. Used to detect
    // permanently exhausted channels (where requiredCumulativeAmount > reserveMaxAmount)
    // so the buyer doesn't loop signing higher cumulatives the seller will reject.
    const sellerReserveMax = buffered?.reserveMaxAmount != null
      ? safeBigInt(buffered.reserveMaxAmount)
      : responseAlreadyHasRequirements && directPaymentBody?.reserveMaxAmount != null
        ? safeBigInt(String(directPaymentBody.reserveMaxAmount))
        : null;
    const channelExhausted = buffered?.code === PAYMENT_CODE_CHANNEL_EXHAUSTED
      || (responseAlreadyHasRequirements && directPaymentBody?.code === PAYMENT_CODE_CHANNEL_EXHAUSTED)
      || (requiredCumulativeTarget != null && sellerReserveMax != null && requiredCumulativeTarget > sellerReserveMax);

    const hasActiveSession = hadLockedSession || this._bpm.getActiveSession(peer.peerId) != null;

    if (channelExhausted && hasActiveSession) {
      debugLog(
        `[BuyerNegotiator] Channel exhausted for ${peer.peerId.slice(0, 12)}... ` +
        `(required=${requiredCumulativeTarget ?? 'n/a'} > reserveMax=${sellerReserveMax ?? 'n/a'}) — ` +
        `retiring session and renegotiating a fresh reserve`,
      );
      // 'ghost' rather than 'settled' — buyer hasn't observed the on-chain
      // settle land. Matches the other buyer-side give-up-locally callsites.
      this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.GHOST);
      this._lockedPeers.delete(peer.peerId);
      this._firstRequestSent.delete(peer.peerId);
    } else if (hasActiveSession) {
      const recovered = await this._recoverExistingSession(
        peer,
        conn,
        existingSessionBudgetRequest,
        requiredCumulativeTarget,
        requiredCumulativeTarget == null,
      );
      if (recovered) {
        return { action: 'retry' };
      }

      if (this._bpm.getActiveSession(peer.peerId)) {
        if (await this._canRetireStaleSessionWithoutOnChainProof()) {
          this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.GHOST);
        }
      }

      if (this._bpm.getActiveSession(peer.peerId)) {
        return returnNegotiationFailure(
          'existing_channel_still_active',
          'An existing payment channel could not be recovered automatically. Close or recover the channel and retry.',
        );
      }

      this._lockedPeers.delete(peer.peerId);
      this._firstRequestSent.delete(peer.peerId);
    }

    // Check if we can pay before attempting negotiation
    if (!this._depositsClient) {
      return returnNegotiationFailure(
        'deposits_not_configured',
        'Buyer deposits are not configured, so automatic payment negotiation is unavailable.',
        503,
      );
    }

    // Check on-chain balance before sending ReserveAuth. The seller locks the full
    // reserve ceiling on-chain, so a positive-but-too-small available balance would
    // otherwise make reserve()/topUp() revert with InsufficientBalance and trigger a
    // noisy 402/auth-rejection retry loop. Skipped while the chain RPC is known
    // to be unreachable: the check is best-effort, and negotiation itself only
    // signs off-chain — a seller that can reach the chain still settles fine.
    if (this._isChainReachable && !this._isChainReachable()) {
      debugWarn(
        `[BuyerNegotiator] Chain RPC unreachable — skipping balance precheck for ${peer.peerId.slice(0, 12)}...`,
      );
    } else {
      try {
        const buyerAddr = this._identity.wallet.address;
        const balance = await this._depositsClient.getBuyerBalance(buyerAddr);
        if (balance.available <= 0n) {
          return returnPaymentRequired('insufficient_deposits', 'buyer deposits balance is zero');
        }
        if (requestedReserveAmount != null && balance.available < requestedReserveAmount) {
          return returnPaymentRequired(
            'insufficient_deposits',
            `buyer available deposits ${balance.available} are below requested reserve ${requestedReserveAmount}`,
          );
        }
      } catch (err) {
        debugWarn(`[BuyerNegotiator] Failed to check buyer balance: ${err instanceof Error ? err.message : err}`);
        this._onChainReadFailure?.();
      }
    }

    // Re-buffer the PaymentRequired so _doNegotiatePayment can consume it
    if (buffered) {
      this._bufferedPaymentRequired.set(peer.peerId, buffered);
    } else if (bodyRequirements) {
      this._bufferedPaymentRequired.set(peer.peerId, bodyRequirements);
    }

    debugLog(`[BuyerNegotiator] Got 402 from ${peer.peerId.slice(0, 12)}... — auto-negotiating payment`);
    try {
      await this._negotiatePayment(peer, conn);
      debugLog(`[BuyerNegotiator] Payment negotiated with ${peer.peerId.slice(0, 12)}...`);
      return { action: 'retry' };
    } catch (err) {
      this._lockedPeers.delete(peer.peerId);
      throw err;
    }
  }

  estimateCostFromResponse(
    peer: BuyerPeerView,
    response: SerializedHttpResponse,
    service?: string,
    requestId?: string,
  ): void {
    // Post-response cost estimation feeds the next SpendingAuth. Token pricing
    // stays on computeCostUsdc; image unit billing is an optional surcharge.
    const billingEntry = requestId ? this._bpm.getRequestBilling(requestId) : undefined;
    const requestFacts = billingEntry?.requestFacts;
    // Prefer session pricing (from PaymentRequired negotiation, includes service-specific rates)
    // over peer-level defaults which may be different from the actual service pricing.
    const unitModel = billingEntry?.unitModel;
    let unitBilling: FinalUnitBillingResult | null = null;
    if (unitModel && billingEntry) {
      try {
        unitBilling = computeFinalUnitBilling(unitModel, billingEntry.context, response, requestFacts);
      } catch (err) {
        const observed = extractUnitResponseUsage(response, requestFacts);
        if (requestId) {
          this._bpm.recordObservedUnitUsage(requestId, observed.usage);
        }
        this._bpm.recordAndPersistTokens(
          peer.peerId,
          observed.tokenUsage.inputTokens,
          observed.tokenUsage.outputTokens,
        );
        debugWarn(
          `[BuyerNegotiator] Refusing payment authorization for unpriceable response from ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`,
        );
        return;
      }
    }
    if (unitBilling && requestId) {
      this._bpm.recordObservedUnitUsage(requestId, unitBilling.usage);
    }
    const usage = unitBilling?.tokenUsage ?? parseResponseUsage(response.body);
    const pricing = billingEntry?.tokenPricing
      ?? this._bpm.getSessionPricing(peer.peerId, service)
        ?? this._peerDefaultPricing(peer);
    const tokenCostUsdc = pricing
      ? computeCostUsdc(usage.freshInputTokens, usage.outputTokens, pricing, usage.cachedInputTokens)
      : 0n;
    const unitCostUsdc = unitBilling?.costUsdc ?? 0n;
    const costUsdc = tokenCostUsdc + unitCostUsdc;
    if (costUsdc <= 0n && !pricing && !unitBilling) return;

    this._lastResponseCost.set(peer.peerId, {
      costUsdc,
      inputTokens: BigInt(usage.inputTokens),
      outputTokens: BigInt(usage.outputTokens),
      cachedInputTokens: BigInt(usage.cachedInputTokens),
      ...(unitBilling ? { unitUsage: unitBilling.usage } : {}),
      cumulativeCost: 0n,
      inputContent: new Uint8Array(0),
      outputContent: response.body,
      latencyMs: 0,
      service,
      requestId,
    });

    debugLog(
      `[BuyerNegotiator] Estimated cost for ${peer.peerId.slice(0, 12)}...: ` +
      `cost=${costUsdc} token=${tokenCostUsdc} unit=${unitCostUsdc} (in=${usage.freshInputTokens} cached=${usage.cachedInputTokens} out=${usage.outputTokens})`,
    );

    this._bpm.recordAndPersistTokens(peer.peerId, usage.inputTokens, usage.outputTokens);
  }

  // parseCostHeaders removed — cost data now flows through NeedAuth on PaymentMux.

  recordResponseContent(peerId: string, reqBody: Uint8Array, resBody: Uint8Array, latencyMs: number): void {
    debugLog(
      `[BuyerNegotiator] recordResponseContent: reqBody=${reqBody.length}B resBody=${resBody.length}B latency=${latencyMs}ms`,
    );
    const existing = this._lastResponseCost.get(peerId);
    if (existing) {
      this._lastResponseCost.set(peerId, {
        ...existing,
        inputContent: reqBody,
        outputContent: resBody,
        latencyMs,
      });
    }
  }

  async applyExternalSpendingAuth(
    peer: BuyerPeerView,
    conn: BuyerConnection,
    headerValue: string,
  ): Promise<void> {
    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);

    let payload: {
      channelId: string;
      cumulativeAmount: string;
      metadataHash: string;
      metadata: string;
      spendingAuthSig: string;
      reserveSalt?: string;
      reserveMaxAmount?: string;
      reserveDeadline?: number;
    };
    try {
      const decodedBytes = Uint8Array.from(atob(headerValue), (character) => character.charCodeAt(0));
      const decoded = new TextDecoder().decode(decodedBytes);
      payload = parseJsonObject(decoded) as typeof payload;
    } catch {
      throw buyerFault(
        'Invalid x-antseed-spending-auth header: failed to decode',
        'invalid-spending-auth-header',
      );
    }

    debugLog(`[BuyerNegotiator] External SpendingAuth: channel=${payload.channelId.slice(0, 18)}... amount=${payload.cumulativeAmount}`);

    const sellerEvmAddrExternal = await this._resolveSellerAddr(peer);

    // Store session so handleAuthAck can find it
    if (this._channelStore) {
      const reserveDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
      const externalChannel: StoredChannel = {
        sessionId: payload.channelId,
        peerId: peer.peerId,
        role: CHANNEL_ROLE.BUYER,
        sellerEvmAddr: sellerEvmAddrExternal,
        buyerEvmAddr: this._identity.wallet.address,
        nonce: 0,
        authMax: payload.cumulativeAmount,
        deadline: reserveDeadline,
        previousSessionId: '0x' + '0'.repeat(64),
        previousConsumption: '0',
        tokensDelivered: '0',
        requestCount: 0,
        reservedAt: Date.now(),
        settledAt: null,
        settledAmount: null,
        status: CHANNEL_STATUS.ACTIVE,
        latestBuyerSig: payload.spendingAuthSig,
        latestSpendingAuthSig: payload.reserveSalt ? null : payload.spendingAuthSig,
        latestMetadata: payload.metadata,
        ...(payload.reserveSalt
          ? {
              reserveSalt: payload.reserveSalt,
              initialReserveAmount: payload.reserveMaxAmount ?? null,
              reserveMaxAmount: payload.reserveMaxAmount ?? null,
              latestReserveAuthSig: payload.spendingAuthSig,
              latestReserveDeadline: reserveDeadline,
              reserveAuthPending: true,
              confirmedReserveAmount: '0',
            }
          : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (this._channelStore.commitAuthorization) {
        await this._channelStore.commitAuthorization(externalChannel);
      } else {
        this._channelStore.upsertChannel(externalChannel);
        await this._channelStore.flush?.();
      }
      this._bpm.adoptPersistedAuthorization(externalChannel);
    }

    pmux.sendSpendingAuth(payload);
    debugLog(`[BuyerNegotiator] External SpendingAuth sent to seller ${peer.peerId.slice(0, 12)}..., waiting for AuthAck...`);

    let reserveCtxAmount: bigint | undefined;
    try {
      reserveCtxAmount = payload.reserveMaxAmount != null
        ? BigInt(payload.reserveMaxAmount)
        : BigInt(payload.cumulativeAmount);
    } catch {
      reserveCtxAmount = undefined;
    }
    await this._waitForLockConfirmation(peer.peerId, { requestedReserve: reserveCtxAmount });
    debugLog(`[BuyerNegotiator] AuthAck received from seller ${peer.peerId.slice(0, 12)}...`);
    this._lockedPeers.add(peer.peerId);

    this._emit.emit('payment:signed', {
      peerId: peer.peerId,
      sellerEvmAddr: sellerEvmAddrExternal,
      amount: payload.cumulativeAmount,
    });
  }

  onPeerDisconnect(peerId: PeerId): void {
    this._muxes.delete(peerId);
    this._bufferedPaymentRequired.delete(peerId);

    // Cancel any in-flight PaymentRequired wait
    const pendingPR = this._pendingPaymentRequired.get(peerId);
    if (pendingPR) {
      clearTimeout(pendingPR.timer);
      this._pendingPaymentRequired.delete(peerId);
      pendingPR.reject(new Error(`Peer ${peerId.slice(0, 12)}... disconnected during payment negotiation`));
    }

    const pendingClose = this._pendingCloseRequests.get(peerId);
    if (pendingClose) {
      clearTimeout(pendingClose.timer);
      this._pendingCloseRequests.delete(peerId);
      pendingClose.reject(new Error(`Peer ${peerId.slice(0, 12)}... disconnected before answering the channel close request`));
    }

    this._lockedPeers.delete(peerId);
    this._firstRequestSent.delete(peerId);
    this._lastResponseCost.delete(peerId);
  }

  /** Wait for in-flight NeedAuth handlers to complete (settlement safety). */
  async drainPendingNeedAuth(): Promise<void> {
    // Handlers can enqueue more work while an earlier snapshot is settling.
    // Keep draining until the tracker is empty; the caller can then synchronously
    // close transports before another WebRTC message task is dispatched.
    while (this._pendingNeedAuth.size > 0) {
      const pending = [...this._pendingNeedAuth.values()];
      await Promise.allSettled(pending);
    }
  }

  cleanup(): void {
    this._lockedPeers.clear();
    this._firstRequestSent.clear();
    this._lastResponseCost.clear();
    this._muxes.clear();

    for (const [, pending] of this._pendingPaymentRequired) {
      clearTimeout(pending.timer);
      pending.reject(buyerFault('Node stopped', 'node-stopped'));
    }
    this._pendingPaymentRequired.clear();
    this._bufferedPaymentRequired.clear();
    this._negotiationLocks.clear();

    for (const [, pending] of this._pendingCloseRequests) {
      clearTimeout(pending.timer);
      pending.reject(buyerFault('Node stopped', 'node-stopped'));
    }
    this._pendingCloseRequests.clear();
  }

  private _peerDefaultPricing(peer: BuyerPeerView): ServicePricing | undefined {
    if (peer.defaultInputUsdPerMillion == null && peer.defaultOutputUsdPerMillion == null) {
      return undefined;
    }
    return {
      inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
      outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
      cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
    };
  }

  /**
   * Build the full pricing map from peer metadata (defaults + all per-service overrides).
   * This ensures the buyer knows pricing for every service the seller offers,
   * not just the one that triggered the 402.
   */
  private _buildPricingMap(peer: BuyerPeerView): { defaults: ServicePricing; services: Record<string, ServicePricing> } | undefined {
    const defaults: ServicePricing = {
      inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
      outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
      cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
    };
    if (defaults.inputUsdPerMillion === 0 && defaults.outputUsdPerMillion === 0 && !peer.providerPricing) {
      return undefined;
    }

    const services: Record<string, ServicePricing> = {};
    if (peer.providerPricing) {
      for (const entry of Object.values(peer.providerPricing)) {
        if (entry.services) {
          for (const [serviceName, sp] of Object.entries(entry.services)) {
            services[serviceName] = {
              inputUsdPerMillion: sp.inputUsdPerMillion,
              outputUsdPerMillion: sp.outputUsdPerMillion,
              cachedInputUsdPerMillion: sp.cachedInputUsdPerMillion,
            };
          }
        }
      }
    }

    return { defaults, services };
  }

  private async _negotiatePayment(peer: BuyerPeerView, conn: BuyerConnection): Promise<void> {
    // Per-peer mutex: if another request is already negotiating, wait for it
    const existing = this._negotiationLocks.get(peer.peerId);
    if (existing) {
      await existing;
      return;
    }

    const negotiation = this._doNegotiatePayment(peer, conn);
    this._negotiationLocks.set(peer.peerId, negotiation);
    try {
      await negotiation;
    } finally {
      this._negotiationLocks.delete(peer.peerId);
    }
  }

  private async _doNegotiatePayment(peer: BuyerPeerView, conn: BuyerConnection): Promise<void> {
    if (this._lockedPeers.has(peer.peerId)) return;

    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);

    // Check if PaymentRequired was already buffered
    const buffered = this._bufferedPaymentRequired.get(peer.peerId);
    if (buffered) {
      this._bufferedPaymentRequired.delete(peer.peerId);
      debugLog(`[BuyerNegotiator] Using buffered PaymentRequired from ${peer.peerId.slice(0, 12)}...`);
    }

    const PAYMENT_REQUIRED_TIMEOUT_MS = 10_000;
    const requirements = buffered ?? await new Promise<PaymentRequiredPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingPaymentRequired.delete(peer.peerId);
        reject(new Error(`PaymentRequired timeout from seller ${peer.peerId.slice(0, 12)}...`));
      }, PAYMENT_REQUIRED_TIMEOUT_MS);
      this._pendingPaymentRequired.set(peer.peerId, { resolve, reject, timer });
    });

    debugLog(`[BuyerNegotiator] PaymentRequired from ${peer.peerId.slice(0, 12)}...: minBudgetPerRequest=${requirements.minBudgetPerRequest} suggested=${requirements.suggestedAmount}`);

    // Validate seller's per-request minimum
    const minBudgetPerRequest = BigInt(requirements.minBudgetPerRequest);
    if (minBudgetPerRequest > this._bpm.maxPerRequestUsdc) {
      throw buyerFault(
        `Seller ${peer.peerId.slice(0, 12)}... minBudgetPerRequest=${minBudgetPerRequest} exceeds buyer maxPerRequestUsdc=${this._bpm.maxPerRequestUsdc}`,
        'buyer-budget-too-low',
      );
    }

    // Cap amount at buyer's maxReserveAmountUsdc
    let amount: bigint;
    try {
      amount = BigInt(requirements.suggestedAmount);
    } catch {
      throw peerFault(
        `Invalid suggestedAmount from seller ${peer.peerId.slice(0, 12)}...: "${requirements.suggestedAmount}"`,
        'peer-protocol-violation',
      );
    }
    if (amount > this._bpm.maxReserveAmountUsdc) {
      amount = this._bpm.maxReserveAmountUsdc;
    }
    if (amount <= 0n) {
      throw buyerFault(
        `Invalid reserve amount for payment to ${peer.peerId.slice(0, 12)}...`,
        'buyer-reserve-misconfigured',
      );
    }

    const sellerEvmAddr = await this._resolveSellerAddr(peer);

    this._emit.emit('payment:required', {
      peerId: peer.peerId,
      sellerEvmAddr,
      minBudgetPerRequest: requirements.minBudgetPerRequest,
      suggestedAmount: amount.toString(),
    });

    // Extract pricing from seller's PaymentRequired or peer metadata
    const pricing = (requirements.inputUsdPerMillion != null || requirements.outputUsdPerMillion != null)
      ? {
          inputUsdPerMillion: requirements.inputUsdPerMillion ?? peer.defaultInputUsdPerMillion ?? 0,
          outputUsdPerMillion: requirements.outputUsdPerMillion ?? peer.defaultOutputUsdPerMillion ?? 0,
          cachedInputUsdPerMillion: requirements.cachedInputUsdPerMillion ?? peer.defaultCachedInputUsdPerMillion,
        }
      : (peer.defaultInputUsdPerMillion != null || peer.defaultOutputUsdPerMillion != null)
        ? {
            inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
            outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
            cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
          }
        : undefined;

    // Build full pricing map from peer metadata (defaults + all per-service overrides)
    const pricingMap = this._buildPricingMap(peer);

    try {
      await this._bpm.authorizeSpending(peer.peerId, pmux, minBudgetPerRequest, amount, pricing, pricingMap, peer.metadata);
      debugLog(`[BuyerNegotiator] SpendingAuth sent to seller ${peer.peerId.slice(0, 12)}..., waiting for AuthAck...`);

      await this._waitForLockConfirmation(peer.peerId, { requestedReserve: amount, minBudgetPerRequest });
      debugLog(`[BuyerNegotiator] AuthAck received from seller ${peer.peerId.slice(0, 12)}...`);
      this._lockedPeers.add(peer.peerId);

      this._emit.emit('payment:signed', {
        peerId: peer.peerId,
        sellerEvmAddr,
        amount: amount.toString(),
      });
    } catch (err) {
      debugWarn(`[BuyerNegotiator] Payment negotiation failed for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  private async _awaitPaymentRequired(
    peerId: PeerId,
    conn: BuyerConnection,
    timeoutMs: number,
  ): Promise<PaymentRequiredPayload | null> {
    const buffered = this._bufferedPaymentRequired.get(peerId);
    if (buffered) return buffered;

    // Ensure the buyer-side PaymentMux exists before waiting
    this.getOrCreatePaymentMux(peerId, conn);

    return await new Promise<PaymentRequiredPayload | null>((resolve) => {
      const already = this._bufferedPaymentRequired.get(peerId);
      if (already) {
        resolve(already);
        return;
      }

      const existing = this._pendingPaymentRequired.get(peerId);
      if (existing) {
        const wrapper = {
          resolve: (payload: PaymentRequiredPayload) => {
            clearTimeout(existing.timer);
            clearTimeout(wrapper.timer);
            if (this._pendingPaymentRequired.get(peerId) === wrapper) {
              this._pendingPaymentRequired.delete(peerId);
            }
            existing.resolve(payload);
            resolve(payload);
          },
          reject: (err: Error) => {
            clearTimeout(existing.timer);
            clearTimeout(wrapper.timer);
            if (this._pendingPaymentRequired.get(peerId) === wrapper) {
              this._pendingPaymentRequired.delete(peerId);
            }
            existing.reject(err);
            resolve(null);
          },
          timer: setTimeout(() => {
            clearTimeout(existing.timer);
            if (this._pendingPaymentRequired.get(peerId) === wrapper) {
              this._pendingPaymentRequired.delete(peerId);
            }
            resolve(null);
          }, timeoutMs),
        };
        this._pendingPaymentRequired.set(peerId, wrapper);
        return;
      }

      const timer = setTimeout(() => {
        if (this._pendingPaymentRequired.get(peerId)?.timer === timer) {
          this._pendingPaymentRequired.delete(peerId);
        }
        resolve(null);
      }, timeoutMs);
      this._pendingPaymentRequired.set(peerId, {
        resolve: (payload) => {
          clearTimeout(timer);
          if (this._pendingPaymentRequired.get(peerId)?.timer === timer) {
            this._pendingPaymentRequired.delete(peerId);
          }
          resolve(payload);
        },
        reject: () => {
          clearTimeout(timer);
          if (this._pendingPaymentRequired.get(peerId)?.timer === timer) {
            this._pendingPaymentRequired.delete(peerId);
          }
          resolve(null);
        },
        timer,
      });
    });
  }

  private async _recoverExistingSession(
    peer: BuyerPeerView,
    conn: BuyerConnection,
    minBudgetPerRequest: bigint | null = null,
    targetCumulative: bigint | null = null,
    requireFreshAck = false,
  ): Promise<boolean> {
    const session = this._bpm.getActiveSession(peer.peerId);
    if (!session) {
      return false;
    }

    if (!this._channelsClient) {
      this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.GHOST);
      return false;
    }

    const onChain = await this._getOnChainSessionState(session.sessionId);
    if (onChain === null) {
      return false;
    }

    if (!onChain.exists) {
      if (this._bpm.canReplayReserveAuth(peer.peerId)) {
        const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);
        await this._bpm.resendReserveAuth(peer.peerId, pmux);
        await this._waitForLockConfirmation(peer.peerId, {
          minBudgetPerRequest: minBudgetPerRequest ?? undefined,
        });
        this._lockedPeers.add(peer.peerId);
        return true;
      }

      this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.GHOST);
      return false;
    }

    if (onChain.status === CHANNEL_STATUS.SETTLED) {
      this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.SETTLED, onChain.channel.settled);
      return false;
    }

    if (onChain.status === CHANNEL_STATUS.TIMEOUT) {
      this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.TIMEOUT);
      return false;
    }

    if (onChain.status !== 'active') {
      this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.GHOST);
      return false;
    }

    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);
    await this._bpm.reconcileReserveAmount(peer.peerId, onChain.channel.deposit);
    const hasPendingReserve = this._bpm.hasPendingReserveAuth(peer.peerId);
    let recoveredBeforeTopUp = false;
    if (requireFreshAck) {
      // A 402 with only base PaymentRequired fields while the buyer has an
      // active local session means the seller does not currently recognize
      // the channel (for example after a seller restart). The previous
      // AuthAck is stale in that case; require a fresh one before retrying so
      // we do not immediately replay the request into another 402.
      this._bpm.clearLockConfirmation(peer.peerId);
      if (hasPendingReserve) {
        await this._bpm.resendCurrentSpendingAuth(peer.peerId, pmux);
        await this._waitForLockConfirmation(peer.peerId, {
          minBudgetPerRequest: minBudgetPerRequest ?? undefined,
        });
        recoveredBeforeTopUp = true;
      }
    }
    if (hasPendingReserve) {
      await this._bpm.resendPendingReserveAuth(peer.peerId, pmux);
    }
    if (!requireFreshAck && minBudgetPerRequest != null && minBudgetPerRequest > 0n) {
      const cumulativeBefore = this._bpm.getCumulativeAmount(peer.peerId);
      await this._bpm.extendCurrentSpendingAuth(
        peer.peerId,
        minBudgetPerRequest,
        pmux,
        targetCumulative != null && targetCumulative > 0n ? targetCumulative : undefined,
      );
      const cumulativeAfter = this._bpm.getCumulativeAmount(peer.peerId);
      if (cumulativeAfter <= cumulativeBefore) {
        // extendCurrentSpendingAuth was a no-op — the overdraft window and reserve ceiling
        // are both wedged. Retire the session so the caller negotiates a fresh channel
        // instead of spinning in an infinite 402 retry loop.
        debugWarn(
          `[BuyerNegotiator] extendCurrentSpendingAuth made no progress for ${peer.peerId.slice(0, 12)}... ` +
          `(cumulative=${cumulativeAfter}); retiring session`,
        );
        this._bpm.retireSession(peer.peerId, CHANNEL_STATUS.GHOST);
        this._lockedPeers.delete(peer.peerId);
        this._firstRequestSent.delete(peer.peerId);
        return false;
      }
    } else if (!recoveredBeforeTopUp) {
      await this._bpm.resendCurrentSpendingAuth(peer.peerId, pmux);
    }
    await this._waitForLockConfirmation(peer.peerId, {
      minBudgetPerRequest: minBudgetPerRequest ?? undefined,
    });
    this._lockedPeers.add(peer.peerId);
    return true;
  }

  private async _canRetireStaleSessionWithoutOnChainProof(): Promise<boolean> {
    const depositsClient = this._depositsClient;
    if (!depositsClient) {
      return false;
    }

    try {
      const balance = await depositsClient.getBuyerBalance(this._identity.wallet.address);
      return balance.reserved === 0n;
    } catch (err) {
      debugWarn(
        `[BuyerNegotiator] Failed to verify buyer reserved balance while checking stale session: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  private async _getOnChainSessionState(channelId: string): Promise<
    | null
    | ReturnType<typeof classifyOnChainChannel>
  > {
    try {
      const channelsClient = this._channelsClient;
      if (!channelsClient) {
        return null;
      }

      return classifyOnChainChannel(await channelsClient.getSession(channelId));
    } catch (err) {
      debugWarn(`[BuyerNegotiator] Failed to load on-chain channel ${channelId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async _waitForLockConfirmation(
    sellerPeerId: string,
    ctx?: { requestedReserve?: bigint; minBudgetPerRequest?: bigint },
  ): Promise<void> {
    const pollIntervalMs = 200;
    const timeoutMs = 30_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this._bpm.isLockConfirmed(sellerPeerId)) return;
      if (this._bpm.isLockRejected(sellerPeerId)) {
        throw new Error(
          `Lock rejected by seller ${sellerPeerId.slice(0, 12)}...${this._buildLockFailureHint(ctx)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Lock confirmation timed out for seller ${sellerPeerId.slice(0, 12)}... (${timeoutMs}ms).${this._buildLockFailureHint(ctx)}`,
    );
  }

  /**
   * Build a human-readable hint appended to lock-confirmation failures,
   * listing the most likely causes so operators don't have to guess.
   *
   * Note: this intentionally does NOT call the buyer's RPC. The buyer's RPC
   * is typically less reliable than the seller's, and the seller is the one
   * making the on-chain call that is failing — it has the exact revert reason
   * and a fresh deposits snapshot. A follow-up will plumb a structured
   * AuthNack frame from the seller carrying that information; this hint
   * exists so the surrounding error shape is already in place when that
   * lands.
   */
  private _buildLockFailureHint(
    ctx?: { requestedReserve?: bigint; minBudgetPerRequest?: bigint },
  ): string {
    const lines: string[] = [];

    // We don't know the buyer's live balance here — only what we asked for.
    // The binding on-chain constraint is lockForChannel(buyer, maxAmount) in
    // reserve() / topUp(); settle()/close() cannot throw InsufficientBalance
    // because their charges come from already-locked reserve. So the ceiling
    // we need the buyer to have covered is requestedReserve.
    const reserve = ctx?.requestedReserve;
    const min = ctx?.minBudgetPerRequest;
    if (reserve != null && reserve > 0n) {
      lines.push(
        `- Deposits may be below the reserve ceiling the seller will lock ` +
        `(${formatUsdc(reserve)} USDC). The seller's on-chain reserve() reverts ` +
        `with InsufficientBalance before AuthAck. ` +
        `Check with "antseed buyer status"; top up with "antseed buyer deposit <amount>".`,
      );
    } else if (min != null && min > 0n) {
      lines.push(
        `- Deposits may be below seller minBudgetPerRequest (${formatUsdc(min)} USDC). ` +
        `Check with "antseed buyer status"; top up with "antseed buyer deposit <amount>".`,
      );
    }
    lines.push('- Seller may be overloaded or gated on subscription (try another peer).');
    lines.push('- Seller may be online but the payment process stalled (retry, or pin a different peer).');

    return `\nLikely causes:\n  ${lines.join('\n  ')}`;
  }

}
