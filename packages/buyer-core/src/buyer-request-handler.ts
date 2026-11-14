import { nativeVideoDelivered, nativeVideoRoute, requestService } from '@antseed/api-adapter';
import {
  ANTSEED_FAULT_ATTRIBUTION_HEADER,
  ANTSEED_STREAMING_RESPONSE_HEADER,
  ANTSEED_SPENDING_AUTH_HEADER,
  VIDEO_DOWNLOAD_STREAM_HEADER,
  VIDEO_DOWNLOAD_STREAM_VERSION,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
} from '@antseed/protocol/http';
import type { PeerId } from '@antseed/protocol/peer-id';
import type { BuyerPeerView } from './interfaces.js';
import type { BuyerConnection } from './interfaces.js';
import type { ProxyMux } from './proxy-mux.js';
import { PaymentMux } from './payment-mux.js';
import { ConnectionState } from '@antseed/protocol/connection-state';
import type { BuyerPaymentNegotiator, SelectedBillingRoute } from './buyer-payment-negotiator.js';
import { debugLog, debugWarn } from './debug.js';
import type { VerificationMux } from './verification-mux.js';
import type { ResponseAuthSink } from './interfaces.js';
import type { ResponseAuthSampler } from './interfaces.js';
import type { BuyerFreeUsageManager } from './buyer-free-usage-manager.js';
import { verifyResponseAuth, createStreamingResponseHash } from './response-auth.js';
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/protocol/request-codec';
import { isFreeUnitBillingModel } from '@antseed/protocol/billing';
import { isServiceHealthFailing, providerServiceHealthFor } from '@antseed/protocol/peer-metadata';
import { findRoutingService, routingProtocolForPath, routingWireProtocol } from '@antseed/protocol/routing';
import { isUnitBilledProtocol } from './unit-billing.js';
import type { ServiceApiProtocol } from '@antseed/protocol/service-api';
import {
  detectRequestServiceApiProtocol,
  extractRequestBodyFields,
  selectTargetProtocolForRequest,
} from '@antseed/api-adapter';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '@antseed/protocol/messages';
import { buyerFault, peerFault } from './errors.js';
import { adaptPeerFaultErrorResponse } from './peer-error-response.js';
import {
  WORKER_ASSIGN_PATH,
  isWorkerUnavailable,
  peerAnnouncesWorkerE2E,
  peerServiceUsesWorkerE2E,
  isWorkerE2EProvider,
  type SealedWorkerRequest,
  type WorkerE2EClient,
} from './worker-e2e.js';

export interface RequestStreamResponseMetadata {
  streaming: boolean;
}

export interface RequestStreamCallbacks {
  onResponseStart?: (
    response: SerializedHttpResponse,
    metadata: RequestStreamResponseMetadata,
  ) => void;
  onResponseChunk?: (chunk: SerializedHttpResponseChunk) => void | Promise<void>;
}

/** On an accepted video create: the job's price in USDC base units, charged when the video is delivered. Set by the buyer only. */
export const VIDEO_PRICE_HEADER = 'x-antseed-video-price-usdc';

/**
 * On a video retrieve answer: the buyer has retired the job (it failed, the
 * seller no longer has it, or the buyer has no record of it), so it can never
 * be delivered or charged. Set by the buyer only.
 */
export const VIDEO_JOB_RETIRED_HEADER = 'x-antseed-video-job-retired';

/**
 * On a video retrieve answer: `1` when the buyer accepted the streamed file
 * as the finished video (readable, close enough to the requested duration)
 * and recorded its delivery. A stream without it was not a delivery.
 * `unrecorded` when the file is fine but the buyer could not yet save that
 * the job is done: not reported as a delivery, but the job is not given up
 * and may be downloaded again. Set by the buyer only.
 */
export const VIDEO_DELIVERED_HEADER = 'x-antseed-video-delivered';
export const VIDEO_DELIVERY_UNRECORDED = 'unrecorded';

/** Headers only the buyer may set: a seller's copy (in any letter case) is dropped from its responses. */
const BUYER_ONLY_RESPONSE_HEADERS: ReadonlySet<string> = new Set([ANTSEED_FAULT_ATTRIBUTION_HEADER, VIDEO_PRICE_HEADER, VIDEO_JOB_RETIRED_HEADER, VIDEO_DELIVERED_HEADER]);

export interface RequestExecutionOptions {
  /**
   * Ends the request. Aborted with the default reason, the caller gave the request up, and the seller may still
   * bill it up to what it allows. Aborted with any other reason (a timeout), the caller gave up on the seller.
   */
  signal?: AbortSignal;
  /** Skip payment/free-usage machinery for internal control-plane requests. */
  controlPlane?: boolean;
  /** Present peer failures as coming from an explicitly pinned route. */
  pinned?: boolean;
  /** Persist exact signed request/response preimages for portable verifier evidence. */
  captureResponseAuthPreimages?: boolean;
  /** Refuse a video create priced above this many USDC base units (the caller's remaining budget). */
  maxVideoCostUsdc?: bigint;
  /**
   * Send only on the connection with this session hash: the one a seller's TEE attestation was
   * bound to. A request that would go out on any other connection is refused before sending.
   */
  channelBinding?: string;
}

export interface BuyerRequestHandlerConfig {
  requestTimeoutMs?: number;
  maxStreamBufferBytes?: number;
  maxStreamDurationMs?: number;
  responseAuthTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_STREAM_DURATION_MS = 30 * 60_000;
const DEFAULT_RESPONSE_AUTH_GRACE_MS = 30_000;

export interface BuyerRequestHandlerDeps {
  localPeerId: PeerId;
  negotiator: BuyerPaymentNegotiator | null;
  freeUsageManager?: BuyerFreeUsageManager | null;
  verificationStorage: ResponseAuthSink | null;
  verificationSampler: ResponseAuthSampler | null;
  getConnection: (peer: BuyerPeerView) => Promise<BuyerConnection>;
  getMux: (peerId: PeerId, conn: BuyerConnection) => ProxyMux;
  getVerificationMux: (peerId: PeerId, conn: BuyerConnection) => VerificationMux;
  registerPaymentMux: (peerId: PeerId, mux: PaymentMux) => void;
  /**
   * Value for the `x-antseed-free-tier-delegations` header: stakers' signed
   * consent to count their stake for this buyer on sellers' staked free tiers.
   */
  freeTierDelegationsHeader?: () => string | null;
  /** Encrypts requests routed to a colony-pool provider to the pool's workers (see peerServiceUsesWorkerE2E). */
  workerE2E?: WorkerE2EClient | null;
}

export const FREE_TIER_DELEGATIONS_HEADER = 'x-antseed-free-tier-delegations';
/** Set to `covered` by a seller whose free allowance covered a request to a priced service. */
export const FREE_TIER_SERVED_HEADER = 'x-antseed-free-tier';

/** Whether the seller served this response from a priced service's free allowance. */
export function isCoveredByFreeAllowance(response: SerializedHttpResponse): boolean {
  return Object.entries(response.headers).some(([name, value]) =>
    name.toLowerCase() === FREE_TIER_SERVED_HEADER && value.trim().toLowerCase() === 'covered');
}

/**
 * Handles buyer-side outbound request execution: connection setup, streaming,
 * timeouts, abort signals, 402 payment negotiation, and cost tracking.
 *
 * Extracted from AntseedNode._sendRequestInternal to separate buyer request
 * orchestration from core node lifecycle.
 */
export class BuyerRequestHandler {
  private readonly _config: BuyerRequestHandlerConfig;
  private readonly _deps: BuyerRequestHandlerDeps;

