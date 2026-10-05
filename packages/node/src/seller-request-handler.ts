import type { PeerAnnouncer } from './discovery/announcer.js';
import type {
  Provider,
  ProviderStreamCallbacks,
} from './interfaces/seller-provider.js';
import { ANTSEED_ATTEST_PATH, type Prover } from './interfaces/plugin.js';
import type { SellerSessionTracker } from './metering/seller-session-tracker.js';
import type { PaymentMux } from './p2p/payment-mux.js';
import type { Identity } from './p2p/identity.js';
import type { ChannelsClient } from './payments/evm/channels-client.js';
import type { SellerPaymentManager } from './payments/seller-payment-manager.js';
import type { SellerFreeUsageManager } from './payments/seller-free-usage-manager.js';
import type { FreeTierDecision, SellerFreeTierLimiter } from './payments/seller-free-tier-limiter.js';
import { ProxyMux } from './proxy/proxy-mux.js';
import type { PeerConnection } from './p2p/connection-manager.js';
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
} from './types/http.js';
import {
  computeCostUsdc,
  estimateTokensFromBytes,
} from './payments/pricing.js';
import { debugLog, debugWarn } from './utils/debug.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, PAYMENT_CODE_CHANNEL_EXHAUSTED } from './types/protocol.js';
import { VerificationMux } from './verification/verification-mux.js';
import { createResponseAuthPayload } from './verification/response-auth.js';
import { hasJsonContentType, tryParseJsonObject } from './utils/json-codec.js';
import type { UnitBillingContext, UnitBillingModelV1, UnitBillingUsage, UnitBillingUsageReportV1 } from './types/billing.js';
import { captureUnitBillingContext, computeFinalUnitBilling, evaluateUnitBilling, isFreeUnitBillingModel } from './billing/unit.js';
import type { ImageRequestFacts } from '@antseed/api-adapter';
import type { ServiceApiProtocol } from './types/service-api.js';
import {
  detectRequestServiceApiProtocol,
  extractRequestBodyFields,
  selectTargetProtocolForRequest,
} from '@antseed/api-adapter';
import { parseResponseUsage } from './utils/response-usage.js';

type ProviderTokenPricing = import('./interfaces/seller-provider.js').ProviderTokenPricingUsdPerMillion;

function isZeroTokenPricing(pricing: ProviderTokenPricing): boolean {
  return pricing.inputUsdPerMillion === 0
    && pricing.outputUsdPerMillion === 0
    && (pricing.cachedInputUsdPerMillion == null || pricing.cachedInputUsdPerMillion === 0);
}

export interface SellerRequestHandlerDeps {
  identity: Identity;
  providers: Provider[];
  provers?: Prover[];
  sellerPaymentManager: SellerPaymentManager | null;
  sellerFreeUsageManager?: SellerFreeUsageManager | null;
  sellerFreeTierLimiter?: SellerFreeTierLimiter | null;
  sessionTracker: SellerSessionTracker | null;
  channelsClient: ChannelsClient | null;
  announcer: PeerAnnouncer | null;
  maxUploadBodyBytes?: number;
  reserveEstimateOverdraftUsdc?: bigint;
  emit: (event: string, ...args: unknown[]) => boolean;
}

interface SellerBillingContext {
  context: UnitBillingContext;
  requestUsage: UnitBillingUsage;
  requestFacts: ImageRequestFacts;
}

/** Debounce interval for metadata refresh after load changes. */
const METADATA_REFRESH_DEBOUNCE_MS = 200;
/** Time to wait for a catch-up SpendingAuth before returning 402. */
const DEFAULT_CATCH_UP_WAIT_MS = 5_000;
/** Per-buyer rate limit for the free attestation route. */
const ATTEST_RATE_WINDOW_MS = 60_000;
const ATTEST_RATE_MAX_PER_WINDOW = 10;
const ATTEST_RATE_MAX_TRACKED_PEERS = 1024;
/**
 * Handles all seller-side request processing: provider matching, execution,
 * cost tracking, payment auth checks, and load management.
 *
 * Extracted from AntseedNode to isolate seller request handling from core
 * node orchestration.
 */
