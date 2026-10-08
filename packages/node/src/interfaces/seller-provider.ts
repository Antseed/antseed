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

  /** Optional startup hook — validate credentials, warm caches, etc. */
  init?(): Promise<void>;

  /** Return current and maximum concurrent request counts */
  getCapacity(): { current: number; max: number };
}

export interface ProviderStreamCallbacks {
  signal?: AbortSignal;
  onResponseStart: (response: SerializedHttpResponse) => void;
  onResponseChunk: (chunk: SerializedHttpResponseChunk) => void | Promise<void>;
}
