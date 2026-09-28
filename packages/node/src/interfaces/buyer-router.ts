import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { RequestExecutionOptions } from '@antseed/buyer-core';
import type { RoutingPreferences, RoutingServiceMetadataV1 } from '@antseed/protocol';
import type { RoutingCatalogV1 } from '../routing/catalog.js';
import type { RoutingServiceTarget } from '../routing/selection.js';

export type RouteRecommendation = {
  serviceId: string;
  provider?: string;
  peerId?: string;
  inference?: { reasoningEffort: string };
};

export type RouteCandidate = {
  serviceId: string;
  peerId: string;
  provider: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export interface RouteSelectionContext {
  preferences?: RoutingPreferences;
  preferencesSchemaHash?: string;
  routingService?: RoutingServiceTarget;
  /** Catalog returned by `getCatalog()` for this routing service, when the adapter provides one. */
  catalog?: RoutingCatalogV1;
  signal: AbortSignal;
  conversationKey: string | null;
  candidates: readonly RouteCandidate[];
  acceptRecommendations: (routes: readonly RouteRecommendation[]) => boolean;
  sendRequest: (peer: PeerInfo, request: SerializedHttpRequest, options: RequestExecutionOptions) => Promise<SerializedHttpResponse>;
}

export type RoutingUsageObservation = {
  conversationKey: string;
  requestId: string;
  peerId: string;
  provider: string;
  serviceId: string;
  inputTokens: number;
  cachedInputTokens: number;
};

export interface ModelRouterAdapter {
  routingMetadata: RoutingServiceMetadataV1;
  selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null>;
  /**
   * Optional supported-model catalog for a routing service. The plugin decides the source
   * (hardcoded, or the router's own API). Return undefined when support is unknown.
   */
  getCatalog?(target: RoutingServiceTarget, peers: PeerInfo[], signal: AbortSignal): Promise<RoutingCatalogV1 | undefined>;
  recordUsage?(observation: RoutingUsageObservation): void;
}

/**
 * Interface that buyer nodes implement for peer selection.
 *
 * The SDK discovers available sellers via DHT. Your router decides
 * which seller to send each request to based on price, latency,
 * reputation, capacity, or any custom logic.
 *
 * If you don't provide a router, the SDK uses a default that selects
 * the cheapest peer with reputation above a minimum threshold.
 */
export interface Router {
  getModelRouterAdapter?(target: RoutingServiceTarget, peers: PeerInfo[]): ModelRouterAdapter;
  routingMetadata?: RoutingServiceMetadataV1;
  defaultRoutingService?: RoutingServiceTarget;
  recordUsage?(observation: RoutingUsageObservation): void;
  autoRouteServiceId?: string;
  selectRoute?(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null>;
  getCatalog?(target: RoutingServiceTarget, peers: PeerInfo[], signal: AbortSignal): Promise<RoutingCatalogV1 | undefined>;
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
  }): void;
}
