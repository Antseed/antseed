import type { PeerMetadata, ProviderAnnouncement, ServiceCapabilities } from "../peer-metadata.js";
import { pruneServiceMaps } from "./versions/prune-service-maps.js";

/**
 * The names a metadata version's documents may use. Buyers reject a whole
 * peer whose metadata names a protocol, billing unit or capability option
 * their version does not know, so a seller serving an older version leaves
 * out every service that needs one (see {@link withinVocabulary}).
 */
export interface MetadataVocabulary {
  /** Service API protocols (`serviceApiProtocols`, unit billing model keys). */
  readonly protocols: ReadonlySet<string>;
  /** Unit billing units (`serviceUnitBillingModels` components). */
  readonly units: ReadonlySet<string>;
  /** Service capability options (`serviceCapabilities.<service>.<option>`). */
  readonly capabilityOptions: ReadonlySet<keyof ServiceCapabilities>;
  /** Unit billing match keys (`serviceUnitBillingModels` component `match`). */
  readonly matchKeys: ReadonlySet<string>;
  /** Most components one unit billing model may carry. */
  readonly maxBillingComponents: number;
}

/** Vocabulary entries that are name sets. */
export type MetadataVocabularyNameKind = "protocols" | "units" | "capabilityOptions" | "matchKeys";

export interface MetadataVocabularyAdditions {
  protocols?: readonly string[];
  units?: readonly string[];
  capabilityOptions?: readonly (keyof ServiceCapabilities)[];
  matchKeys?: readonly string[];
  maxBillingComponents?: number;
}

/** What v10-v14 know: everything defined before speech. */
export const BASE_METADATA_VOCABULARY: MetadataVocabulary = {
  protocols: new Set([
    "anthropic-messages",
    "openai-chat-completions",
    "openai-completions",
    "openai-responses",
    "openai-images",
    "typesafe-systemone",
    "venice-video",
    "fal-video",
    "irp-suggest",
  ]),
  units: new Set(["output_images", "completed_requests", "video_generations", "video_seconds"]),
  capabilityOptions: new Set<keyof ServiceCapabilities>([
    "video",
    "contextWindow",
    "maxOutputTokens",
    "inputs",
    "outputs",
    "reasoning",
    "toolUse",
    "structuredOutput",
    "supportedParameters",
  ]),
  matchKeys: new Set(["model", "size", "quality", "resolution"]),
  maxBillingComponents: 8,
};

/** `base` plus the names a newer version adds. */
export function extendVocabulary(base: MetadataVocabulary, added: MetadataVocabularyAdditions): MetadataVocabulary {
  return {
    protocols: new Set([...base.protocols, ...(added.protocols ?? [])]),
    units: new Set([...base.units, ...(added.units ?? [])]),
    capabilityOptions: new Set([...base.capabilityOptions, ...(added.capabilityOptions ?? [])]),
    matchKeys: new Set([...base.matchKeys, ...(added.matchKeys ?? [])]),
    maxBillingComponents: added.maxBillingComponents ?? base.maxBillingComponents,
  };
}

/** Per-service maps that must not mention a service the document leaves out. */
const PER_SERVICE_KEYS = [
  "servicePricing",
  "serviceCategories",
  "serviceApiProtocols",
  "serviceUnitBillingModels",
  "serviceCapabilities",
  "serviceHealth",
  "servicePerformance",
] as const satisfies ReadonlyArray<keyof ProviderAnnouncement>;

/**
 * Whether `service` needs a protocol, billing unit or match key outside
 * `vocabulary`, or more billing components than it allows.
 */
function needsUnknownName(provider: ProviderAnnouncement, service: string, vocabulary: MetadataVocabulary): boolean {
  if (provider.serviceApiProtocols?.[service]?.some((protocol) => !vocabulary.protocols.has(protocol))) return true;
  for (const [protocol, model] of Object.entries(provider.serviceUnitBillingModels?.[service] ?? {})) {
    if (!vocabulary.protocols.has(protocol)) return true;
    if (!model) continue;
    if (model.components.length > vocabulary.maxBillingComponents) return true;
    if (model.components.some((component) => !vocabulary.units.has(component.unit))) return true;
    if (model.components.some((component) => Object.keys(component.match ?? {}).some((key) => !vocabulary.matchKeys.has(key)))) return true;
  }
  return false;
}

/** Services a provider describes in any per-service map. */
function describedServices(provider: ProviderAnnouncement): string[] {
  const services = new Set<string>();
  for (const key of PER_SERVICE_KEYS) {
    for (const service of Object.keys(provider[key] ?? {})) services.add(service);
  }
  return [...services];
}

function withinCapabilityOptions(
  capabilities: Record<string, ServiceCapabilities>,
  vocabulary: MetadataVocabulary,
): Record<string, ServiceCapabilities> {
  const out: Record<string, ServiceCapabilities> = {};
  for (const [service, caps] of Object.entries(capabilities)) {
    const kept = Object.fromEntries(
      Object.entries(caps).filter(([option]) => vocabulary.capabilityOptions.has(option as keyof ServiceCapabilities)),
    ) as ServiceCapabilities;
    if (Object.keys(kept).length > 0) out[service] = kept;
  }
  return out;
}

/**
 * `latest` restricted to what `vocabulary` can say. A service whose protocol
 * or billing unit the version does not know is left out, with every
 * per-service entry for it, and capability options the version does not know
 * are dropped; the rest of the seller stays visible. A provider whose listed
 * services are all left out is dropped, because an empty service list means
 * "any service"; a wildcard provider (`services: []`) keeps its wildcard and
 * loses only those entries.
 */
export function withinVocabulary(latest: PeerMetadata, vocabulary: MetadataVocabulary): PeerMetadata {
  const providers: ProviderAnnouncement[] = [];
  for (const provider of latest.providers) {
    const wildcard = provider.services.length === 0;
    const candidates = wildcard ? describedServices(provider) : provider.services;
    const unknown = new Set(candidates.filter((service) => needsUnknownName(provider, service, vocabulary)));
    const next: ProviderAnnouncement = { ...provider };
    if (unknown.size > 0) {
      if (!wildcard) {
        const services = provider.services.filter((service) => !unknown.has(service));
        if (services.length === 0) continue;
        next.services = services;
      }
      pruneServiceMaps(next, provider, unknown, PER_SERVICE_KEYS);
    }
    if (next.serviceCapabilities) {
      const capabilities = withinCapabilityOptions(next.serviceCapabilities, vocabulary);
      if (Object.keys(capabilities).length > 0) next.serviceCapabilities = capabilities;
      else delete next.serviceCapabilities;
    }
    providers.push(next);
  }
  return { ...latest, providers };
}
