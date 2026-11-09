import { CODING_ONLY_SUFFIX_RE, canonicalModelKey } from '../model-identity.js';
import { parseVerifierCapabilities } from './verifier-capabilities.js';
import { AUDIO_SPEECH_PROTOCOLS, DATA_SERVICE_PROTOCOLS, NATIVE_VIDEO_PROTOCOLS, isAudioSpeechProtocol, isDataServiceProtocol, isNativeVideoProtocol, isRoutingProtocol, type AudioSpeechProtocol, type DataServiceProtocol, type NativeVideoProtocol } from '@antseed/protocol/service-api';
import { isServiceHealthFailing, providerServiceHealthFor, providerServicePerformanceFor, type ServiceHealth, type ServicePerformance, type SpeechOptions, type VideoOptions } from '@antseed/protocol/peer-metadata';
import type { ProviderServiceHealthMatrixEntry, ProviderServicePerformanceMatrixEntry } from '@antseed/protocol/peer-pricing';
import { componentMatchesAttributes } from '@antseed/protocol/billing';

export type CatalogServiceProtocol =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'openai-images'
  | 'typesafe-systemone'
  | NativeVideoProtocol
  | AudioSpeechProtocol
  | DataServiceProtocol;

export type CatalogServiceCapabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputs?: string[];
  outputs?: string[];
  reasoning?: boolean;
  toolUse?: boolean;
  structuredOutput?: boolean;
  supportedParameters?: string[];
  video?: VideoOptions;
  speech?: SpeechOptions;
};

export type NetworkServiceCatalogPeer = {
  peerId: string;
  capabilities?: string[];
  displayName?: string;
  providers?: string[];
  services?: string[];
  reputationScore?: number;
  onChainReputationScore?: number | null;
  providerServiceApiProtocols?: Record<string, { services: Record<string, string[]> }>;
  providerServiceCapabilities?: Record<string, { services: Record<string, CatalogServiceCapabilities> }>;
  providerServiceUnitBillingModels?: Record<string, {
    services: Record<string, Partial<Record<string, {
      version: number;
      components: Array<{ unit: string; priceUsd: number; match?: Record<string, string> }>;
    }>>>;
  }>;
  providerPricing?: Record<string, {
    defaults?: {
      inputUsdPerMillion?: number;
      outputUsdPerMillion?: number;
      cachedInputUsdPerMillion?: number;
      input?: number;
      output?: number;
    };
    services?: Record<string, {
      inputUsdPerMillion?: number;
      outputUsdPerMillion?: number;
      cachedInputUsdPerMillion?: number;
      input?: number;
      output?: number;
    }>;
  }>;
  providerServiceCategories?: Record<string, { services: Record<string, string[]> }>;
  providerServiceHealth?: Record<string, ProviderServiceHealthMatrixEntry>;
  providerServicePerformance?: Record<string, ProviderServicePerformanceMatrixEntry>;
  defaultInputUsdPerMillion?: number;
  defaultOutputUsdPerMillion?: number;
  defaultCachedInputUsdPerMillion?: number;
};

/**
 * `decision`: System One models return typed answers, not text or images.
 * `speech`: text-to-speech models return an audio file.
 * `data`: a seller's own HTTP API, described by its OpenAPI document and billed per completed request.
 */
export type NetworkServiceOfferType = 'text' | 'image' | 'decision' | 'video' | 'speech' | 'data';

export type NetworkServiceOffer = {
  unitBillingModels?: NonNullable<NetworkServiceCatalogPeer['providerServiceUnitBillingModels']>[string]['services'][string];
  advertisedVerifierIds?: string[];
  serviceId: string;
  provider: string;
  protocols: string[];
  protocol: CatalogServiceProtocol | null;
  type: NetworkServiceOfferType;
  capabilities?: CatalogServiceCapabilities;
  categories?: string[];
  peerId: string;
  displayName?: string;
  reputationScore?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  minImageUsdPerImage?: number;
  maxImageUsdPerImage?: number;
  /** The seller's self health check result for this service, when announced. */
  health?: ServiceHealth;
  /** How the service served the seller's buyers in the last hour, when announced. */
  performance?: ServicePerformance;
};

