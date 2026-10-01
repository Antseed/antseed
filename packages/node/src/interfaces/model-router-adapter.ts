import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { RequestExecutionOptions } from '@antseed/buyer-core';
import type { RoutingDescribeResponseV1, RoutingPreferences } from '@antseed/protocol';
import type { RoutingServiceTarget } from '../routing/selection.js';

export type RouteRecommendation = {
  serviceId: string;
  provider?: string;
  peerId?: string;
};

export type RouteCandidate = {
  serviceId: string;
  peerId: string;
  provider: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
};

type SendRequest = (peer: PeerInfo, request: SerializedHttpRequest, options: RequestExecutionOptions) => Promise<SerializedHttpResponse>;

export interface RoutingDescribeContext {
  signal: AbortSignal;
  /** Free control-plane request to the selected routing peer; no payment is attached. */
  sendRequest: (peer: PeerInfo, request: SerializedHttpRequest) => Promise<SerializedHttpResponse>;
}

export interface RouteSelectionContext {
  preferences: RoutingPreferences;
  routingService: RoutingServiceTarget;
  /** The router's current description; candidates are already limited to its supported models. */
  description: RoutingDescribeResponseV1;
  signal: AbortSignal;
  conversationKey: string | null;
  candidates: readonly RouteCandidate[];
  acceptRecommendations: (routes: readonly RouteRecommendation[]) => boolean;
  sendRequest: SendRequest;
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

/** Thrown when the router rejects a request because its description changed; the host refreshes and retries once. */
export class RoutingDescriptionChangedError extends Error {
  constructor(message = 'Router description changed') {
    super(message);
    this.name = 'RoutingDescriptionChangedError';
  }
}

export interface ModelRouterAdapter {
  /** Fetch the router's supported models and preference schema from the routing peer. */
  describe(target: RoutingServiceTarget, peers: PeerInfo[], context: RoutingDescribeContext): Promise<RoutingDescribeResponseV1>;
  selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null>;
  recordUsage?(observation: RoutingUsageObservation): void;
}
