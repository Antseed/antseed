import type { ServiceHealth } from '@antseed/protocol/peer-metadata';

/** The peer fields service health is read from (a PeerInfo or its persisted JSON). */
export type ServiceHealthPeer = {
  providerServiceHealth?: Record<string, { services?: Record<string, ServiceHealth> }>;
  providerPricing?: Record<string, { services?: Record<string, unknown> }>;
};

/**
 * The seller's announced self health check result for `serviceId`. With no
 * `provider`, a service several providers announce reports the healthiest
 * one: the seller can still serve it through the others.
 */
export function peerServiceHealth(peer: ServiceHealthPeer, serviceId: string, provider?: string): ServiceHealth | undefined {
  if (provider !== undefined) return peer.providerServiceHealth?.[provider]?.services?.[serviceId];
  const providers = new Set<string>();
  for (const [name, entry] of Object.entries(peer.providerPricing ?? {})) {
    if (entry.services && serviceId in entry.services) providers.add(name);
  }
  for (const [name, entry] of Object.entries(peer.providerServiceHealth ?? {})) {
    if (entry.services && serviceId in entry.services) providers.add(name);
  }
  let worst: ServiceHealth | undefined;
  for (const name of providers) {
    const health = peer.providerServiceHealth?.[name]?.services?.[serviceId];
    if (!health || health.status !== 'failing') return health;
    worst = health;
  }
  return worst;
}

/** Whether the seller's own health check says `serviceId` is failing, so buyers should not route to it. */
export function isPeerServiceFailing(peer: ServiceHealthPeer, serviceId: string, provider?: string): boolean {
  return peerServiceHealth(peer, serviceId, provider)?.status === 'failing';
}