export type BuildNetworkServiceOffersOptions = {
  /**
   * Keep services the seller's own health check announces as failing.
   * Catalogs and routing leave them out; diagnostics may want them.
   */
  includeFailing?: boolean;
};

const VALID_PROTOCOLS = new Set<string>([
  'anthropic-messages',
  'openai-chat-completions',
  'openai-responses',
  'openai-images',
  'typesafe-systemone',
  ...NATIVE_VIDEO_PROTOCOLS,
  ...AUDIO_SPEECH_PROTOCOLS,
  ...DATA_SERVICE_PROTOCOLS,
]);

export function inferServiceProtocol(provider: string): Exclude<CatalogServiceProtocol, 'openai-images'> | null {
  if (provider === 'openai-responses') return 'openai-responses';
  if (provider === 'openai' || provider === 'openrouter' || provider === 'local-llm') {
    return 'openai-chat-completions';
  }
  if (provider === 'anthropic' || provider === 'claude-code' || provider === 'claude-oauth') {
    return 'anthropic-messages';
  }
  if (provider === 'typesafe') return 'typesafe-systemone';
  return null;
}

export function resolveServiceProtocol(protocols: string[], provider: string): CatalogServiceProtocol | null {
  if (protocols.includes('openai-images')) return 'openai-images';
  const announced = protocols.find((protocol) => VALID_PROTOCOLS.has(protocol)) as CatalogServiceProtocol | undefined;
  return announced ?? inferServiceProtocol(provider);
}

function announcedServicesByProvider(peer: NetworkServiceCatalogPeer): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  const matrices: Array<Record<string, { services?: Record<string, unknown> }> | undefined> = [
    peer.providerPricing,
    peer.providerServiceApiProtocols,
    peer.providerServiceCategories,
    peer.providerServiceUnitBillingModels,
    peer.providerServiceCapabilities,
  ];
  for (const matrix of matrices) {
    for (const [provider, entry] of Object.entries(matrix ?? {})) {
      const announcedServiceIds = Object.keys(entry.services ?? {}).filter((serviceId) => serviceId.trim());
      if (announcedServiceIds.length === 0) continue;
      const serviceIds = byProvider.get(provider) ?? new Set<string>();
      byProvider.set(provider, serviceIds);
      for (const serviceId of announcedServiceIds) serviceIds.add(serviceId);
    }
  }

  if (byProvider.size === 0 && peer.services?.length && peer.providers?.length) {
    const serviceIds = peer.services.filter((serviceId) => serviceId.trim());
    for (const provider of peer.providers) {
      if (provider.trim()) byProvider.set(provider, new Set(serviceIds));
    }
  } else if (byProvider.size === 0 && peer.providers?.length) {
    for (const provider of peer.providers) byProvider.set(provider, new Set([provider]));
  }
  return byProvider;
}

function resolvePricing(peer: NetworkServiceCatalogPeer, provider: string, serviceId: string) {
  const providerPricing = peer.providerPricing?.[provider];
  const servicePricing = providerPricing?.services?.[serviceId];
  const defaults = providerPricing?.defaults;
  const inputUsdPerMillion = servicePricing?.inputUsdPerMillion
    ?? servicePricing?.input
    ?? defaults?.inputUsdPerMillion
    ?? defaults?.input
    ?? peer.defaultInputUsdPerMillion;
  const outputUsdPerMillion = servicePricing?.outputUsdPerMillion
    ?? servicePricing?.output
    ?? defaults?.outputUsdPerMillion
    ?? defaults?.output
    ?? peer.defaultOutputUsdPerMillion;
  const cachedInputUsdPerMillion = servicePricing?.cachedInputUsdPerMillion
    ?? defaults?.cachedInputUsdPerMillion
    ?? peer.defaultCachedInputUsdPerMillion;
  return { inputUsdPerMillion, outputUsdPerMillion, cachedInputUsdPerMillion };
}

