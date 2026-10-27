import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '../types/http.js';
import type { ServiceApiProtocol } from '../types/service-api.js';
import type { ServiceUnitBillingModelsV1 } from '../types/billing.js';
import type { ServiceCapabilities } from '../discovery/peer-metadata.js';

export interface ProviderTokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Price per million cached input tokens. Defaults to inputUsdPerMillion if not set. */
  cachedInputUsdPerMillion?: number;
}

export interface ProviderPricing {
  defaults: ProviderTokenPricingUsdPerMillion;
  services?: Record<string, ProviderTokenPricingUsdPerMillion>;
}

/**
 * Interface that seller nodes implement to provide inference.
 *
 * Each provider represents one upstream LLM service (e.g., Anthropic, OpenAI, local LLM).
 * The SDK handles P2P connections, discovery, metering, and payments.
 * You just handle the HTTP request → response conversion.
 */
export interface Provider {
  /** Unique name for this provider (e.g., 'anthropic', 'openai', 'my-local-llm') */
  name: string;

  /** Service IDs this provider supports (e.g., ['claude-sonnet-4-5-20250929', 'claude-opus-4-0-20250514']) */
  services: string[];

  /**
   * Runtime health availability. The model health checker sets this to false
   * when every configured service has been removed, allowing discovery to
   * omit the provider instead of interpreting an empty service list as a
   * wildcard. Undefined means available for providers without health checks.
   */
  healthCheckAvailable?: boolean;

  /** Seller pricing in USD per 1M tokens (defaults + optional per-service overrides). */
  pricing: ProviderPricing;

  /** Optional service category tags used for discovery metadata. */
  serviceCategories?: Record<string, string[]>;

  /** Optional per-service API protocol support advertised via discovery metadata. */
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;

  /** Optional per-service/protocol unit billing model support advertised via discovery metadata. */
  serviceUnitBillingModels?: ServiceUnitBillingModelsV1;

  /** Optional per-service model capability hints advertised via discovery metadata. */
  serviceCapabilities?: Record<string, ServiceCapabilities>;

  /** Maximum concurrent requests this provider can handle */
  maxConcurrency: number;

  /**
   * Handle an incoming inference request and return the response.
   */
  handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse>;

  /**
   * Optional streaming request handler. Implementations should call
   * `callbacks.onResponseStart` once, then `callbacks.onResponseChunk`
   * zero or more times (including a final `done=true` chunk).
   *
   * Must resolve with the complete reconstructed response body, except negotiated
   * video downloads, whose body is hashed incrementally by the node.
   */
  handleRequestStream?(
    req: SerializedHttpRequest,
    callbacks: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse>;

  /**
   * Optional free check of a request before any payment is asked for. The
   * seller node calls it after matching the service and pricing the request,
   * before the free tier, the payment-channel 402 and `handleRequest`. A
   * non-null response is sent to the buyer as-is, so a request the provider
   * would refuse (for example a source video of the wrong length) costs the
   * buyer nothing. Return null to go on. The buyer sends the same request
   * (same requestId and body) again after opening a payment channel, so
   * expensive checks should keep their answer per request.
   */
  precheckRequest?(req: SerializedHttpRequest, context: ProviderPrecheckContext): Promise<SerializedHttpResponse | null>;

  /** Optional startup hook — validate credentials, warm caches, etc. */
  init?(): Promise<void>;

  /** Return current and maximum concurrent request counts */
  getCapacity(): { current: number; max: number };

  /**
   * Optional free check of each service the request probe skips, because
   * every request generates and charges for media (image and video): is the
   * model still offered upstream? Implementations call only free upstream
   * endpoints (for example a model list) and answer for each requested
   * service. The model health checker calls it once per sweep.
   */
  checkServiceHealth?(services: string[]): Promise<Record<string, ServiceHealthStatus>>;

  /**
   * Optional free check of the seller's upstream account: is the key valid
   * and the account funded? Called once per sweep, separately from the model
   * check. `unavailable` counts as a failed check for every image and video
   * service of this provider.
   */
  checkUpstreamAccount?(): Promise<UpstreamAccountStatus>;
}

/** Context of `Provider.precheckRequest`. */
export interface ProviderPrecheckContext {
  /** Buyer the request comes from (lowercase peer ID). */
  buyerPeerId: string;
}

/**
 * Result of `Provider.checkServiceHealth` for one service. `unknown` (the
 * check itself failed or can't tell) never counts against the service.
 */
export type ServiceHealthStatus =
  | { status: 'available' }
  | { status: 'unavailable'; reason: string }
  | { status: 'unknown'; reason?: string };

/**
 * Result of `Provider.checkUpstreamAccount`. `balanceUsd` is the upstream
 * account balance when the provider can read it.
 */
export type UpstreamAccountStatus =
  | { status: 'available'; balanceUsd?: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'unknown'; reason?: string };

export interface ProviderStreamCallbacks {
  signal?: AbortSignal;
  onResponseStart: (response: SerializedHttpResponse) => void;
  onResponseChunk: (chunk: SerializedHttpResponseChunk) => void | Promise<void>;
}