export class SellerRequestHandler {
  private readonly _deps: SellerRequestHandlerDeps;
  private readonly _providerLoadCounts = new Map<string, number>();
  private readonly _attestRateWindows = new Map<string, { start: number; count: number }>();
  private _metadataRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SellerRequestHandlerDeps) {
    this._deps = deps;
  }

  private _allowAttest(buyerPeerId: string): boolean {
    const now = Date.now();
    const win = this._attestRateWindows.get(buyerPeerId);
    if (!win || now - win.start >= ATTEST_RATE_WINDOW_MS) {
      if (this._attestRateWindows.size >= ATTEST_RATE_MAX_TRACKED_PEERS) {
        for (const [peer, w] of this._attestRateWindows) {
          if (now - w.start >= ATTEST_RATE_WINDOW_MS) this._attestRateWindows.delete(peer);
        }
        if (!this._attestRateWindows.has(buyerPeerId) && this._attestRateWindows.size >= ATTEST_RATE_MAX_TRACKED_PEERS) {
          return false;
        }
      }
      this._attestRateWindows.set(buyerPeerId, { start: now, count: 1 });
      return true;
    }
    if (win.count >= ATTEST_RATE_MAX_PER_WINDOW) return false;
    win.count += 1;
    return true;
  }

  /**
   * Wire up the ProxyMux and PaymentMux for a new incoming connection.
   * Registers the onProxyRequest handler that routes requests to providers.
   */
  handleConnection(
    conn: PeerConnection,
    buyerPeerId: string,
    paymentMux: PaymentMux,
    verificationMux: VerificationMux,
  ): { mux: ProxyMux } {
    const mux = new ProxyMux(conn, {
      maxUploadBodyBytes: this._deps.maxUploadBodyBytes,
    });

    mux.onProxyRequest(async (request: SerializedHttpRequest) => {
      debugLog(`[SellerHandler] Received request: ${request.method} ${request.path} (reqId=${request.requestId.slice(0, 8)})`);

      // Handle /v1/models locally — free metadata endpoint, no payment required.
      // Compare against the path without its query string so callers like
      // Codex CLI (which appends `?client_version=…`) hit the local fast path.
      const pathOnly = request.path.split('?')[0] ?? request.path;
      if (request.method === 'GET' && (pathOnly === '/v1/models' || pathOnly.startsWith('/v1/models/'))) {
        const modelsResponse = this._handleModelsRequest(request);
        mux.sendProxyResponse(modelsResponse);
        return;
      }

      if (pathOnly.startsWith(ANTSEED_ATTEST_PATH + '/')) {
        let verifierId: string;
        try {
          verifierId = decodeURIComponent(pathOnly.slice((ANTSEED_ATTEST_PATH + '/').length));
        } catch {
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 400,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({
              error: { message: 'Malformed attestation path.', type: 'invalid_request_error' },
            })),
          });
          return;
        }
        const prover = (this._deps.provers ?? []).find((p) => p.name === verifierId);
        if (!prover) {
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 404,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({
              error: { message: `No prover for verifier "${verifierId}".`, type: 'verifier_error', code: 'prover_not_found' },
            })),
          });
          return;
        }
        // Rate-limit only the expensive path (quote generation); cheap 400/404
        // rejections above don't consume a buyer's attestation quota.
        if (!this._allowAttest(buyerPeerId)) {
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 429,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({
              error: { message: 'Attestation rate limit exceeded.', type: 'rate_limit_error' },
            })),
          });
          return;
        }
        try {
          const resp = await prover.prove({
            method: request.method,
            path: request.path,
            headers: request.headers,
            body: request.body,
          });
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: resp.statusCode,
            headers: resp.headers,
            body: resp.body,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 500,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({
              error: { message: `Prover failed: ${message}`, type: 'verifier_error' },
            })),
          });
        }
        return;
      }

      // Match the requested model to one of our published services BEFORE any
      // payment handshake or upstream forwarding. Rejecting unknown/missing
      // models locally avoids reserving payment for something we won't serve
      // and surfaces a clear error instead of an opaque upstream 4xx.
      const provider = this.matchProvider(request);
      if (!provider) {
        const requestedService = this._extractRequestedService(request);
        const allServices = this._deps.providers.flatMap((p) => p.services);
        const errorMessage = requestedService === null
          ? 'Request must include a "service" or "model" field matching a published service.'
          : `Service "${requestedService}" is not served by this peer.`;
        debugWarn(`[SellerHandler] Rejecting: ${errorMessage} available=[${allServices.join(', ')}]`);
        mux.sendProxyResponse({
          requestId: request.requestId,
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({
            error: {
              message: errorMessage,
              type: 'invalid_request_error',
              code: requestedService === null ? 'model_required' : 'model_not_found',
            },
          })),
        });
        return;
      }

      const requestPricing = this.resolveProviderPricing(provider, request);
      const requestBilling = this._captureSellerBillingContext(provider, request);
      const unitBillingModel = requestBilling
        ? this.resolveProviderUnitBillingModel(provider, requestBilling.context)
        : undefined;
      const isFreeService = isZeroTokenPricing(requestPricing)
        && (!unitBillingModel || isFreeUnitBillingModel(unitBillingModel));

      if (isFreeService && this._deps.sellerFreeTierLimiter) {
        const requestedService = this._extractRequestedService(request) ?? 'unknown';
        let decision: FreeTierDecision;
        try {
          decision = this._deps.sellerFreeTierLimiter.consume({
            buyerPeerId,
            service: requestedService,
            remoteIp: conn.remoteAddress ?? null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debugWarn(`[SellerHandler] Free-tier accounting failed for ${buyerPeerId.slice(0, 12)}...: ${message}`);
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 503,
            headers: { 'content-type': 'application/json', 'retry-after': '5' },
            body: new TextEncoder().encode(JSON.stringify({
              error: {
                message: 'Seller free-tier accounting is temporarily unavailable.',
                type: 'service_unavailable_error',
                code: 'free_tier_unavailable',
              },
            })),
          });
          return;
        }
        if (!decision.allowed) {
          const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
          const limiter = this._deps.sellerFreeTierLimiter;
          const limitedBy = decision.limitedBy ?? 'address';
          const limit = limitedBy === 'ip' ? limiter.maxRequestsPerIp : limiter.maxRequestsPerAddress;
          debugLog(
            `[SellerHandler] Free tier exhausted for ${decision.buyerAddress} ip=${decision.remoteIp ?? 'unknown'} ` +
            `(limitedBy=${limitedBy}, limit=${limit}, windowMs=${limiter.windowMs})`,
          );
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': String(retryAfterSeconds),
            },
            body: new TextEncoder().encode(JSON.stringify({
              error: {
                message: limitedBy === 'ip'
                  ? 'This seller free tier has been exhausted for your IP address.'
                  : 'This seller free tier has been exhausted for your buyer address.',
                type: 'rate_limit_error',
                code: 'free_tier_exhausted',
              },
              limitedBy,
              limit,
              windowMs: limiter.windowMs,
              retryAfterSeconds,
            })),
          });
          return;
        }
      }

      // Reject with 402 if no active payment session and channels client is configured.
      const spm = this._deps.sellerPaymentManager;
      const spmAuthorized = spm?.hasSession(buyerPeerId) ?? false;
      if (this._deps.channelsClient && !spmAuthorized) {
        // Free services skip the payment channel handshake entirely — no 402,
        // no ReserveAuth, no on-chain reserve.
        if (isFreeService) {
          debugLog(`[SellerHandler] Free service for ${buyerPeerId.slice(0, 12)}... — skipping 402 / payment channel`);
        } else {
          const requirements = spm?.getPaymentRequirements(
            request.requestId, buyerPeerId, requestPricing,
          );
          if (requirements) {
            debugLog(`[SellerHandler] No payment session for ${buyerPeerId.slice(0, 12)}... — sending 402 + PaymentRequired`);
            const paymentBody = JSON.stringify({
              error: 'payment_required',
              minBudgetPerRequest: requirements.minBudgetPerRequest,
              suggestedAmount: requirements.suggestedAmount,
              ...(requirements.inputUsdPerMillion != null ? { inputUsdPerMillion: requirements.inputUsdPerMillion } : {}),
              ...(requirements.outputUsdPerMillion != null ? { outputUsdPerMillion: requirements.outputUsdPerMillion } : {}),
              ...(requirements.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: requirements.cachedInputUsdPerMillion } : {}),
            });
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 402,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(paymentBody),
            });
            this._sendPaymentRequiredBestEffort(paymentMux, requirements, buyerPeerId, 'missing-session');
          } else {
            debugWarn(`[SellerHandler] No payment session — returning 402`);
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 402,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify({
                error: 'payment_required',
                message: 'Seller not ready, try again later',
              })),
            });
          }
          return;
        }
      }

      // Check budget before routing — reject if buyer hasn't authorized enough.
      // Free requests must not be blocked by an existing exhausted/blocked paid
      // payment channel for the same buyer.
      if (spm && !isFreeService) {
        const initialSession = spm.getChannelByPeer(buyerPeerId);
        if (initialSession) {
          // Drain any in-flight SpendingAuth processing (e.g. an on-chain top-up
          // that has queued later auths behind its per-buyer mutex) so we don't
          // 402 against a stale accepted cumulative.
          await spm.waitForPendingAuths(buyerPeerId);
          // Re-read after the await — the session may have been evicted (timeout
          // checker, disconnect) while the on-chain top-up was confirming.
          const session = spm.getChannelByPeer(buyerPeerId);
          if (!session) {
            debugWarn(`[SellerHandler] Session evicted during waitForPendingAuths for ${buyerPeerId.slice(0, 12)}... — returning 402`);
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 402,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify({
                error: 'payment_required',
                message: 'Session expired, please renegotiate',
              })),
            });
            return;
          }
          let accepted = spm.getAcceptedCumulative(session.sessionId);
          const spent = spm.getCumulativeSpend(session.sessionId);
          // Serving headroom only includes funds locked on-chain. Pending
          // top-ups are not counted until topUp() succeeds, otherwise a large
          // request could push spend above the current reserve before the extra
          // funds are actually locked.
          const reserveMax = spm.getEffectiveReserveMax(session.sessionId);
          const isBlocked = spm.isChannelBlocked(session.sessionId);
          // If spend has caught up and there is no headroom left in the reserve,
          // stop serving before accepting any additional request cost.
          const isAtExactSpendLimit = spent > 0n && spent === accepted && reserveMax > 0n && accepted >= reserveMax;

          if (spent > 0n && spent > accepted) {
            // Race cover: the buyer's SpendingAuth for the *previous* response's
            // NeedAuth may still be on the wire when this request arrives. The
            // per-buyer mutex in waitForPendingAuths only serializes *in-flight*
            // handleSpendingAuth calls — it can't wait for a frame that hasn't
            // been received yet. Park for up to 5s for the signed catch-up to
            // land before giving up and emitting a 402. In pure steady-state
            // operation this wait is a no-op; under pipelined requests (a new
            // request dispatched before the prior NeedAuth → SpendingAuth has
            // completed) it hides the round-trip latency from the buyer.
            const caughtUp = await spm.awaitAcceptedAtLeast(session.sessionId, spent, DEFAULT_CATCH_UP_WAIT_MS);
            accepted = spm.getAcceptedCumulative(session.sessionId);
            if (caughtUp && spent <= accepted) {
              debugLog(`[SellerHandler] Caught up before 402 for ${buyerPeerId.slice(0, 12)}... (spent=${spent} accepted=${accepted})`);
            }
          }
          let requestCostEstimate: ReturnType<SellerRequestHandler['_estimateRequestCostUsdc']> = null;
          try {
            requestCostEstimate = requestBilling
              ? this._estimateRequestCostUsdc(request, requestBilling, requestPricing, unitBillingModel)
              : null;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[SellerHandler] Rejecting unbillable request: ${message}`);
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 503,
              headers: { 'content-type': 'application/json' },
              body: new TextEncoder().encode(JSON.stringify({
                error: {
                  message: `Seller billing configuration cannot price this request: ${message}`,
                  type: 'billing_configuration_error',
                  code: 'billing_tier_unmatched',
                },
              })),
            });
            return;
          }
          const estimatedRequestCost = requestCostEstimate?.cost ?? 0n;
          const remainingLockedReserve = reserveMax > spent ? reserveMax - spent : 0n;
          const reserveEstimateOverdraft = this._deps.reserveEstimateOverdraftUsdc;
          const effectiveEstimateLimit = reserveEstimateOverdraft != null
            ? remainingLockedReserve + reserveEstimateOverdraft
            : null;
          const estimatedCostExceedsLockedReserve = effectiveEstimateLimit != null
            && reserveMax > 0n
            && estimatedRequestCost > 0n
            && estimatedRequestCost > effectiveEstimateLimit;

          if (isBlocked || (spent > 0n && (spent > accepted || isAtExactSpendLimit)) || estimatedCostExceedsLockedReserve) {
            const baseRequirements = spm.getPaymentRequirements(
              request.requestId, buyerPeerId, requestPricing,
            );
            // Tell the buyer exactly how much delivered spend remains unsigned.
            // Do not add forward headroom here: SpendingAuth is claimable
            // on-chain, so requiring more than `spent` would authorize payment
            // for work the seller has not delivered. The preflight reserve
            // check also returns target=spent: it is a hard stop before routing
            // work that cannot fit inside the currently locked reserve.
            const target = spent;
            const isAlreadyExhausted = reserveMax > 0n && (accepted >= reserveMax || target > reserveMax);
            const isFullyExhausted = isBlocked || estimatedCostExceedsLockedReserve || isAlreadyExhausted;
            const requirements = {
              ...baseRequirements,
              requiredCumulativeAmount: target.toString(),
              currentSpent: spent.toString(),
              currentAcceptedCumulative: accepted.toString(),
              channelId: session.sessionId,
              ...(reserveMax > 0n ? { reserveMaxAmount: reserveMax.toString() } : {}),
              ...(isFullyExhausted ? { code: PAYMENT_CODE_CHANNEL_EXHAUSTED } : {}),
            };
            if (isFullyExhausted) {
              let reason = 'fully exhausted';
              if (isBlocked) {
                reason = 'blocked';
              } else if (estimatedCostExceedsLockedReserve) {
                reason = 'insufficient locked reserve for estimated request';
              }
              debugLog(`[SellerHandler] Session ${reason} for ${buyerPeerId.slice(0, 12)}... (spent=${spent} accepted=${accepted} target=${target} reserveMax=${reserveMax} remainingLockedReserve=${remainingLockedReserve} reserveEstimateOverdraft=${reserveEstimateOverdraft ?? 'disabled'} effectiveEstimateLimit=${effectiveEstimateLimit ?? 'disabled'} estimatedRequestCost=${estimatedRequestCost} estimatedInputTokens=${requestCostEstimate?.inputTokens ?? 0} estimatedMaxOutputTokens=${requestCostEstimate?.maxOutputTokens ?? 0}) — returning 402`);
              if (isBlocked || isAlreadyExhausted || estimatedCostExceedsLockedReserve) {
                // Default settleSession() performs final close(); do not use
                // settleOnly here because exhausted channels must release the
                // buyer's unused reserve before the buyer opens a replacement.
                void spm.settleSession(buyerPeerId).catch((err) => {
                  debugWarn(`[SellerHandler] Failed to close exhausted session: ${err instanceof Error ? err.message : err}`);
                });
              }
            } else {
              const comparator = spent > accepted ? '>' : '==';
              debugLog(`[SellerHandler] Budget exhausted for ${buyerPeerId.slice(0, 12)}... (spent=${spent} ${comparator} accepted=${accepted}) — returning 402 with requiredCumulativeAmount=${target}, awaiting higher SpendingAuth`);
            }
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 402,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify({
                error: 'payment_required',
                minBudgetPerRequest: requirements.minBudgetPerRequest,
                suggestedAmount: requirements.suggestedAmount,
                requiredCumulativeAmount: requirements.requiredCumulativeAmount,
                currentSpent: requirements.currentSpent,
                currentAcceptedCumulative: requirements.currentAcceptedCumulative,
                channelId: requirements.channelId,
                ...(requirements.reserveMaxAmount != null ? { reserveMaxAmount: requirements.reserveMaxAmount } : {}),
                ...(requirements.code != null ? { code: requirements.code } : {}),
                ...(estimatedCostExceedsLockedReserve ? {
                  estimatedRequestCost: estimatedRequestCost.toString(),
                  remainingLockedReserve: remainingLockedReserve.toString(),
                  estimatedInputTokens: String(requestCostEstimate?.inputTokens ?? 0),
                  estimatedMaxOutputTokens: String(requestCostEstimate?.maxOutputTokens ?? 0),
                } : {}),
                ...(requirements.inputUsdPerMillion != null ? { inputUsdPerMillion: requirements.inputUsdPerMillion } : {}),
                ...(requirements.outputUsdPerMillion != null ? { outputUsdPerMillion: requirements.outputUsdPerMillion } : {}),
                ...(requirements.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: requirements.cachedInputUsdPerMillion } : {}),
              })),
            });
            this._sendPaymentRequiredBestEffort(paymentMux, requirements, buyerPeerId, 'budget-exhausted');
            // Auto-sign catch-up via NeedAuth so a transient underfund recovers
            // without the 402 round-tripping to the user.
            if (!isFullyExhausted) {
              this._sendNeedAuthBestEffort(paymentMux, {
                channelId: session.sessionId,
                requiredCumulativeAmount: target.toString(),
                currentAcceptedCumulative: accepted.toString(),
                deposit: session.authMax ?? '0',
                requestId: request.requestId,
              }, buyerPeerId, 'budget-catch-up');
            }
            return;
          }
        }
      }

      const responseAuthRequest: SerializedHttpRequest = {
        ...request,
        headers: { ...request.headers },
      };

      // Track active seller session at request start
      this._deps.sessionTracker?.getOrCreateSession(buyerPeerId, provider.name);

      request.headers['x-antseed-buyer-peer-id'] = buyerPeerId;

      const requestedModel = this._extractRequestedService(request) ?? 'unknown';
      debugLog(`[SellerHandler] Routing to provider "${provider.name}" model="${requestedModel}"`);
      const startTime = Date.now();
      let statusCode = 500;
      let responseBody: Uint8Array = new Uint8Array(0);
      let streamedResponseStarted = false;
      let heldDoneChunkData: Uint8Array | null = null;
      let responseStartedAt = startTime;
      let responseForAuth: SerializedHttpResponse | null = null;
      let streamAuthStatusCode = 0;
      let streamAuthHeaders: Record<string, string> | null = null;
      let responseUsage: import('./utils/response-usage.js').ResponseUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };
      let billingUsageReport: UnitBillingUsageReportV1 | null = null;
      let unitCostUsdc = 0n;
      // Hold the channel open for the whole billable span — provider call,
      // spend recording, and NeedAuth — so a buyer-requested close can't land
      // between serving the request and claiming its cost.
      const isBillable = !isFreeService && (spm?.hasSession(buyerPeerId) ?? false);
      if (isBillable && spm!.hasClosingChannel(buyerPeerId)) {
        mux.sendProxyResponse({
          requestId: request.requestId,
          statusCode: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
          body: new TextEncoder().encode(JSON.stringify({
            error: 'channel_closing',
            message: 'Payment channel is closing; retry shortly or open a new channel',
          })),
        });
        return;
      }
      if (isBillable) spm!.beginBillableRequest(buyerPeerId);
      this.adjustProviderLoad(provider.name, 1);
      try {
        try {
          const response = await this._executeRequest(provider, request, {
            onResponseStart: (streamResponseStart) => {
              streamedResponseStarted = true;
              responseStartedAt = Date.now();
              statusCode = streamResponseStart.statusCode;
              streamAuthStatusCode = streamResponseStart.statusCode;
              streamAuthHeaders = { ...streamResponseStart.headers };
              mux.sendProxyResponse(streamResponseStart);
            },
            onResponseChunk: (chunk) => {
              if (!streamedResponseStarted) return;
              // Hold the done chunk — send it after usage is parsed so we can append cost trailer
              if (chunk.done) {
                heldDoneChunkData = chunk.data;
                return;
              }
              mux.sendProxyChunk(chunk);
            },
          });
          statusCode = response.statusCode;
          responseBody = response.body ?? new Uint8Array(0);
          responseForAuth = response;
          if (statusCode >= 400) {
            const errBody = new TextDecoder().decode(responseBody).slice(0, 200);
            debugWarn(`[SellerHandler] Provider error response: status=${statusCode} provider="${provider.name}" model="${requestedModel}" buyer=${buyerPeerId.slice(0, 12)}... (${Date.now() - startTime}ms) body=${errBody}`);
          } else {
            debugLog(`[SellerHandler] Provider responded: status=${statusCode} (${Date.now() - startTime}ms, ${responseBody.length}b)`);
          }
          if (requestBilling && unitBillingModel) {
            const unitBilling = computeFinalUnitBilling(unitBillingModel, requestBilling.context, response, requestBilling.requestFacts);
            responseUsage = unitBilling.tokenUsage;
            billingUsageReport = unitBilling.billingUsage;
            unitCostUsdc = unitBilling.costUsdc;
          } else {
            responseUsage = parseResponseUsage(response.body);
          }
          debugLog(`[SellerHandler] Raw provider usage: in=${responseUsage.inputTokens} fresh=${responseUsage.freshInputTokens} cached=${responseUsage.cachedInputTokens} out=${responseUsage.outputTokens}`);
          if (!streamedResponseStarted) {
            mux.sendProxyResponse(response);
          } else if (heldDoneChunkData !== null) {
            // Streaming: send the held done chunk as-is (no trailer).
            // Cost data is sent via NeedAuth on the PaymentMux.
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: heldDoneChunkData,
              done: true,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Internal error";
          debugWarn(`[SellerHandler] Provider exception: provider="${provider.name}" model="${requestedModel}" buyer=${buyerPeerId.slice(0, 12)}... (${Date.now() - startTime}ms) ${message}`);
          responseBody = new TextEncoder().encode(message);
          if (streamedResponseStarted) {
            const errorFrame = new TextEncoder().encode(`event: error\ndata: ${message}\n\n`);
            responseBody = errorFrame;
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: errorFrame,
              done: false,
            });
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: new Uint8Array(0),
              done: true,
            });
            if (streamAuthHeaders !== null) {
              responseForAuth = {
                requestId: request.requestId,
                statusCode: streamAuthStatusCode,
                headers: streamAuthHeaders,
                body: errorFrame,
              };
            }
          } else {
            statusCode = 500;
            responseForAuth = {
              requestId: request.requestId,
              statusCode: 500,
              headers: { "content-type": "text/plain" },
              body: responseBody,
            };
            mux.sendProxyResponse(responseForAuth);
          }
        }

          if (requestBilling && unitBillingModel && responseForAuth && billingUsageReport === null) {
            const finalBilling = computeFinalUnitBilling(
              unitBillingModel,
              requestBilling.context,
              responseForAuth,
              requestBilling.requestFacts,
            );
            responseUsage = finalBilling.tokenUsage;
            billingUsageReport = finalBilling.billingUsage;
            unitCostUsdc = finalBilling.costUsdc;
          }

        // Record metering
        const latencyMs = Date.now() - startTime;
        if (this._deps.sessionTracker) {
          await this._deps.sessionTracker.recordMetering({
            buyerPeerId,
            providerName: provider.name,
            pricing: requestPricing,
            request,
            statusCode,
            latencyMs,
            inputBytes: request.body.length,
            outputBytes: responseBody.length,
            responseBody,
            providerUsage: responseUsage,
          });
        }

        // Record spend and send NeedAuth with cost data after every request.
        // The buyer validates the cost independently and responds with SpendingAuth.
        if (!isFreeService && spm?.hasSession(buyerPeerId)) {
          const usage = responseUsage;
          const tokenCostUsdc = computeCostUsdc(
            usage.freshInputTokens,
            usage.outputTokens,
            requestPricing,
            usage.cachedInputTokens,
          );
          const costUsdc = tokenCostUsdc + unitCostUsdc;
          const session = spm.getChannelByPeer(buyerPeerId);
          if (session) {
            spm.recordSpend(session.sessionId, costUsdc);
            const cumulativeSpend = spm.getCumulativeSpend(session.sessionId);
            debugLog(`[SellerHandler] Cost recorded: buyer=${buyerPeerId.slice(0, 12)}... cost=${costUsdc} cumulative=${cumulativeSpend} (in=${usage.inputTokens} cached=${usage.cachedInputTokens} out=${usage.outputTokens})`);

            const accepted = spm.getAcceptedCumulative(session.sessionId);
            const requiredAmount = cumulativeSpend;
            debugLog(`[SellerHandler] Sending NeedAuth: cost=${costUsdc} cumulative=${cumulativeSpend} required=${requiredAmount}`);
            this._sendNeedAuthBestEffort(paymentMux, {
              channelId: session.sessionId,
              requiredCumulativeAmount: requiredAmount.toString(),
              currentAcceptedCumulative: accepted.toString(),
              deposit: session.authMax ?? '0',
              requestId: request.requestId,
              lastRequestCost: costUsdc.toString(),
              inputTokens: String(usage.inputTokens),
              outputTokens: String(usage.outputTokens),
              cachedInputTokens: String(usage.cachedInputTokens),
              freshInputTokens: String(usage.freshInputTokens),
              service: this._extractRequestedService(request) ?? undefined,
              billingUsage: billingUsageReport ?? undefined,
            }, buyerPeerId, 'post-response');
          }
        } else if (isFreeService) {
          this._deps.sellerFreeUsageManager?.reportUsageRequest(buyerPeerId, paymentMux, {
            requestId: request.requestId,
            inputTokens: responseUsage.inputTokens,
            outputTokens: responseUsage.outputTokens,
            service: this._extractRequestedService(request) ?? undefined,
          });
        }

        const buyerSupportsResponseAuth = conn.hasRemoteCapability(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1);

        if (responseForAuth && buyerSupportsResponseAuth) {
          const channelId = spm?.getChannelByPeer(buyerPeerId)?.sessionId ?? null;
          this._sendResponseAuthBestEffort(
            verificationMux,
            responseAuthRequest,
            responseForAuth,
            {
              buyerPeerId,
              providerName: provider.name,
              advertisedService: requestedModel,
              responseStartedAt,
              responseCompletedAt: Date.now(),
              channelId,
            },
          );
        }
      } finally {
        this.adjustProviderLoad(provider.name, -1);
        if (isBillable) spm!.endBillableRequest(buyerPeerId);
      }
    });

    return { mux };
  }

  // -- Local /v1/models handler --

  private _handleModelsRequest(request: SerializedHttpRequest): SerializedHttpResponse {
    const allServices = this._deps.providers.flatMap((p) => p.services);
    const now = Math.floor(Date.now() / 1000);

    // GET /v1/models/:id — single model lookup
    // Strip query string so `/v1/models/gpt-5.5?client_version=…` resolves to "gpt-5.5".
    const pathOnly = request.path.split('?')[0] ?? request.path;
    const singleModelMatch = pathOnly.match(/^\/v1\/models\/(.+)$/);
    if (singleModelMatch) {
      const modelId = decodeURIComponent(singleModelMatch[1]!);
      if (allServices.includes(modelId)) {
        return {
          requestId: request.requestId,
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({
            id: modelId, object: 'model', created: now, owned_by: 'antseed',
          })),
        };
      }
      return {
        requestId: request.requestId,
        statusCode: 404,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error', code: 'model_not_found' },
        })),
      };
    }

    // GET /v1/models — list all
    const models = allServices.map((id) => ({
      id, object: 'model' as const, created: now, owned_by: 'antseed',
    }));
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ object: 'list', data: models })),
    };
  }

  // -- Provider matching (public for announcer pricing in _startSeller) --

  matchProvider(request: SerializedHttpRequest): Provider | undefined {
    const requestedService = this._extractRequestedService(request);
    if (requestedService === null) {
      return undefined;
    }
    const requestedProvider = this._extractRequestedProvider(request);
    const providers = this._deps.providers;
    const matchesService = (provider: Provider): boolean =>
      provider.services.includes(requestedService);

    let provider: Provider | undefined;
    if (requestedProvider) {
      provider = providers.find((candidate) =>
        candidate.name.toLowerCase() === requestedProvider && matchesService(candidate),
      );
    }
    if (!provider) {
      provider = providers.find((candidate) => matchesService(candidate));
    }
    return provider;
  }

  resolveProviderPricing(
    provider: Provider,
    request: SerializedHttpRequest,
  ): ProviderTokenPricing {
    const requestedService = this._extractRequestedService(request);
    if (requestedService) {
      const servicePricing = provider.pricing.services?.[requestedService];
      if (servicePricing) {
        return servicePricing;
      }
    }
    return provider.pricing.defaults;
  }

  resolveProviderUnitBillingModel(
    provider: Provider,
    context: UnitBillingContext,
  ): UnitBillingModelV1 | undefined {
    return provider.serviceUnitBillingModels?.[context.service]?.[context.serviceApiProtocol];
  }

  // -- Load tracking --

  adjustProviderLoad(providerName: string, delta: number): void {
    const nextLoad = Math.max(0, (this._providerLoadCounts.get(providerName) ?? 0) + delta);
    this._providerLoadCounts.set(providerName, nextLoad);

    const announcer = this._deps.announcer;
    if (!announcer) return;
    announcer.updateLoad(providerName, nextLoad);
    this._scheduleMetadataRefresh();
  }

  // -- Cleanup --

  clearMetadataRefreshTimer(): void {
    if (this._metadataRefreshTimer) {
      clearTimeout(this._metadataRefreshTimer);
      this._metadataRefreshTimer = null;
    }
    this._providerLoadCounts.clear();
  }

  // -- Private helpers --

  private _isJsonRequest(request: SerializedHttpRequest): boolean {
    return hasJsonContentType(request.headers);
  }

  private _extractRequestedService(request: SerializedHttpRequest): string | null {
    const body = extractRequestBodyFields(request.headers, request.body);
    const service = body?.["service"] ?? body?.["model"];
    if (typeof service !== "string" || service.trim().length === 0) {
      return null;
    }
    return service.trim();
  }

  private _extractRequestedProvider(request: SerializedHttpRequest): string | null {
    const providers = Object.entries(request.headers)
      .filter(([header]) => header.toLowerCase() === "x-antseed-provider")
      .map(([, value]) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);

    return providers[0] ?? null;
  }

  private _captureSellerBillingContext(provider: Provider, request: SerializedHttpRequest): SellerBillingContext | null {
    const service = this._extractRequestedService(request);
    if (!service) return null;
    return captureUnitBillingContext({
      sellerPeerId: this._deps.identity.peerId,
      provider: provider.name,
      service,
      serviceApiProtocol: this._selectSellerProtocolForService(provider, service, request),
      request,
    });
  }

  private _selectSellerProtocolForService(
    provider: Provider,
    service: string,
    request: SerializedHttpRequest,
  ): ServiceApiProtocol {
    const protocols = provider.serviceApiProtocols?.[service];
    const billingProtocols = Object.keys(provider.serviceUnitBillingModels?.[service] ?? {}) as ServiceApiProtocol[];
    const candidates = protocols ?? billingProtocols;
    const requestProtocol = detectRequestServiceApiProtocol(request);
    const selected = selectTargetProtocolForRequest(requestProtocol, candidates);
    if (selected) return selected.targetProtocol;
    if (protocols?.[0]) return protocols[0];
    return billingProtocols[0] ?? "openai-chat-completions";
  }

  private _estimateUnitRequestCostUsdc(
    requestBilling: SellerBillingContext,
    model: UnitBillingModelV1,
  ): { cost: bigint; inputTokens: number; maxOutputTokens: number } {
    const usage: UnitBillingUsage = {
      units: {
        output_images: Math.floor(requestBilling.requestUsage.units.output_images ?? 0),
      },
    };
    return {
      cost: evaluateUnitBilling(model, requestBilling.context, usage),
      inputTokens: 0,
      maxOutputTokens: 0,
    };
  }

  private _estimateRequestCostUsdc(
    request: SerializedHttpRequest,
    requestBilling: SellerBillingContext,
    pricing: ProviderTokenPricing,
    unitModel: UnitBillingModelV1 | undefined,
  ): { cost: bigint; inputTokens: number; maxOutputTokens: number } | null {
    const tokenEstimate = this._estimateMaxTokenRequestCostUsdc(request, pricing);
    const unitEstimate = unitModel
      ? this._estimateUnitRequestCostUsdc(requestBilling, unitModel)
      : null;

    if (!tokenEstimate && !unitEstimate) return null;
    return {
      cost: (tokenEstimate?.cost ?? 0n) + (unitEstimate?.cost ?? 0n),
      inputTokens: tokenEstimate?.inputTokens ?? unitEstimate?.inputTokens ?? 0,
      maxOutputTokens: tokenEstimate?.maxOutputTokens ?? unitEstimate?.maxOutputTokens ?? 0,
    };
  }

  private _estimateMaxTokenRequestCostUsdc(
    request: SerializedHttpRequest,
    pricing: ProviderTokenPricing,
  ): { cost: bigint; inputTokens: number; maxOutputTokens: number } | null {
    if (!this._isJsonRequest(request)) {
      return null;
    }
    const body = tryParseJsonObject(request.body);
    if (!body) {
      return null;
    }

    const inputTokens = estimateTokensFromBytes(request.body);
    const maxOutputTokens = this._extractMaxOutputTokens(body);
    return {
      cost: computeCostUsdc(inputTokens, maxOutputTokens, pricing),
      inputTokens,
      maxOutputTokens,
    };
  }

  private _extractMaxOutputTokens(body: Record<string, unknown>): number {
    const candidates = [
      body["max_tokens"],
      body["max_completion_tokens"],
      body["max_output_tokens"],
      body["maxTokens"],
      body["maxCompletionTokens"],
      body["maxOutputTokens"],
    ];

    for (const value of candidates) {
      const parsed = this._parsePositiveInteger(value);
      if (parsed !== null) return parsed;
    }
    return 0;
  }

  private _parsePositiveInteger(value: unknown): number | null {
    let numeric: number;
    if (typeof value === 'number') {
      numeric = value;
    } else if (typeof value === 'string') {
      numeric = Number(value);
    } else {
      return null;
    }

    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.floor(numeric);
  }

  private async _executeRequest(
    provider: Provider,
    request: SerializedHttpRequest,
    streamCallbacks?: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse> {
    if (streamCallbacks && provider.handleRequestStream) {
      return provider.handleRequestStream(request, streamCallbacks);
    }
    return provider.handleRequest(request);
  }

  private _sendNeedAuthBestEffort(
    paymentMux: PaymentMux,
    payload: Parameters<PaymentMux['sendNeedAuth']>[0],
    buyerPeerId: string,
    phase: 'budget-catch-up' | 'post-response',
  ): void {
    try {
      paymentMux.sendNeedAuth(payload);
    } catch (err) {
      debugWarn(
        `[SellerHandler] NeedAuth send skipped (${phase}) for ${buyerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private _sendPaymentRequiredBestEffort(
    paymentMux: PaymentMux,
    payload: Parameters<PaymentMux['sendPaymentRequired']>[0],
    buyerPeerId: string,
    phase: 'missing-session' | 'budget-exhausted',
  ): void {
    try {
      paymentMux.sendPaymentRequired(payload);
    } catch (err) {
      debugWarn(
        `[SellerHandler] PaymentRequired send skipped (${phase}) for ${buyerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private _scheduleMetadataRefresh(): void {
    if (!this._deps.announcer || this._metadataRefreshTimer) {
      return;
    }

    const timer = setTimeout(() => {
      this._metadataRefreshTimer = null;
      const announcer = this._deps.announcer;
      if (!announcer) return;
      void announcer.refreshMetadata().catch((err) => {
        debugWarn(`[SellerHandler] Failed to refresh metadata snapshot: ${err instanceof Error ? err.message : err}`);
      });
    }, METADATA_REFRESH_DEBOUNCE_MS);
    this._metadataRefreshTimer = timer;
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }

  private _sendResponseAuthBestEffort(
    verificationMux: VerificationMux,
    request: SerializedHttpRequest,
    response: SerializedHttpResponse,
    context: {
      buyerPeerId: string;
      providerName: string;
      advertisedService: string;
      responseStartedAt: number;
      responseCompletedAt: number;
      channelId: string | null;
    },
  ): void {
    try {
      const payload = createResponseAuthPayload({
        request,
        response,
        buyerPeerId: context.buyerPeerId,
        sellerPeerId: this._deps.identity.peerId,
        advertisedService: context.advertisedService,
        provider: context.providerName,
        responseStartedAt: context.responseStartedAt,
        responseCompletedAt: context.responseCompletedAt,
        channelId: context.channelId,
      }, this._deps.identity.wallet);
      verificationMux.sendResponseAuth(payload);
    } catch (err) {
      debugWarn(`[SellerHandler] Failed to send ResponseAuth for ${request.requestId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
