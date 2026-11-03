import type { PeerMetadata, ProviderAnnouncement } from "../../peer-metadata.js";
import { defineMetadataVersion, insertBefore, type MetadataLayout } from "../define-version.js";
import { providerLoadField } from "../fields/provider-basics.js";
import { serviceCapabilitiesField } from "../fields/service-capabilities.js";
import { V11_LAYOUT } from "./v11.js";

/** v12: per-service capability hints and u16 service entry counts. */
export const V12_LAYOUT: MetadataLayout = {
  providerFields: insertBefore(V11_LAYOUT.providerFields, providerLoadField, serviceCapabilitiesField),
  peerFields: V11_LAYOUT.peerFields,
};

/** Per-service maps that must not mention a service missing from `services`. */
const PER_SERVICE_KEYS = [
  "servicePricing",
  "serviceCategories",
  "serviceApiProtocols",
  "serviceUnitBillingModels",
  "serviceCapabilities",
] as const satisfies ReadonlyArray<keyof ProviderAnnouncement>;

/**
 * v12 has no service health, and v12 buyers would route to anything listed.
 * Failing services are left out instead, which is how sellers withdrew them
 * before v13. A provider whose services are all failing is left out
 * entirely, because an empty service list means "any service".
 */
function withoutFailingServices(latest: PeerMetadata): PeerMetadata {
  const providers: ProviderAnnouncement[] = [];
  for (const provider of latest.providers) {
    const health = provider.serviceHealth;
    if (!health) {
      providers.push(provider);
      continue;
    }
    const failing = new Set(Object.keys(health).filter((service) => health[service]?.status === "failing"));
    if (failing.size === 0) {
      providers.push(provider);
      continue;
    }
    if (provider.services.length === 0) {
      // Wildcard providers cannot drop single services.
      providers.push(provider);
      continue;
    }
    const services = provider.services.filter((service) => !failing.has(service));
    if (services.length === 0) continue;
    const next: ProviderAnnouncement = { ...provider, services };
    for (const key of PER_SERVICE_KEYS) {
      const map = provider[key] as Record<string, unknown> | undefined;
      if (!map) continue;
      const kept = Object.fromEntries(Object.entries(map).filter(([service]) => !failing.has(service)));
      if (Object.keys(kept).length > 0) (next as unknown as Record<string, unknown>)[key] = kept;
      else delete next[key];
    }
    providers.push(next);
  }
  return { ...latest, providers };
}

export const metadataV12 = defineMetadataVersion({
  version: 12,
  wideServiceCounts: true,
  ...V12_LAYOUT,
  fromLatest: withoutFailingServices,
});
