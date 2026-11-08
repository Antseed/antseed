import { createHmac } from "node:crypto";
import { inferProviderDefaultServiceApiProtocols } from "@antseed/api-adapter";
import type { ServiceApiProtocol } from "../types/service-api.js";

/**
 * The provider ID a seller announces for one of its providers: 12 lowercase
 * hex characters keyed by the seller's private key, so buyers can route to the
 * provider without learning which plugin (and so which upstream) serves it.
 * Providers with the same name get the same ID, as several upstreams of one
 * provider share a name. Stable for a seller identity.
 */
export function announcedProviderId(privateKey: Uint8Array, providerName: string): string {
  return createHmac("sha256", privateKey)
    .update(`antseed-provider-id:${providerName.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
}

/** The name buyers see for a provider: its ID when `useIds`, else its own name. */
export function announcedProviderName(privateKey: Uint8Array, providerName: string, useIds: boolean): string {
  return useIds ? announcedProviderId(privateKey, providerName) : providerName;
}

/**
 * A provider's service protocols with the ones buyers used to infer from its
 * name filled in, for services that announce none: with the name replaced by
 * an ID, buyers can no longer infer them.
 */
export function withDefaultServiceApiProtocols(
  providerName: string,
  services: readonly string[],
  serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
): Record<string, ServiceApiProtocol[]> | undefined {
  const defaults = inferProviderDefaultServiceApiProtocols(providerName);
  if (defaults.length === 0) return serviceApiProtocols;
  const filled = { ...serviceApiProtocols };
  for (const service of services) {
    if (!filled[service]?.length) filled[service] = [...defaults];
  }
  return filled;
}
