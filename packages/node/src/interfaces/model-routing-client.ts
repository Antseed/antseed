import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { RequestExecutionOptions } from '@antseed/buyer-core';
import type { RoutingServiceTarget } from '../routing/selection.js';

export type RouteRecommendation = {
  serviceId: string;
  provider?: string;
  peerId?: string;
  /** IRP `reasoning_effort` suggested by the router for this candidate. */
  reasoningEffort?: string;
};

export type RouteCandidate = {
  serviceId: string;
  peerId: string;
  provider: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  /** The router's name for this model (from its models list); defaults to `serviceId`. */
  routerModel?: string;
};

type SendRequest = (peer: PeerInfo, request: SerializedHttpRequest, options: RequestExecutionOptions) => Promise<SerializedHttpResponse>;

export interface RoutingModelsContext {
  signal: AbortSignal;
  /** Free control-plane request to the selected routing peer; no payment is attached. */
  sendRequest: (peer: PeerInfo, request: SerializedHttpRequest) => Promise<SerializedHttpResponse>;
}

export interface RouteSelectionContext {
  /** IRP `cost_quality_tradeoff`; omitted means the router's default (5). */
  costQualityTradeoff?: number;
  routingService: RoutingServiceTarget;
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
