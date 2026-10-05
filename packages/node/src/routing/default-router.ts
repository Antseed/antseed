import type { Router } from '../interfaces/buyer-router.js';
import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { normalizedModelReputationScore } from '../reputation/model-reputation.js';

export interface DefaultRouterConfig {
  minReputation?: number;  // Default: 0 (no reputation gate)
}

export class DefaultRouter implements Router {
  private _minReputation: number;
  private _latencyMap = new Map<string, number>();

  constructor(config?: DefaultRouterConfig) {
    this._minReputation = config?.minReputation ?? 0;
  }

  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const eligible = peers.filter((p) => this._effectiveReputation(p) >= this._minReputation);
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      const priceA = a.defaultInputUsdPerMillion ?? Infinity;
      const priceB = b.defaultInputUsdPerMillion ?? Infinity;
      if (priceA !== priceB) return priceA - priceB;
      // Prefer higher reputation scores (descending)
      const reputationA = this._effectiveReputation(a);
      const reputationB = this._effectiveReputation(b);
      if (reputationA !== reputationB) return reputationB - reputationA;
      const latA = this._latencyMap.get(a.peerId) ?? Infinity;
      const latB = this._latencyMap.get(b.peerId) ?? Infinity;
      return latA - latB;
    });

    return eligible[0] ?? null;
  }

  onResult(peer: PeerInfo, result: { success: boolean; latencyMs: number; tokens: number }): void {
    if (result.success) {
      const prev = this._latencyMap.get(peer.peerId) ?? result.latencyMs;
      this._latencyMap.set(peer.peerId, prev * 0.7 + result.latencyMs * 0.3);
    }
  }

  private _effectiveReputation(peer: PeerInfo): number {
    return normalizedModelReputationScore(peer) ?? 0;
  }
}
