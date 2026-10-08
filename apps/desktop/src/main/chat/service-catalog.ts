import type {
  CatalogServiceCapabilities,
  CatalogServiceProtocol,
  NativeVideoProtocol,
  NetworkServiceCatalogPeer,
  PeerInfo,
} from '@antseed/node';
import { normalizeAdvertisedVerifierIds } from '@antseed/node/verifier-capabilities';
import {
  buildNetworkServiceOffers,
  normalizedModelReputationScore,
  preferredModelDisplayName,
} from '@antseed/node';

export type ChatServiceProtocol = Exclude<CatalogServiceProtocol, 'openai-images' | 'typesafe-systemone' | NativeVideoProtocol>;
export type { CatalogServiceCapabilities, CatalogServiceProtocol };

export type ChatServiceCatalogEntry = {
  advertisedVerifierIds?: string[];
  id: string;
  label: string;
  provider: string;
  protocol: CatalogServiceProtocol;
  capabilities?: CatalogServiceCapabilities;
  count: number;
  peerId?: string;
  peerLabel?: string;
  effectiveReputationScore?: number | null;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  minImageUsdPerImage?: number;
  maxImageUsdPerImage?: number;
  categories?: string[];
  description?: string;
};

type NetworkModelsPeerOffer = {
  advertisedVerifierIds?: unknown;
  peerId?: unknown;
  displayName?: unknown;
  provider?: unknown;
  serviceId?: unknown;
  protocol?: unknown;
  capabilities?: unknown;
  categories?: unknown;
  effectiveReputationScore?: unknown;
  inputUsdPerMillion?: unknown;
  outputUsdPerMillion?: unknown;
  cachedInputUsdPerMillion?: unknown;
  minImageUsdPerImage?: unknown;
  maxImageUsdPerImage?: unknown;
};

type NetworkModelsEntry = {
  name?: unknown;
  peers?: unknown;
};

const CATALOG_SERVICE_PROTOCOLS = new Set<string>([
  'anthropic-messages', 'openai-chat-completions', 'openai-responses', 'openai-images',
]);

function isCatalogServiceProtocol(value: unknown): value is CatalogServiceProtocol {
  return typeof value === 'string' && CATALOG_SERVICE_PROTOCOLS.has(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeCapabilities(value: unknown): CatalogServiceCapabilities | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const capabilities: CatalogServiceCapabilities = {};
  const contextWindow = positiveInteger(raw.contextWindow);
  if (contextWindow !== undefined) capabilities.contextWindow = contextWindow;
  const maxOutputTokens = positiveInteger(raw.maxOutputTokens);
  if (maxOutputTokens !== undefined) capabilities.maxOutputTokens = maxOutputTokens;
  for (const key of ['inputs', 'outputs', 'supportedParameters'] as const) {
    const values = stringArray(raw[key]);
    if (values.length > 0) capabilities[key] = values;
  }
  if (typeof raw.reasoning === 'boolean') capabilities.reasoning = raw.reasoning;
  if (typeof raw.toolUse === 'boolean') capabilities.toolUse = raw.toolUse;
  if (typeof raw.structuredOutput === 'boolean') capabilities.structuredOutput = raw.structuredOutput;
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

/**
 * Flattens the buyer proxy's canonical `/v1/models` response into the exact
 * peer offers consumed by Desktop. Model identity, deduplication, pricing,
 * capabilities, reputation penalties, and peer order all come from the proxy.
 */
export function buildChatServiceCatalogFromNetworkModels(payload: unknown): ChatServiceCatalogEntry[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.data)) return [];

  const entries: ChatServiceCatalogEntry[] = [];
  for (const rawModel of root.data) {
    const model: NetworkModelsEntry | null = asRecord(rawModel);
    if (!model || !Array.isArray(model.peers)) continue;
    const label = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : null;
    for (const rawOffer of model.peers) {
      const offer: NetworkModelsPeerOffer | null = asRecord(rawOffer);
      if (!offer) continue;
      const peerId = typeof offer.peerId === 'string' ? offer.peerId.trim() : '';
      const provider = typeof offer.provider === 'string' ? offer.provider.trim() : '';
      const serviceId = typeof offer.serviceId === 'string' ? offer.serviceId.trim() : '';
      const protocol = offer.protocol;
      if (!peerId || !provider || !serviceId || !isCatalogServiceProtocol(protocol)) continue;

      const displayName = typeof offer.displayName === 'string' ? offer.displayName.trim() : '';
      const capabilities = normalizeCapabilities(offer.capabilities);
      const categories = stringArray(offer.categories);
      const effectiveReputationScore = nonNegativeNumber(offer.effectiveReputationScore);
      const inputUsdPerMillion = nonNegativeNumber(offer.inputUsdPerMillion);
      const outputUsdPerMillion = nonNegativeNumber(offer.outputUsdPerMillion);
      const cachedInputUsdPerMillion = nonNegativeNumber(offer.cachedInputUsdPerMillion);
      const minImageUsdPerImage = nonNegativeNumber(offer.minImageUsdPerImage);
      const maxImageUsdPerImage = nonNegativeNumber(offer.maxImageUsdPerImage);

      entries.push({
        advertisedVerifierIds: normalizeAdvertisedVerifierIds(offer.advertisedVerifierIds),
        id: serviceId,
        label: label ?? serviceId,
        provider,
        protocol,
        ...(capabilities ? { capabilities } : {}),
        count: 1,
        peerId,
        peerLabel: displayName ? `${displayName} (${peerId.slice(0, 8)})` : `${peerId.slice(0, 12)}...`,
        effectiveReputationScore: effectiveReputationScore ?? null,
        ...(inputUsdPerMillion !== undefined ? { inputUsdPerMillion } : {}),
        ...(outputUsdPerMillion !== undefined ? { outputUsdPerMillion } : {}),
        ...(cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion } : {}),
        ...(minImageUsdPerImage !== undefined ? { minImageUsdPerImage } : {}),
        ...(maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage } : {}),
        ...(categories.length > 0 ? { categories } : {}),
      });
    }
  }
  return entries;
}

