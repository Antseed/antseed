import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '../types/http.js';
import type { ServiceApiProtocol } from '../types/service-api.js';
import type { ServiceUnitBillingModelsV1 } from '../types/billing.js';
import type { ServiceCapabilities, ServiceHealth } from '../discovery/peer-metadata.js';

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
   * False when the provider failed to initialize (e.g. an OAuth refresh
   * failure) and is retained only so a later health check can recover it.
   * The model health checker announces its services as failing until a
   * check passes, then sets this back to true.
   */
  healthCheckAvailable?: boolean;

  /**
   * The seller's self health check result per service, written by the model
   * health checker and signed into metadata (v13+). Absent services have not
   * been checked yet.
   */
  serviceHealth?: Record<string, ServiceHealth>;

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

  /** Optional peer capabilities the seller advertises because of this provider (e.g. `worker-pool-e2e.v2`). */
  peerCapabilities?: string[];

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
   * Optional handler for free control routes under ANTSEED_PROVIDER_CONTROL_PATH
   * (no payment, no metering, rate limited per buyer). Must not run inference.
   */
  handleControlRequest?(req: SerializedHttpRequest): Promise<SerializedHttpResponse>;

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

  /**
   * Optional: called after a paid request is charged to the buyer's channel,
   * with the amount charged. Free and allowance-covered requests are not
   * reported. Lets a provider that fans requests out to several backends
   * (e.g. a worker pool) attribute revenue to the backend that served it.
   */
  onRequestCharged?(charge: ProviderRequestCharge): void;

  /**
   * Optional: the node registers a listener here once it announces. The
   * provider calls it after changing `services` in place (e.g. a worker pool
   * whose capacity comes and goes) so the seller re-signs its metadata.
   */
  setServicesChangedListener?(listener: () => void): void;
}

export interface ProviderRequestCharge {
  requestId: string;
  service?: string;
  /** Amount charged, in USDC base units (6 decimals). */
  costUsdc: bigint;
  inputTokens: number;
  outputTokens: number;
  freshInputTokens: number;
  cachedInputTokens: number;
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
  /** `outOfCredit`: the account's balance is the cause (the seller alerts it as a billing problem). */
  | { status: 'unavailable'; reason: string; outOfCredit?: boolean }
  | { status: 'unknown'; reason?: string };

export interface ProviderStreamCallbacks {
  signal?: AbortSignal;
  onResponseStart: (response: SerializedHttpResponse) => void;
  onResponseChunk: (chunk: SerializedHttpResponseChunk) => void | Promise<void>;
}
