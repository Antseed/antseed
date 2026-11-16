export type NetworkLifecycleStatus = {
  proxyReachable: boolean;
  dhtNodeCount: number | null;
  peerCount: number | null;
};

export type NetworkLifecycleObservation = {
  runtimeStarted: boolean;
  dhtRoutingNodeCount: number | null;
  discoveredPeerCount: number;
  discoveredServiceCount: number;
};

function nonNegativeCount(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/**
 * Converts structured buyer status into privacy-safe lifecycle milestones.
 * Cached peer state is used only for older runtimes without `peerCount`.
 */
export function deriveNetworkLifecycleObservation(
  status: NetworkLifecycleStatus | null,
  cachedOnlinePeerCount: number,
  cachedServiceCount: number,
): NetworkLifecycleObservation {
  if (!status?.proxyReachable) {
    return {
      runtimeStarted: false,
      dhtRoutingNodeCount: null,
      discoveredPeerCount: 0,
      discoveredServiceCount: 0,
    };
  }

  const dhtNodeCount = nonNegativeCount(status.dhtNodeCount);
  const reportedPeerCount = nonNegativeCount(status.peerCount);
  const fallbackPeerCount = nonNegativeCount(cachedOnlinePeerCount) ?? 0;
  const discoveredPeerCount = reportedPeerCount ?? fallbackPeerCount;

  return {
    runtimeStarted: true,
    dhtRoutingNodeCount: dhtNodeCount !== null && dhtNodeCount > 0 ? dhtNodeCount : null,
    discoveredPeerCount,
    discoveredServiceCount: discoveredPeerCount > 0
      ? nonNegativeCount(cachedServiceCount) ?? 0
      : 0,
  };
}