/** Build a startup fallback from the persisted peer cache without applying a
 * freshness cutoff. The live `/v1/models` response replaces this snapshot as
 * soon as discovery produces current offers. */
export function buildChatServiceCatalogFromPersistedPeers(payload: unknown): ChatServiceCatalogEntry[] {
  const root = asRecord(payload);
  const peers = root && Array.isArray(root.discoveredPeers)
    ? root.discoveredPeers.filter((peer): peer is NetworkServiceCatalogPeer => {
      const record = asRecord(peer);
      return record !== null
        && typeof record.peerId === 'string'
        && Array.isArray(record.providers);
    })
    : [];
  const peersById = new Map(peers.map((peer) => [peer.peerId, peer]));
  return buildNetworkServiceOffers(peers).flatMap((offer) => {
    if (!offer.protocol) return [];
    const peer = peersById.get(offer.peerId);
    const effectiveReputationScore = peer ? normalizedModelReputationScore(peer as PeerInfo) : null;
    return [{
      advertisedVerifierIds: offer.advertisedVerifierIds,
      id: offer.serviceId,
      label: preferredModelDisplayName(offer.serviceId),
      provider: offer.provider,
      protocol: offer.protocol,
      ...(offer.capabilities ? { capabilities: offer.capabilities } : {}),
      count: 1,
      peerId: offer.peerId,
      peerLabel: offer.displayName
        ? `${offer.displayName} (${offer.peerId.slice(0, 8)})`
        : `${offer.peerId.slice(0, 12)}...`,
      effectiveReputationScore,
      ...(offer.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: offer.inputUsdPerMillion } : {}),
      ...(offer.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: offer.outputUsdPerMillion } : {}),
      ...(offer.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: offer.cachedInputUsdPerMillion } : {}),
      ...(offer.minImageUsdPerImage !== undefined ? { minImageUsdPerImage: offer.minImageUsdPerImage } : {}),
      ...(offer.maxImageUsdPerImage !== undefined ? { maxImageUsdPerImage: offer.maxImageUsdPerImage } : {}),
      ...(offer.categories?.length ? { categories: offer.categories } : {}),
    }];
  });
}

export function sortChatServiceCatalogEntries(entries: ChatServiceCatalogEntry[]): ChatServiceCatalogEntry[] {
  const protocolRank = (protocol: CatalogServiceProtocol): number => (
    protocol === 'anthropic-messages'
      ? 0
      : protocol === 'openai-chat-completions'
        ? 1
        : protocol === 'openai-responses'
          ? 2
          : 3
  );

  return entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (protocolRank(a.protocol) !== protocolRank(b.protocol)) {
      return protocolRank(a.protocol) - protocolRank(b.protocol);
    }
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}
