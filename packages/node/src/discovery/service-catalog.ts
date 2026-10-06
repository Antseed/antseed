import { CODING_ONLY_SUFFIX_RE, canonicalModelKey } from '../model-identity.js';
import { parseVerifierCapabilities } from './verifier-capabilities.js';

export type CatalogServiceProtocol =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'openai-images'
  | 'typesafe-systemone';

export type CatalogServiceCapabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputs?: string[];
  outputs?: string[];
  reasoning?: boolean;
  toolUse?: boolean;
  structuredOutput?: boolean;
  supportedParameters?: string[];
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
  defaultInputUsdPerMillion?: number;
  defaultOutputUsdPerMillion?: number;
  defaultCachedInputUsdPerMillion?: number;
};

/** `decision`: System One models return typed answers, not text or images. */
export type NetworkServiceOfferType = 'text' | 'image' | 'decision';

export type NetworkServiceOffer = {
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
};

const VALID_PROTOCOLS = new Set<string>([
  'anthropic-messages',
  'openai-chat-completions',
  'openai-responses',
  'openai-images',
  'typesafe-systemone',
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

export function buildNetworkServiceOffers(peers: NetworkServiceCatalogPeer[]): NetworkServiceOffer[] {
  const offers: NetworkServiceOffer[] = [];
  for (const peer of peers) {
    for (const [provider, serviceIds] of announcedServicesByProvider(peer)) {
      for (const serviceId of serviceIds) {
        const protocols = peer.providerServiceApiProtocols?.[provider]?.services?.[serviceId] ?? [];
        const capabilities = peer.providerServiceCapabilities?.[provider]?.services?.[serviceId];
        const categories = peer.providerServiceCategories?.[provider]?.services?.[serviceId];
        const protocol = resolveServiceProtocol(protocols, provider);
        const type: NetworkServiceOfferType = protocol === 'typesafe-systemone'
          ? 'decision'
          : protocol === 'openai-images' || capabilities?.outputs?.includes('image')
            ? 'image'
            : 'text';
        const pricing = resolvePricing(peer, provider, serviceId);
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
          ...(pricing.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: pricing.inputUsdPerMillion } : {}),
          ...(pricing.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: pricing.outputUsdPerMillion } : {}),
          ...(pricing.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
          ...resolveImagePriceRange(peer, provider, serviceId),
        });
      }
    }
  }
  return offers;
}

function comparableOfferPrice(offer: NetworkServiceOffer): number {
  if (offer.type === 'image') return offer.minImageUsdPerImage ?? Number.POSITIVE_INFINITY;
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