  constructor(config: BuyerRequestHandlerConfig, deps: BuyerRequestHandlerDeps) {
    this._config = config;
    this._deps = deps;
  }

  async sendRequest(
    peer: BuyerPeerView,
    req: SerializedHttpRequest,
    callbacks?: RequestStreamCallbacks,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    if (!req.requestId || typeof req.requestId !== "string") {
      throw buyerFault("requestId must be a non-empty string", 'invalid-request');
    }

    const opName = callbacks ? "sendRequestStream" : "sendRequest";
    debugLog(`[BuyerRequest] ${opName} ${req.method} ${req.path} → peer ${peer.peerId.slice(0, 12)}... (reqId=${req.requestId.slice(0, 8)})`);

    const conn = await this._deps.getConnection(peer);
    debugLog(`[BuyerRequest] Connection to ${peer.peerId.slice(0, 12)}... state=${conn.state}`);
    if (options?.channelBinding !== undefined && conn.channelBinding !== options.channelBinding) {
      throw buyerFault(
        `Connection to ${peer.peerId.slice(0, 12)}... is not the one its TEE attestation covered; verify the seller again`,
        'buyer-tee-connection-changed',
      );
    }
    const mux = this._deps.getMux(peer.peerId, conn);
    const verificationMux = this._deps.getVerificationMux(peer.peerId, conn);
    const negotiator = options?.controlPlane ? null : this._deps.negotiator;
    // Before any payment frame can arrive: a seller announcing colony-pool
    // workers is paid only for requests this buyer sent it (see trackPoolSellerRequest).
    if (peerAnnouncesWorkerE2E(peer)) this._deps.negotiator?.bpm?.markWorkerSeller(peer.peerId);
    if (negotiator) {
      this._deps.registerPaymentMux(peer.peerId, negotiator.getOrCreatePaymentMux(peer.peerId, conn));
      // A retry reuses the request ID: an earlier covered attempt must not refuse this one's charge.
      negotiator.bpm?.releaseRequestCoverage(peer.peerId, req.requestId);
    }

    // Extract and strip x-antseed-spending-auth header if present (external auth compatibility)
    const externalSpendingAuth = req.headers[ANTSEED_SPENDING_AUTH_HEADER] ?? null;
    if (externalSpendingAuth) {
      const { [ANTSEED_SPENDING_AUTH_HEADER]: _, ...cleanHeaders } = req.headers;
      req = { ...req, headers: cleanHeaders };
    }

    if (externalSpendingAuth && negotiator) {
      debugLog(`[BuyerRequest] Applying external spending auth for ${peer.peerId.slice(0, 12)}...`);
      await negotiator.applyExternalSpendingAuth(peer, conn, externalSpendingAuth);
    }

    // Only this node's own delegations reach the seller, never a client's copy.
    const headersWithoutDelegations = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => name.toLowerCase() !== FREE_TIER_DELEGATIONS_HEADER),
    );
    const delegationsHeader = this._deps.freeTierDelegationsHeader?.() ?? null;
    req = {
      ...req,
      headers: delegationsHeader
        ? { ...headersWithoutDelegations, [FREE_TIER_DELEGATIONS_HEADER]: delegationsHeader }
        : headersWithoutDelegations,
    };

