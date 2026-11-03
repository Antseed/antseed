import type { PeerMetadata, ProviderAnnouncement, ServiceCapabilities } from "../../peer-metadata.js";
import { AUDIO_SPEECH_PROTOCOLS } from "../../peer-metadata.js";
import { pruneServiceMaps } from "./prune-service-maps.js";

/** Billing units that metadata before v15 cannot carry. */
const SPEECH_UNITS = new Set<string>(["input_characters"]);
const SPEECH_PROTOCOLS = new Set<string>(AUDIO_SPEECH_PROTOCOLS);

/** Per-service maps that must not mention a service missing from `services`. */
const PER_SERVICE_KEYS = [
  "servicePricing",
  "serviceCategories",
  "serviceApiProtocols",
  "serviceUnitBillingModels",
  "serviceCapabilities",
  "serviceHealth",
  "servicePerformance",
] as const satisfies ReadonlyArray<keyof ProviderAnnouncement>;

function usesSpeech(provider: ProviderAnnouncement, service: string): boolean {
  if (provider.serviceApiProtocols?.[service]?.some((protocol) => SPEECH_PROTOCOLS.has(protocol))) return true;
  const models = provider.serviceUnitBillingModels?.[service];
  for (const [protocol, model] of Object.entries(models ?? {})) {
    if (SPEECH_PROTOCOLS.has(protocol)) return true;
    if (model?.components.some((component) => SPEECH_UNITS.has(component.unit))) return true;
  }
  return false;
}

function withoutSpeechCapabilities(capabilities: Record<string, ServiceCapabilities>): Record<string, ServiceCapabilities> {
  const out: Record<string, ServiceCapabilities> = {};
  for (const [service, caps] of Object.entries(capabilities)) {
    if (caps.speech === undefined) {
      out[service] = caps;
      continue;
    }
    const { speech: _speech, ...rest } = caps;
    if (Object.keys(rest).length > 0) out[service] = rest;
  }
  return out;
}

/** Services a provider describes in any per-service map. */
function describedServices(provider: ProviderAnnouncement): string[] {
  const services = new Set<string>();
  for (const key of PER_SERVICE_KEYS) {
    for (const service of Object.keys(provider[key] ?? {})) services.add(service);
  }
  return [...services];
}

/**
 * Builds a document older buyers accept from the newest metadata. Buyers before
 * v15 reject a whole peer whose metadata names a protocol or billing unit they
 * don't know, so speech services are left out of v14 and older documents
 * (along with `capabilities.speech`), and the rest of the seller stays visible.
 * A provider whose services are all speech services is left out entirely,
 * because an empty service list means "any service". A wildcard provider
 * (`services: []`) keeps its wildcard; only its speech map entries go.
 */
export function withoutSpeechServices(latest: PeerMetadata): PeerMetadata {
  const providers: ProviderAnnouncement[] = [];
  for (const provider of latest.providers) {
    const wildcard = provider.services.length === 0;
    const candidates = wildcard ? describedServices(provider) : provider.services;
    const speech = new Set(candidates.filter((service) => usesSpeech(provider, service)));
    const next: ProviderAnnouncement = { ...provider };
    if (speech.size > 0) {
      if (!wildcard) {
        const services = provider.services.filter((service) => !speech.has(service));
        if (services.length === 0) continue;
        next.services = services;
      }
      pruneServiceMaps(next, provider, speech, PER_SERVICE_KEYS);
    }
    if (next.serviceCapabilities) {
      const capabilities = withoutSpeechCapabilities(next.serviceCapabilities);
      if (Object.keys(capabilities).length > 0) next.serviceCapabilities = capabilities;
      else delete next.serviceCapabilities;
    }
    providers.push(next);
  }
  return { ...latest, providers };
}