function resolveImagePriceRange(peer: NetworkServiceCatalogPeer, provider: string, serviceId: string) {
  const billingByProtocol = peer.providerServiceUnitBillingModels?.[provider]?.services?.[serviceId];
  const prices = Object.values(billingByProtocol ?? {}).flatMap((model) =>
    (model?.components ?? [])
      .filter((component) => component.unit === 'output_images' && Number.isFinite(component.priceUsd) && component.priceUsd >= 0)
      .map((component) => component.priceUsd),
  );
  return prices.length > 0
    ? { minImageUsdPerImage: Math.min(...prices), maxImageUsdPerImage: Math.max(...prices) }
    : {};
}

/** What an offer is, by its protocol first and then, for image models served elsewhere, its outputs. */
function serviceOfferType(
  protocol: CatalogServiceProtocol | null,
  capabilities: CatalogServiceCapabilities | undefined,
): NetworkServiceOfferType {
  if (isNativeVideoProtocol(protocol)) return 'video';
  if (isAudioSpeechProtocol(protocol)) return 'speech';
  if (isDataServiceProtocol(protocol)) return 'data';
  if (protocol === 'typesafe-systemone') return 'decision';
  if (protocol === 'openai-images' || capabilities?.outputs?.includes('image')) return 'image';
  return 'text';
}

export function buildNetworkServiceOffers(
  peers: NetworkServiceCatalogPeer[],
  options: BuildNetworkServiceOffersOptions = {},
): NetworkServiceOffer[] {
  const offers: NetworkServiceOffer[] = [];
  for (const peer of peers) {
    for (const [provider, serviceIds] of announcedServicesByProvider(peer)) {
      for (const serviceId of serviceIds) {
        const health = providerServiceHealthFor(peer.providerServiceHealth, provider, serviceId);
        if (isServiceHealthFailing(health) && !options.includeFailing) continue;
        const performance = providerServicePerformanceFor(peer.providerServicePerformance, provider, serviceId);
        const protocols = peer.providerServiceApiProtocols?.[provider]?.services?.[serviceId] ?? [];
        const billingModels = peer.providerServiceUnitBillingModels?.[provider]?.services?.[serviceId];
        // Routers are listed apart (see routing-services). Completed requests alone do not mark
        // a router: data services bill the same unit.
        const billsCompletedRequests = Object.values(billingModels ?? {}).some(model => (model?.components ?? []).some(component => component.unit === 'completed_requests'));
        if (protocols.some(isRoutingProtocol) || (billsCompletedRequests && !protocols.some(isDataServiceProtocol))) continue;
        const capabilities = peer.providerServiceCapabilities?.[provider]?.services?.[serviceId];
        const categories = peer.providerServiceCategories?.[provider]?.services?.[serviceId];
        const protocol = resolveServiceProtocol(protocols, provider);
        const type = serviceOfferType(protocol, capabilities);
        const pricing = resolvePricing(peer, provider, serviceId);
        const unitPriced = type === 'video' || type === 'speech' || type === 'data';
        offers.push({
          advertisedVerifierIds: parseVerifierCapabilities(peer.capabilities).supported,
          serviceId,
          provider,
          protocols,
          protocol,
          type,
          ...(capabilities ? { capabilities } : {}),
          ...(categories?.length ? { categories } : {}),
          peerId: peer.peerId,
          ...(peer.displayName ? { displayName: peer.displayName } : {}),
          ...(peer.reputationScore !== undefined ? { reputationScore: peer.reputationScore } : {}),
          ...(!unitPriced && pricing.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: pricing.inputUsdPerMillion } : {}),
          ...(!unitPriced && pricing.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: pricing.outputUsdPerMillion } : {}),
          ...(!unitPriced && pricing.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
          ...(unitPriced ? { unitBillingModels: peer.providerServiceUnitBillingModels?.[provider]?.services[serviceId] } : {}),
          ...resolveImagePriceRange(peer, provider, serviceId),
          ...(health ? { health } : {}),
          ...(performance ? { performance } : {}),
        });
      }
    }
  }
  return offers;
}