    // Track which service the buyer requested so auth validation uses buyer's own pricing.
    const requestedService = options?.controlPlane ? undefined : extractRequestedService(peer, req);
    const requestProtocol = options?.controlPlane ? null : detectRequestServiceApiProtocol(req);
    // Set when a video create is priced; reported on its accepted response so the caller can reserve it until delivery.
    let videoPriceUsdc: bigint | undefined;
    const adaptPeerResponse = (response: SerializedHttpResponse): SerializedHttpResponse => {
      const adapted = adaptPeerFaultErrorResponse(response, requestProtocol, { pinned: options?.pinned, peerId: peer.peerId });
      if (videoPriceUsdc === undefined || adapted.statusCode < 200 || adapted.statusCode >= 300) return adapted;
      const headers = Object.fromEntries(Object.entries(adapted.headers).filter(([name]) => name.toLowerCase() !== VIDEO_PRICE_HEADER));
      return { ...adapted, headers: { ...headers, [VIDEO_PRICE_HEADER]: videoPriceUsdc.toString() } };
    };
    const explicitProvider = extractRequestedProvider(req);
    // The seller trims the model name, so the route is resolved trimmed too:
    // otherwise a padded pool-only model falls back to another provider and is sent in the clear.
    const routedService = requestedService?.trim() || requestedService;
    const billingRoute = routedService ? selectBillingRoute(peer, req, routedService) : null;
    // Name the provider the request is billed under, so the seller serves it
    // through the same upstream instead of choosing one by itself. This also
    // replaces a provider the peer does not announce (see selectProviderForService).
    if (billingRoute && extractRequestedProvider(req) !== billingRoute.provider.toLowerCase()) {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.toLowerCase() !== "x-antseed-provider"));
      req = { ...req, headers: { ...headers, "x-antseed-provider": billingRoute.provider } };
    }
    // Colony pools: a request routed to a colony-pool provider is encrypted to
    // its workers, or not sent at all. Decided by the provider the request is
    // routed to, not by whether this client can encrypt: an ordinary provider
    // may offer the same model, but a pool must never see a prompt in the clear.
    const workerService = !options?.controlPlane ? routedService : undefined;
    // A route that fell back to a provider not offering the service is no proof plaintext is safe.
    const offeringProvider = billingRoute && providerOffersService(peer, billingRoute.provider, billingRoute.service)
      ? billingRoute.provider
      : null;
    const needsWorkerE2E = Boolean(workerService) && peerServiceUsesWorkerE2E(peer, { explicitProvider, routedProvider: offeringProvider });
    if (needsWorkerE2E && !this._deps.workerE2E) {
      throw buyerFault(
        `Service "${workerService}" on ${peer.peerId.slice(0, 12)}... is served by a colony pool, which needs worker encryption this client does not support`,
        'invalid-request',
      );
    }
    // Any other request to a pool seller: its payment claims must name it.
    if (!options?.controlPlane && !needsWorkerE2E && peerAnnouncesWorkerE2E(peer)) {
      this._deps.negotiator?.bpm?.trackPoolSellerRequest(peer.peerId, req.requestId);
    }
    // Decide free vs paid from the resolved route (provider + protocol), mirroring
    // the seller's per-request gate so both sides classify the request the same way.
    const videoRoute = nativeVideoRoute(req);
    if (videoRoute && !billingRoute?.unitModel) throw new Error('Video requests require advertised unit pricing');
    const isFreeService = videoRoute?.action === 'retrieve' || (requestedService
      ? (billingRoute ? isBillingRouteFree(billingRoute) : isPeerServiceFree(peer, requestedService))
      : false);
    // A free video costs nothing: say so, so a caller does not hold its whole budget for it.
    if (videoRoute?.action === 'create' && isFreeService) videoPriceUsdc = 0n;
    if (negotiator && requestedService) {
      if (isFreeService) {
        negotiator.trackFreeUsageRequestService(req.requestId, requestedService);
        try {
          await negotiator.prepareFreeUsageOpen(peer, conn, delegationsHeader);
        } catch (err) {
          debugWarn(`[BuyerRequest] Failed to prepare free usage channel for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        if (
          isUnitBilledProtocol(requestProtocol)
          && (
            !billingRoute
            || billingRoute.serviceApiProtocol !== requestProtocol
            || (!billingRoute.unitModel && !isZeroTokenPricing(billingRoute.tokenPricing))
          )
        ) {
          throw new Error(
            `Cannot send paid ${requestProtocol} request for service "${requestedService}" without service unit billing metadata`,
          );
        }
        const price = negotiator.trackRequestBillingContext(req, requestedService, billingRoute, options?.maxVideoCostUsdc);
        if (videoRoute?.action === 'create') videoPriceUsdc = price;
      }
    } else if (requestedService && isFreeService && this._deps.freeUsageManager) {
      this._deps.freeUsageManager.trackRequestService(req.requestId, requestedService);
      try {
        this._prepareDirectFreeUsageOpen(peer, conn, delegationsHeader);
      } catch (err) {
        debugWarn(`[BuyerRequest] Failed to prepare free usage channel for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      }
    }

    // A retrieve is free to send, but delivering the finished video triggers
    // the job's charge. Bind it to the accepted job so that charge is checked
    // against the job's own price and signed only after delivery.
    const videoJobId = videoRoute?.action === 'retrieve' ? videoRoute.resourceId : undefined;
    const trackedVideoRetrieve = Boolean(
      videoRoute && videoJobId && this._deps.negotiator?.bpm?.trackVideoRetrieve(peer.peerId, videoRoute.protocol, videoJobId, req.requestId),
    );
    // Read now: the job's billing may leave the request cache while a long download streams.
    const videoDuration = trackedVideoRetrieve && videoRoute && videoJobId
      ? this._deps.negotiator?.bpm?.videoJobDuration(peer.peerId, videoRoute.protocol, videoJobId)
      : undefined;

    // Colony pools: encrypt to a few of the seller's workers so the seller only
    // routes ciphertext. Everything above read the plaintext request; the
    // request sent and the raw response stay on hand for ResponseAuth, which
    // signs wire bytes.
    const workerE2E = needsWorkerE2E ? this._deps.workerE2E! : null;
    const plainReq = req;
    let sealed: SealedWorkerRequest | null = null;
    // Workers were chosen (and reserved) for this request, though sealing it may still fail.
    let reserved = false;
    let wireResponse: SerializedHttpResponse | null = null;
    const sealForAttempt = async (): Promise<void> => {
      if (!workerE2E || !workerService) return;
      const bpm = this._deps.negotiator?.bpm;
      const channelId = bpm?.getActiveSession(peer.peerId)?.sessionId ?? null;
      // Pays the workers for their earlier answers on this channel; they serve only so far ahead of it.
      const latest = channelId ? bpm?.latestSpendingAuth(peer.peerId) : null;
      const payment = latest && latest.channelId === channelId
        ? { cumulativeAmount: latest.cumulativeAmount, metadata: latest.metadata, signature: latest.signature }
        : null;
      // Only a worker the channel can credit may answer, and choosing reserves it: the request is
      // recorded in the same step, so concurrent requests can't credit more workers than a channel holds.
      const chooseRecipients = (assigned: string[]): string[] => {
        const recipients = isFreeService ? assigned : bpm?.creditableWorkers(peer.peerId, assigned) ?? assigned;
        // Only a worker it is encrypted for can answer it; the one that does is credited.
        if (recipients.length > 0) {
          bpm?.recordWorkerAttribution(peer.peerId, plainReq.requestId, recipients, isFreeService);
          reserved = true;
        }
        return recipients;
      };
      // The pool the request is for: the one it names, else the one it was routed to. A request
      // that names an ordinary provider without that model is left to the seller to place.
      const provider = [explicitProvider, billingRoute?.provider].find((name) => name && isWorkerE2EProvider(peer, name));
      sealed = await workerE2E.seal(peer, plainReq, workerService, (body) => this.sendRequest(peer, {
        requestId: `${plainReq.requestId}-assign`,
        method: 'POST',
        path: WORKER_ASSIGN_PATH,
        // Assigned by the pool the request goes to.
        headers: { 'content-type': 'application/json', ...(provider ? { 'x-antseed-provider': provider } : {}) },
        body,
      }, undefined, { controlPlane: true, ...(options?.signal ? { signal: options.signal } : {}) }), channelId, { payment, chooseRecipients });
      req = sealed.request;
    };

    let startTime = Date.now();

    const executeRequest = (): Promise<SerializedHttpResponse> => new Promise<SerializedHttpResponse>((resolve, reject) => {
      const session = sealed;
      const rawChunks: Uint8Array[] = [];
      let rawBytes = 0;
      let decryptStream = false;
      const timeoutMs = this._config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const maxStreamBufferBytes = Math.max(1, this._config.maxStreamBufferBytes ?? 16 * 1024 * 1024);
      const maxStreamDurationMs = Math.max(1, this._config.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS);
      const streamInitialResponseTimeoutMs = callbacks ? Math.max(timeoutMs, 90_000) : timeoutMs;
      const streamIdleTimeoutMs = Math.max(timeoutMs, 60_000);
      let settled = false;
      let streamStarted = false;
      let streamStartedAtMs = 0;
      let streamBufferedBytes = 0;
      let streamStartResponse: SerializedHttpResponse | null = null;
      let forwardStreamToCallbacks = false;
      const streamChunks: Uint8Array[] = [];
      const isDownload = videoRoute?.action === 'retrieve' && req.headers[VIDEO_DOWNLOAD_STREAM_HEADER] === VIDEO_DOWNLOAD_STREAM_VERSION;
      let requestSent = false;
      let downloadHash: ReturnType<typeof createStreamingResponseHash> | undefined;
      let activeTimeout: ReturnType<typeof setTimeout> | null = null;
      let activeTimeoutMs = streamInitialResponseTimeoutMs;
      const abortSignal = options?.signal;
      let abortListenerAttached = false;
      let connectionStateListenerAttached = false;
      const hasConnectionStateEvents =
        typeof (conn as { on?: unknown }).on === "function"
        && typeof (conn as { off?: unknown }).off === "function";

      const cleanupAbortListener = (): void => {
        if (abortSignal && abortListenerAttached) {
          abortSignal.removeEventListener("abort", onAbort);
          abortListenerAttached = false;
        }
      };
      const cleanupConnectionListener = (): void => {
        if (!connectionStateListenerAttached) return;
        conn.off("stateChange", onConnectionStateChange);
        connectionStateListenerAttached = false;
      };
      const onConnectionStateChange = (state: ConnectionState): void => {
        if (settled) return;
        if (state !== ConnectionState.Closed && state !== ConnectionState.Failed) {
          return;
        }
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        mux.cancelProxyRequest(req.requestId);
        reject(new Error(`Connection to ${peer.peerId} ${state.toLowerCase()} during request ${req.requestId}`));
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        debugWarn(`[BuyerRequest] Request ${req.requestId.slice(0, 8)} aborted by caller`);
        mux.cancelProxyRequest(req.requestId);
        // The seller is not told, so it may finish the generation and bill it: bound that by what the request
        // allows. Only when the caller gave the request up (see RequestExecutionOptions.signal): a timeout or a
        // closed connection is the seller's to cause, and counting it would pay a seller for answering nothing.
        const callerGaveUp = (abortSignal?.reason as { name?: unknown } | undefined)?.name === 'AbortError';
        if (requestSent && callerGaveUp && negotiator && !isFreeService) {
          const partial = { ...(streamStartResponse ?? { requestId: req.requestId, statusCode: 200, headers: {} }), body: concatChunks(streamChunks) };
          if (!isCoveredByFreeAllowance(partial)) negotiator.estimateCostFromPartialResponse(peer, req, partial, requestedService);
        }
        reject(new Error(`Request ${req.requestId} aborted`));
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
        abortListenerAttached = true;
      }
      if (hasConnectionStateEvents) {
        conn.on("stateChange", onConnectionStateChange);
        connectionStateListenerAttached = true;
      }

      const resetTimeout = (ms: number): void => {
        if (activeTimeout) clearTimeout(activeTimeout);
        activeTimeoutMs = ms;
        activeTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupAbortListener();
          cleanupConnectionListener();
          debugWarn(
            `[BuyerRequest] Request ${req.requestId.slice(0, 8)} timed out after ${Date.now() - startTime}ms `
            + `(timeout=${activeTimeoutMs}ms, stream=${callbacks ? "true" : "false"}, streamStarted=${streamStarted ? "true" : "false"}, buffered=${streamBufferedBytes}b)`,
          );
          mux.cancelProxyRequest(req.requestId);
          reject(new Error(`Request ${req.requestId} timed out`));
        }, ms);
      };

      resetTimeout(streamInitialResponseTimeoutMs);

      const finish = (response: SerializedHttpResponse, raw: SerializedHttpResponse = response): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        wireResponse = stripPeerControlledResponseHeaders(stripStreamingHeader(raw));
        const cleaned = stripPeerControlledResponseHeaders(stripStreamingHeader(response));
        debugLog(`[BuyerRequest] Response for ${req.requestId.slice(0, 8)}: status=${cleaned.statusCode} (${Date.now() - startTime}ms, ${cleaned.body.length}b)`);
        resolve(cleaned);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        reject(error);
      };

      requestSent = true;
      mux.sendProxyRequest(
        req,
        (response: SerializedHttpResponse, metadata) => {
          if (settled) return;
          // Mark a covered response as soon as its headers arrive: the seller's
          // NeedAuth travels on another mux and must not beat this.
          if (isCoveredByFreeAllowance(response)) negotiator?.bpm.markRequestCovered(peer.peerId, req.requestId);
          if (isDownload && streamStarted && !metadata.streamingStart) {
            fail(new Error('Video download interrupted'));
            return;
          }
          if (metadata.streamingStart) {
            if (isDownload) {
              try {
                if (streamStarted || !callbacks?.onResponseChunk || response.statusCode !== 200 || response.body.length || response.headers[VIDEO_DOWNLOAD_STREAM_HEADER] !== VIDEO_DOWNLOAD_STREAM_VERSION || response.headers['content-type'] !== 'video/mp4') throw new Error('Invalid video stream');
                downloadHash = createStreamingResponseHash(stripPeerControlledResponseHeaders(response));
              } catch (error) {
                mux.cancelProxyRequest(req.requestId);
                fail(error as Error);
                return;
              }
            }
            streamStarted = true;
            streamStartedAtMs = Date.now();
            streamBufferedBytes = 0;
            streamStartResponse = stripPeerControlledResponseHeaders(stripStreamingHeader(response));
            forwardStreamToCallbacks = response.statusCode < 400;
            decryptStream = session !== null && (response.headers['content-type'] ?? '').includes('text/event-stream');
            // A worker's successful answer streams only as sealed SSE; anything else would skip decryption and verification.
            if (session && response.statusCode < 400 && !decryptStream) {
              mux.cancelProxyRequest(req.requestId);
              fail(peerFault(`Worker stream for ${req.requestId} is not sealed SSE`, 'peer-protocol-violation'));
              return;
            }
            debugLog(`[BuyerRequest] Stream started for ${req.requestId.slice(0, 8)}; idle-timeout=${streamIdleTimeoutMs}ms`);
            resetTimeout(streamIdleTimeoutMs);
            if (forwardStreamToCallbacks) {
              callbacks?.onResponseStart?.(streamStartResponse, { streaming: true });
            }
            return;
          }

          let plainResponse = response;
          if (session) {
            try {
              plainResponse = { ...response, body: session.openBody(response.body) };
              // Only the pool's own errors may arrive unsealed.
              if (response.statusCode < 400 && !session.verified) throw new Error('unsealed success');
              if (!session.usageConsistent) throw new Error('usage mismatch');
            } catch {
              fail(peerFault(`Worker response for ${req.requestId} failed verification`, 'peer-protocol-violation'));
              return;
            }
          }
          callbacks?.onResponseStart?.(
            adaptPeerResponse(
              stripPeerControlledResponseHeaders(stripStreamingHeader(plainResponse)),
            ),
            { streaming: false },
          );
          finish(plainResponse, response);
        },
        async (chunk) => {
          if (settled) return;
          if (!streamStarted) return;

          if (downloadHash) {
            try {
              // Downloads have no total duration limit; the idle timeout below ends stalled transfers.
              resetTimeout(streamIdleTimeoutMs);
              downloadHash.update(chunk.data);
              await callbacks!.onResponseChunk!(chunk);
              if (chunk.done) finish({ ...streamStartResponse!, body: new Uint8Array(0), streamedBody: downloadHash.finish() });
            } catch (error) {
              mux.cancelProxyRequest(req.requestId);
              fail(error as Error);
            }
            return;
          }

          resetTimeout(streamIdleTimeoutMs);

          if (Date.now() - streamStartedAtMs > maxStreamDurationMs) {
            mux.cancelProxyRequest(req.requestId);
            fail(new Error(`Stream ${req.requestId} exceeded max duration (${maxStreamDurationMs}ms)`));
            return;
          }

          if (decryptStream) {
            // The wire bytes are kept for the response receipt: bound them too, since events
            // the opener ignores add wire bytes without any plaintext.
            rawBytes += chunk.data.length;
            if (rawBytes > maxStreamBufferBytes) {
              mux.cancelProxyRequest(req.requestId);
              fail(buyerFault(`Stream ${req.requestId} exceeded max buffered size (${maxStreamBufferBytes} bytes)`, 'buyer-stream-limit'));
              return;
            }
            rawChunks.push(chunk.data);
            try {
              chunk = { ...chunk, data: session!.pushStream(chunk.data) };
            } catch {
              mux.cancelProxyRequest(req.requestId);
              fail(peerFault(`Worker stream for ${req.requestId} failed verification`, 'peer-protocol-violation'));
              return;
            }
          }

          if (forwardStreamToCallbacks) {
            callbacks?.onResponseChunk?.(chunk);
          }

          if (chunk.data.length > 0) {
            const nextBufferedBytes = streamBufferedBytes + chunk.data.length;
            const enforceBufferLimit = !forwardStreamToCallbacks || !callbacks?.onResponseChunk;
            if (enforceBufferLimit && nextBufferedBytes > maxStreamBufferBytes) {
              mux.cancelProxyRequest(req.requestId);
              fail(buyerFault(
                `Stream ${req.requestId} exceeded max buffered size (${maxStreamBufferBytes} bytes)`,
                'buyer-stream-limit',
              ));
              return;
            }
            streamBufferedBytes = nextBufferedBytes;
            streamChunks.push(chunk.data);
          }

          if (!chunk.done) return;

          if (!streamStartResponse) {
            fail(peerFault(
              `Stream ${req.requestId} ended before response start`,
              'peer-protocol-violation',
            ));
            return;
          }

          // A sealed stream counts only if the worker's end marker verified and the billed usage is the worker's.
          if (decryptStream && streamStartResponse.statusCode < 400 && (!session!.verified || !session!.usageConsistent)) {
            fail(peerFault(
              `Worker stream for ${req.requestId} ${session!.verified ? 'billed usage that differs from its worker\'s' : 'ended without its end marker'}`,
              'peer-protocol-violation',
            ));
            return;
          }

          finish({
            ...streamStartResponse,
            body: concatChunks(streamChunks),
          }, decryptStream ? { ...streamStartResponse, body: concatChunks(rawChunks) } : undefined);
        },
      );
    });

    // Paid work in flight sizes the buyer's reserve top-ups (see beginPaidRequest).
    const bpm = isFreeService ? undefined : this._deps.negotiator?.bpm;
    // A control-plane call is never charged, so it is not named to the payment manager.
    const paidRequestId = negotiator ? req.requestId : undefined;
    // Provider video APIs may use HTTP 402 for their own errors; only start
    // Antseed payment negotiation when the response is our payment contract.
    const startsPaymentNegotiation = (answer: SerializedHttpResponse): boolean => answer.statusCode === 402
      && Boolean(negotiator)
      && !externalSpendingAuth
      && (!videoRoute || isPaymentRequired402(answer));
    const executeCountedRequest = async (): Promise<SerializedHttpResponse> => {
      bpm?.beginPaidRequest(peer.peerId);
      let answered = false;
      // Tell the payment manager whether the worker's sealed answer verified:
      // a NeedAuth for the request waits for this before it is signed.
      const delivered = (session: SealedWorkerRequest | null): void => {
        if (!session) return;
        const verified = session.verified && session.usageConsistent;
        this._deps.negotiator?.bpm?.recordWorkerDelivery(plainReq.requestId, verified ? session.usage : null, session.worker);
      };
      const attempt = async (): Promise<{ answer: SerializedHttpResponse; session: SealedWorkerRequest | null }> => {
        try {
          await sealForAttempt();
        } catch (error) {
          // Its chosen workers are released even when sealing failed after choosing them.
          if (sealed || reserved) this._deps.negotiator?.bpm?.recordWorkerDelivery(plainReq.requestId, null);
          throw error;
        }
        const session: SealedWorkerRequest | null = sealed;
        try {
          return { answer: await executeRequest(), session };
        } catch (error) {
          if (session) this._deps.negotiator?.bpm?.recordWorkerDelivery(plainReq.requestId, null);
          throw error;
        }
      };
      try {
        let first: Awaited<ReturnType<typeof attempt>>;
        try {
          first = await attempt();
        } catch (error) {
          // The channel credits as many workers as one can, and the pool now assigns others: settle
          // and close it (its workers are paid with it), then take them on a new channel.
          if ((error as { code?: unknown })?.code !== 'worker_slots_full' || !negotiator) throw error;
          const bpm = negotiator.bpm;
          const channelId = bpm?.getActiveSession(peer.peerId)?.sessionId;
          if (!channelId || !bpm?.workerSlotsFull(peer.peerId)) throw error;
          debugLog(`[BuyerRequest] channel ${channelId.slice(0, 18)}... credits the most workers it can; closing it for a new one`);
          await negotiator.requestChannelClose(peer.peerId, conn, { channelId });
          first = await attempt();
        }
        let { answer, session } = first;
        if (session && isWorkerUnavailable(answer)) {
          // None of the assigned workers could take it (the pool already tried each).
          workerE2E!.forget(peer.peerId, workerService!);
          // Take new ones, once, only if the buyer already lets several workers read a request.
          if (workerE2E!.failover) {
            delivered(session);
            ({ answer, session } = await attempt());
          }
        }
        answered = true;
        try {
          // Price what arrived before anything else runs: the seller's NeedAuth
          // for it is the next frame, travels on another mux, and is judged
          // against this. A 402 the buyer retries leaves nothing to charge.
          if (negotiator && !isFreeService && !startsPaymentNegotiation(answer)) {
            this._estimatePaidCost(negotiator, peer, plainReq, answer, requestedService);
          }
        } finally {
          // Only after it is priced: a NeedAuth waiting on the verification must find what is owed for it.
          delivered(session);
        }
        return answer;
      } finally {
        bpm?.endPaidRequest(peer.peerId, paidRequestId, answered);
      }
    };
    const response = await executeCountedRequest();

    // A seller demanded payment while this buyer runs no payment machinery
    // (payments disabled or unconfigured). Forwarding the raw seller 402 would
    // tell the user to add credits, but no amount of credits helps — the buyer
    // cannot sign an authorization at all. Return a buyer-fault error naming
    // the real cause. Clients that manage payment themselves (external
    // spending auth) and control-plane calls still get the raw 402.
    if (
      response.statusCode === 402
      && !negotiator
      && !options?.controlPlane
      && !externalSpendingAuth
      && isPaymentRequired402(response)
    ) {
      debugWarn(
        `[BuyerRequest] Seller ${peer.peerId.slice(0, 12)}... requires payment but payments are not running on this buyer — returning buyer-fault error`,
      );
      return buyerPaymentsInactiveResponse(response, peer.peerId);
    }

    if (negotiator && startsPaymentNegotiation(response)) {
      // Parallel requests can leave the seller's spend several requests ahead
      // of the signed cumulative. Keep catching up while the gap shrinks or
      // the seller accepts more: other requests finishing can widen the gap
      // even while the buyer is paying.
      let paymentResponse = response;
      let retriedResponse: SerializedHttpResponse;
      for (let retry = 1; ; retry++) {
        const result = await negotiator.handle402(paymentResponse, peer, conn, req, mux.activeRequestCount() + 1);
        if (result.action === 'return') {
          return adaptPeerResponse(result.response);
        }
        startTime = Date.now();
        retriedResponse = await executeCountedRequest();
        const previous = catchUpState(paymentResponse);
        const current = catchUpState(retriedResponse);
        if (current == null || previous == null) break;
        const progressing = current.gap < previous.gap || current.accepted > previous.accepted;
        if (!progressing || retry >= MAX_CATCH_UP_RETRIES) {
          return adaptPeerResponse(catchUpIncompleteResponse(retriedResponse));
        }
        paymentResponse = retriedResponse;
      }
      const retriedDelivered = this._recordVideoDelivery(peer, retriedResponse, trackedVideoRetrieve, videoDuration, videoRoute, videoJobId, req.requestId);
      this._recordResponseAuth(
        peer,
        req,
        wireResponse ?? retriedResponse,
        requestedService,
        verificationMux,
        options?.captureResponseAuthPreimages === true,
      );
      return withVideoDelivered(adaptPeerResponse(retriedResponse), retriedDelivered);
    }

    const videoDelivered = this._recordVideoDelivery(peer, response, trackedVideoRetrieve, videoDuration, videoRoute, videoJobId, req.requestId);
    this._recordResponseAuth(
      peer,
      req,
      wireResponse ?? response,
      requestedService,
      verificationMux,
      options?.captureResponseAuthPreimages === true,
    );
    return withVideoDelivered(adaptPeerResponse(response), videoDelivered);
  }

  /**
   * Whether a retrieve's answer is the finished video (readable, close enough
   * to the requested duration). For a tracked job it is only once the delivery
   * is recorded, which ends the job (it is charged once, and never again): a
   * delivery whose job could not be removed from storage is `unrecorded`: the
   * file is fine and the job is not given up, but it is not reported as
   * delivered until the buyer has saved that it is done.
   */
  private _recordVideoDelivery(
    peer: BuyerPeerView,
    response: SerializedHttpResponse,
    tracked: boolean,
    duration: number | undefined,
    videoRoute: ReturnType<typeof nativeVideoRoute>,
    videoJobId: string | undefined,
    requestId: string,
  ): VideoDelivery {
    if (videoRoute?.action !== 'retrieve' || !videoJobId) return null;
    if (tracked && videoJobEndedWithoutVideo(response)) {
      this._deps.negotiator?.bpm?.recordVideoFailed(peer.peerId, videoRoute.protocol, videoJobId);
      return null;
    }
    if (!nativeVideoDelivered(response, duration)) return null;
    if (!tracked) {
      return this._deps.negotiator?.bpm?.videoDeliveryUnsaved(peer.peerId, videoRoute.protocol, videoJobId) === true ? 'unrecorded' : 'delivered';
    }
    const recorded = this._deps.negotiator?.bpm?.recordVideoDelivered(peer.peerId, videoRoute.protocol, videoJobId, requestId);
    if (recorded === 'recorded') return 'delivered';
    return recorded === 'unsaved' ? 'unrecorded' : null;
  }

  /**
   * Expect a charge for a paid response, unless the seller served it from the
   * service's free allowance: then nothing is owed, and no later NeedAuth can
   * claim it.
   */
  private _estimatePaidCost(
    negotiator: BuyerPaymentNegotiator,
    peer: BuyerPeerView,
    request: SerializedHttpRequest,
    response: SerializedHttpResponse,
    service: string | undefined,
  ): void {
    const { requestId } = request;
    if (isCoveredByFreeAllowance(response)) {
      debugLog(`[BuyerRequest] ${peer.peerId.slice(0, 12)}... served ${service ?? 'request'} from its free allowance`);
      negotiator.bpm.markRequestCovered(peer.peerId, requestId);
      return;
    }
    negotiator.estimateCostFromResponse(peer, response, service, requestId, request.body);
  }

  private _prepareDirectFreeUsageOpen(peer: BuyerPeerView, conn: BuyerConnection, freeTierDelegations: string | null): void {
    const freeUsage = this._deps.freeUsageManager;
    if (!freeUsage) return;

    const pmux = new PaymentMux(conn);
    pmux.onFreeUsageAck((payload) => {
      freeUsage.handleAck(peer.peerId, payload);
    });
    pmux.onNeedFreeUsageAuth((payload) => {
      const p = freeUsage.handleNeedAuth(peer.peerId, payload, pmux);
      p.catch((err) => {
        debugWarn(`[BuyerRequest] Failed to handle free usage auth request from ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      });
    });
    this._deps.registerPaymentMux(peer.peerId, pmux);
    void freeUsage.prepareOpen(peer, pmux, freeTierDelegations)
      .then(() => freeUsage.waitForOpenAck(peer.peerId))
      .catch((err) => {
        debugWarn(`[BuyerRequest] Free usage open ack unavailable for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      });
  }

  private _recordResponseAuth(
    peer: BuyerPeerView,
    request: SerializedHttpRequest,
    response: SerializedHttpResponse,
    requestedService: string | undefined,
    verificationMux: VerificationMux,
    capturePreimages: boolean,
  ): void {
    if (!shouldExpectResponseAuth(peer, response, requestedService)) {
      return;
    }
    // Snapshot the headers: callers add headers to the returned response
    // (e.g. x-antseed-seller-peer), which would otherwise change what the
    // late-arriving ResponseAuth is verified against.
    response = { ...response, headers: { ...response.headers } };
    const storage = this._deps.verificationStorage;
    const advertisedService = requestedService ?? 'unknown';
    const expectedChannelId = this._deps.negotiator?.bpm?.getResponseAuthChannelId(peer.peerId, request.requestId)
      ?? this._deps.negotiator?.bpm?.getActiveSession(peer.peerId)?.sessionId
      ?? null;
    const responseAuthPromise = verificationMux.waitForResponseAuth(
      request.requestId,
      this._config.responseAuthTimeoutMs ?? DEFAULT_RESPONSE_AUTH_GRACE_MS,
    );

    void responseAuthPromise
      .then((payload) => {
        const verification = verifyResponseAuth(payload, {
          request,
          response,
          buyerPeerId: this._deps.localPeerId,
          sellerPeerId: peer.peerId,
          advertisedService,
          channelId: expectedChannelId,
        });

        if (!verification.valid) {
          debugWarn(
            `[BuyerRequest] Invalid ResponseAuth for ${request.requestId.slice(0, 8)} from ${peer.peerId.slice(0, 12)}...: ${verification.reason ?? 'unknown'}`,
          );
        }

        storage?.insertResponseAuth({
          ...payload,
          receivedAt: Date.now(),
          verified: verification.valid,
          verificationError: verification.reason ?? null,
          requestPreimage: capturePreimages ? encodeHttpRequest(request) : null,
          responsePreimage: capturePreimages
            ? encodeHttpResponse(stripStreamingHeader(response))
            : null,
        }, { sellerPeerId: peer.peerId, requestedService: advertisedService });

        void this._deps.verificationSampler?.maybeStoreResponseAuthSample({
          request,
          response,
          responseAuth: payload,
          verified: verification.valid,
          verificationError: verification.reason ?? null,
        }).catch((err) => {
          debugWarn(`[BuyerRequest] Failed to store ResponseAuth sample for ${request.requestId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
        });
      })
      .catch((err) => {
        debugWarn(`[BuyerRequest] Missing ResponseAuth for ${request.requestId.slice(0, 8)} from ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      });
  }
}

/**
 * The requested service: on a routing protocol whose paths name no service, the peer's single
 * service of that protocol; else `service`/`model` from a JSON or multipart body.
 */
function extractRequestedService(peer: BuyerPeerView, request: SerializedHttpRequest): string | undefined {
  const routingProtocol = routingProtocolForPath(request.path);
  if (routingProtocol && routingWireProtocol(routingProtocol).oneServicePerSeller) {
    return findRoutingService(peer.providerServiceApiProtocols, routingProtocol)?.serviceId;
  }
  if (nativeVideoRoute(request)) return requestService(request);
  const parsed = extractRequestBodyFields(request.headers, request.body);
  const service = parsed?.service ?? parsed?.model;
  if (typeof service === 'string' && service.length > 0) return service;
  return undefined;
}

/** The provider, protocol and pricing a request to `peer` is billed under. Exported for tests. */
export function selectBillingRoute(
  peer: BuyerPeerView,
  request: SerializedHttpRequest,
  service: string,
): SelectedBillingRoute | null {
  const provider = selectProviderForService(peer, service, extractRequestedProvider(request), request);
  if (!provider) return null;
  const serviceApiProtocol = selectProtocolForService(peer, provider, service, request);
  const unitModel = peer.providerServiceUnitBillingModels?.[provider]?.services[service]?.[serviceApiProtocol];
  const tokenPricing = selectTokenPricing(peer, provider, service);
  const videoOptions = peer.providerServiceCapabilities?.[provider]?.services[service]?.video;
  return {
    sellerPeerId: peer.peerId,
    provider,
    service,
    serviceApiProtocol,
    ...(unitModel ? { unitModel } : {}),
    ...(videoOptions ? { videoOptions } : {}),
    ...(tokenPricing ? { tokenPricing } : {}),
  };
}

function selectProviderForService(
  peer: BuyerPeerView,
  service: string,
  requestedProvider: string | null,
  request: SerializedHttpRequest,
): string | null {
  const providers = peer.providers ?? [];
  const named = requestedProvider
    ? providers.find((candidate) => candidate.toLowerCase() === requestedProvider)
    : undefined;
  if (named) {
    return providerOffersService(peer, named, service) ? named : null;
  }
  // No provider named, or one the peer does not announce (a pin from before
  // sellers announced provider IDs, or a plugin name): choose one.

  // Mirrors the seller's matchProvider: a native video request needs a
  // provider serving its protocol, and takes the first one, so a job's
  // retrieves reach the provider that accepted it whatever its health is now.
  // Other requests prefer a provider whose self health check is not failing.
  const videoRoute = nativeVideoRoute(request);
  const eligible = providers.filter((provider) =>
    providerOffersService(peer, provider, service)
    && (!videoRoute || Boolean(peer.providerServiceApiProtocols?.[provider]?.services[service]?.includes(videoRoute.protocol))),
  );
  const healthy = videoRoute ? undefined : eligible.find((provider) =>
    !isServiceHealthFailing(providerServiceHealthFor(peer.providerServiceHealth, provider, service)),
  );
  const match = healthy ?? eligible[0] ?? providers.find((provider) =>
    providerOffersService(peer, provider, service),
  );
  return match ?? providers[0] ?? null;
}

function providerOffersService(peer: BuyerPeerView, provider: string, service: string): boolean {
  return Boolean(
    peer.providerPricing?.[provider]?.services?.[service]
    || peer.providerServiceUnitBillingModels?.[provider]?.services[service]
    || peer.providerServiceApiProtocols?.[provider]?.services[service]
    || peer.providerServiceCategories?.[provider]?.services[service],
  );
}

function selectProtocolForService(
  peer: BuyerPeerView,
  provider: string,
  service: string,
  request: SerializedHttpRequest,
): ServiceApiProtocol {
  const protocols =
    peer.providerServiceApiProtocols?.[provider]?.services[service];
  const billingProtocols = Object.keys(
    peer.providerServiceUnitBillingModels?.[provider]?.services[service] ?? {},
  ) as ServiceApiProtocol[];
  const candidates = protocols ?? billingProtocols;
  const requestProtocol = detectRequestServiceApiProtocol(request);
  const selected = selectTargetProtocolForRequest(requestProtocol, candidates);
  if (selected) return selected.targetProtocol;
  if (protocols?.[0]) return protocols[0];
  return billingProtocols[0] ?? "openai-chat-completions";
}

function selectTokenPricing(
  peer: BuyerPeerView,
  provider: string,
  service: string,
): SelectedBillingRoute["tokenPricing"] {
  const providerPricing = peer.providerPricing?.[provider];
  const pricing = providerPricing?.services?.[service] ?? providerPricing?.defaults;
  if (pricing) return pricing;
  return peerDefaultPricing(peer);
}

function peerDefaultPricing(peer: BuyerPeerView): SelectedBillingRoute["tokenPricing"] {
  if (peer.defaultInputUsdPerMillion == null && peer.defaultOutputUsdPerMillion == null) {
    return undefined;
  }
  return {
    inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
    outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
    cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
  };
}

function isZeroTokenPricing(pricing: SelectedBillingRoute["tokenPricing"]): boolean {
  return Boolean(
    pricing
    && pricing.inputUsdPerMillion === 0
    && pricing.outputUsdPerMillion === 0
    && (pricing.cachedInputUsdPerMillion == null || pricing.cachedInputUsdPerMillion === 0),
  );
}

function extractRequestedProvider(request: SerializedHttpRequest): string | null {
  const providers = Object.entries(request.headers)
    .filter(([header]) => header.toLowerCase() === "x-antseed-provider")
    .map(([, value]) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  return providers[0] ?? null;
}

function stripStreamingHeader(response: SerializedHttpResponse): SerializedHttpResponse {
  if (response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] !== "1") {
    return response;
  }
  const headers = { ...response.headers };
  delete headers[ANTSEED_STREAMING_RESPONSE_HEADER];
  return { ...response, headers };
}

export function stripPeerControlledResponseHeaders(
  response: SerializedHttpResponse,
): SerializedHttpResponse {
  const headers = Object.fromEntries(
    Object.entries(response.headers).filter(
      ([name]) => !BUYER_ONLY_RESPONSE_HEADERS.has(name.toLowerCase()),
    ),
  );
  return Object.keys(headers).length === Object.keys(response.headers).length
    ? response
    : { ...response, headers };
}

/** Marks a retrieve answer the buyer accepted as the finished video. */
type VideoDelivery = 'delivered' | 'unrecorded' | null;

function withVideoDelivered(response: SerializedHttpResponse, delivery: VideoDelivery): SerializedHttpResponse {
  if (delivery === null) return response;
  return { ...response, headers: { ...response.headers, [VIDEO_DELIVERED_HEADER]: delivery === 'delivered' ? '1' : VIDEO_DELIVERY_UNRECORDED } };
}

/** True when a 402 body carries the seller's payment_required contract (flat or wrapped). */
function isPaymentRequired402(response: SerializedHttpResponse): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    if (parsed.error === 'payment_required') return true;
    return typeof parsed.error === 'object' && parsed.error !== null
      && (parsed.error as Record<string, unknown>).type === 'payment_required';
  } catch {
    return false;
  }
}

/** Retries after a seller catch-up 402 (three attempts in total). */
const MAX_CATCH_UP_RETRIES = 2;

/**
 * A seller catch-up 402's unsigned spend (required - accepted) and accepted
 * amount, or null when the response is not a catch-up 402 (exhausted
 * channels carry a code).
 */
function catchUpState(response: SerializedHttpResponse): { gap: bigint; accepted: bigint } | null {
  if (response.statusCode !== 402) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    if (body.error !== 'payment_required' || body.code != null) return null;
    const required = BigInt(String(body.requiredCumulativeAmount));
    const accepted = BigInt(String(body.currentAcceptedCumulative));
    if (body.reserveMaxAmount != null && required > BigInt(String(body.reserveMaxAmount))) return null;
    return { gap: required > accepted ? required - accepted : 0n, accepted };
  } catch {
    return null;
  }
}

/**
 * Buyer-authored error for a catch-up that is still short after the retries.
 * The channel is fine and the next attempt usually succeeds, so it is a
 * retryable 503: routers fail over and clients retry.
 */
function catchUpIncompleteResponse(response: SerializedHttpResponse): SerializedHttpResponse {
  return {
    ...response,
    statusCode: 503,
    headers: { ...response.headers, 'content-type': 'application/json', 'retry-after': '2' },
    body: new TextEncoder().encode(JSON.stringify({
      error: 'payment_negotiation_failed',
      reason: 'catch_up_incomplete',
      message: 'The seller is still waiting for payment of earlier requests on this channel. Retry the request.',
    })),
  };
}

/**
 * Buyer-fault replacement for a seller 402 when payments are not running on
 * this buyer. Carries the fault-attribution header so downstream adapters
 * shape it per protocol, routers stop failing over, and UIs report a
 * buyer-side problem instead of asking the user to add credits.
 */
function buyerPaymentsInactiveResponse(
  response: SerializedHttpResponse,
  peerId: PeerId,
): SerializedHttpResponse {
  return {
    ...response,
    statusCode: 503,
    headers: {
      ...response.headers,
      'content-type': 'application/json',
      [ANTSEED_FAULT_ATTRIBUTION_HEADER]: 'buyer',
    },
    body: new TextEncoder().encode(JSON.stringify({
      error: 'buyer_payments_inactive',
      reason: 'payments_not_running',
      peerId,
      message: 'This seller requires payment, but payments are not running on this buyer, '
        + 'so the request could not be authorized. This is not a balance problem — '
        + 'enable payments on the buyer (check its startup logs and chain settings), or use a free peer.',
    })),
  };
}

function shouldExpectResponseAuth(
  peer: BuyerPeerView,
  response: SerializedHttpResponse,
  requestedService: string | undefined,
): boolean {
  if (!requestedService) return false;
  if (response.statusCode === 402) return false;
  return peer.capabilities?.includes(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1) === true;
}

/**
 * Free/paid gate for a resolved billing route. Mirrors the seller's
 * per-request gate (seller-request-handler isFreeService): free iff the
 * resolved token pricing is zero AND the unit model resolved for the selected
 * protocol is absent or free.
 */
function isBillingRouteFree(route: SelectedBillingRoute): boolean {
  return isZeroTokenPricing(route.tokenPricing)
    && (!route.unitModel || isFreeUnitBillingModel(route.unitModel));
}

/** Fallback gate when no billing route could be resolved for the service. */
function isPeerServiceFree(peer: BuyerPeerView, service: string): boolean {
  // Unit-billed services (e.g. images) can have zero token pricing but still
  // charge per unit — stay conservative when any announced model is paid.
  for (const providerModels of Object.values(peer.providerServiceUnitBillingModels ?? {})) {
    const serviceModels = providerModels.services[service];
    if (!serviceModels) continue;
    for (const model of Object.values(serviceModels)) {
      if (model && !isFreeUnitBillingModel(model)) return false;
    }
  }
  const servicePricing = findPeerServicePricing(peer, service);
  if (!servicePricing) return false;
  return (servicePricing.inputUsdPerMillion ?? 0) === 0
    && (servicePricing.outputUsdPerMillion ?? 0) === 0
    && (servicePricing.cachedInputUsdPerMillion ?? 0) === 0;
}

function findPeerServicePricing(peer: BuyerPeerView, service: string): {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
} | null {
  for (const providerPricing of Object.values(peer.providerPricing ?? {})) {
    const servicePricing = providerPricing.services?.[service];
    if (servicePricing) return servicePricing;
  }
  if (peer.defaultInputUsdPerMillion != null || peer.defaultOutputUsdPerMillion != null) {
    return {
      inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
      outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
      cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
    };
  }
  return null;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

const FAILED_VIDEO_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED']);

/**
 * A retrieve answer that ends the job without a video: a JSON status the
 * job failed (the seller closes the job's channel on it). Error answers are
 * not: a malformed retrieve, 404, 429 or 5xx leaves the job as it is.
 */
export function videoJobEndedWithoutVideo(response: SerializedHttpResponse): boolean {
  if (response.streamedBody) return false;
  const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (!contentType?.toLowerCase().startsWith('application/json')) return false;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return false;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const status = (body as { status?: unknown }).status;
  return response.statusCode === 200 && typeof status === 'string' && FAILED_VIDEO_STATUSES.has(status.toUpperCase());
}
