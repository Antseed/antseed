import type { PeerMetadata, ProviderAnnouncement, ServiceCapabilities } from "../../peer-metadata.js";
import { AUDIO_SPEECH_PROTOCOLS } from "../../peer-metadata.js";

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

/**
 * Builds a document older buyers accept from the newest metadata. Buyers before
 * v15 reject a whole peer whose metadata names a protocol or billing unit they
 * don't know, so speech services are left out of v14 and older documents
 * (along with `capabilities.speech`), and the rest of the seller stays visible.
 * A provider whose services are all speech services is left out entirely,
 * because an empty service list means "any service".
 */
export function withoutSpeechServices(latest: PeerMetadata): PeerMetadata {
  const providers: ProviderAnnouncement[] = [];
  for (const provider of latest.providers) {
    const speech = new Set(provider.services.filter((service) => usesSpeech(provider, service)));
    const next: ProviderAnnouncement = { ...provider };
    if (speech.size > 0) {
      const services = provider.services.filter((service) => !speech.has(service));
      if (services.length === 0) continue;
      next.services = services;
      for (const key of PER_SERVICE_KEYS) {
        const map = provider[key] as Record<string, unknown> | undefined;
        if (!map) continue;
        const kept = Object.fromEntries(Object.entries(map).filter(([service]) => !speech.has(service)));
        if (Object.keys(kept).length > 0) (next as unknown as Record<string, unknown>)[key] = kept;
        else delete next[key];
      }
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