/**
 * USD per input character a speech offer bills: speech billing matches
 * components against `{ model: <service> }` and charges every one that
 * applies, so their prices add up. 0 for a billing model with no components
 * (free); null when the offer is not speech or publishes no character price.
 */
export function speechOfferUsdPerCharacter(offer: NetworkServiceOffer): number | null {
  if (offer.type !== 'speech') return null;
  const model = offer.protocol ? offer.unitBillingModels?.[offer.protocol] : undefined;
  // A billing model with no components charges nothing: the offer is free.
  if (model && model.components.length === 0) return 0;
  const attributes = { model: offer.serviceId };
  const applicable = (model?.components ?? []).filter((component) =>
    component.unit === 'input_characters'
    && componentMatchesAttributes(component, attributes)
    && Number.isFinite(component.priceUsd)
    && component.priceUsd >= 0);
  return applicable.length > 0
    ? applicable.reduce((sum, component) => sum + component.priceUsd, 0)
    : null;
}

/**
 * USD per completed request an offer bills on `openapi-data`, also when the service
 * answers on chat too. 0 for a billing model with no components (free); null when the
 * offer publishes no data price.
 */
export function dataOfferUsdPerRequest(offer: NetworkServiceOffer): number | null {
  const model = offer.unitBillingModels?.['openapi-data'];
  if (!model) return null;
  if (model && model.components.length === 0) return 0;
  const applicable = (model?.components ?? []).filter((component) =>
    component.unit === 'completed_requests' && Number.isFinite(component.priceUsd) && component.priceUsd >= 0);
  return applicable.length > 0
    ? applicable.reduce((sum, component) => sum + component.priceUsd, 0)
    : null;
}

function comparableOfferPrice(offer: NetworkServiceOffer): number {
  if (offer.type === 'image') return offer.minImageUsdPerImage ?? Number.POSITIVE_INFINITY;
  if (offer.type === 'speech') return speechOfferUsdPerCharacter(offer) ?? Number.POSITIVE_INFINITY;
  if (offer.type === 'data') return dataOfferUsdPerRequest(offer) ?? Number.POSITIVE_INFINITY;
  if (offer.inputUsdPerMillion === undefined || offer.outputUsdPerMillion === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return offer.inputUsdPerMillion + offer.outputUsdPerMillion;
}

export function compareNetworkServiceOfferPrice(a: NetworkServiceOffer, b: NetworkServiceOffer): number {
  return comparableOfferPrice(a) - comparableOfferPrice(b)
    || a.serviceId.localeCompare(b.serviceId)
    || a.provider.localeCompare(b.provider);
}

export function selectLowestPricedNetworkServiceOffer(offers: NetworkServiceOffer[]): NetworkServiceOffer | null {
  return [...offers].sort(compareNetworkServiceOfferPrice)[0] ?? null;
}

/** One cheapest advertised route per peer and canonical model, across providers and aliases. */
export function selectLowestPricedCanonicalOffers(offers: NetworkServiceOffer[]): NetworkServiceOffer[] {
  const grouped = new Map<string, NetworkServiceOffer[]>();
  for (const offer of offers) {
    const modelKey = canonicalModelKey(offer.serviceId);
    if (!modelKey) continue;
    const key = `${offer.peerId}\u0000${modelKey}`;
    const candidates = grouped.get(key) ?? [];
    candidates.push(offer);
    grouped.set(key, candidates);
  }
  return [...grouped.values()]
    .map((candidates) => {
      const unrestricted = candidates.filter((offer) => !CODING_ONLY_SUFFIX_RE.test(offer.serviceId));
      return selectLowestPricedNetworkServiceOffer(unrestricted.length > 0 ? unrestricted : candidates);
    })
    .filter((offer): offer is NetworkServiceOffer => offer !== null);
}
