/**
 * What a `/v1/models` entry means for the desktop: which protocol to speak, what
 * the picker shows, and which models to default connected apps to. Shared by the
 * chat and the connected apps.
 */
import type { ChatModel, ChatServiceProtocol } from '../../shared/chat-gateway-types.js';
import { isFreeOffer } from '../../shared/offer-prices.js';
import { compareDefaultModels } from '../../shared/chat-model-ranking.js';
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status';
import { entryReasons, trustedAppEntries, type GatewayModelEntry } from './models.js';
import { finiteNumber, record } from './response-fields.js';
import { findListedModel, normalizeSellerId } from '../../shared/pinned-model.js';

export type { ChatModel };

/** Preference order when a model is served over several protocols. */
const PROTOCOL_PREFERENCE: ChatServiceProtocol[] = ['anthropic-messages', 'openai-responses', 'openai-chat-completions'];

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

/** The entry for a model id or a pinned `peer@model`: by its id, else the same model by the canonical rule (`findListedModel`). */
export function findGatewayEntry(entries: readonly GatewayModelEntry[], modelId: string | null | undefined): GatewayModelEntry | null {
  return findListedModel(entries, modelId);
}

function normalizeProtocol(value: string): string {
  const protocol = value.trim().toLowerCase();
  return protocol === 'openai-completions' ? 'openai-chat-completions' : protocol;
}

/** Every protocol the gateway reports for an entry: `supported_protocols`, then the peers' own. */
export function entryProtocols(entry: GatewayModelEntry, peers = records(entry['peers'])): string[] {
  const reported = [
    ...strings(entry['supported_protocols']),
    ...peers.flatMap((peer) => [
      ...(typeof peer['protocol'] === 'string' ? [peer['protocol']] : []),
      ...strings(peer['protocols']),
    ]),
  ];
  return [...new Set(reported.map(normalizeProtocol))];
}

/**
 * The protocol the chat uses for an entry: anthropic-messages, then
 * openai-responses, then openai-chat-completions among those reported. An
 * entry that reports none (a plain OpenAI-compatible gateway) gets
 * chat-completions; one that reports only non-chat protocols gets null.
 */
export function resolveEntryProtocol(entry: GatewayModelEntry, protocols = entryProtocols(entry)): ChatServiceProtocol | null {
  if (protocols.length === 0) return 'openai-chat-completions';
  return PROTOCOL_PREFERENCE.find((protocol) => protocols.includes(protocol)) ?? null;
}

function entryType(entry: GatewayModelEntry, protocols: string[]): string {
  const type = typeof entry['type'] === 'string' ? entry['type'].trim().toLowerCase() : '';
  if (type) return type;
  if (protocols.length > 0 && protocols.every((protocol) => protocol === 'openai-images')) return 'image';
  return 'text';
}

/**
 * Image input: the gateway's guaranteed input modalities include `image`, or
 * every peer serving the model advertises image input / the `multimodal`
 * category — the gateway may route to any of them.
 */
function entrySupportsImages(entry: GatewayModelEntry, peers: Array<Record<string, unknown>>): boolean {
  const architecture = entry['architecture'];
  if (architecture && typeof architecture === 'object'
    && strings((architecture as Record<string, unknown>)['input_modalities']).includes('image')) {
    return true;
  }
  return peers.length > 0 && peers.every(peerTakesImages);
}

function peerTakesImages(peer: Record<string, unknown>): boolean {
  const capabilities = peer['capabilities'];
  const inputs = capabilities && typeof capabilities === 'object'
    ? strings((capabilities as Record<string, unknown>)['inputs'])
    : [];
  return inputs.includes('image') || strings(peer['categories']).includes('multimodal');
}

function imageInputSellerIds(peers: Array<Record<string, unknown>>): string[] {
  return peers
    .filter(peerTakesImages)
    .flatMap((peer) => (typeof peer['peerId'] === 'string' ? [normalizeSellerId(peer['peerId'])] : []));
}

/** Each seller's price per image, for the seller picker: the route preview prices tokens only. */
function imageUsdBySeller(peers: Array<Record<string, unknown>>): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const peer of peers) {
    const price = finiteNumber(peer['minImageUsdPerImage']);
    if (typeof peer['peerId'] === 'string' && price !== null && price >= 0) prices[normalizeSellerId(peer['peerId'])] = price;
  }
  return prices;
}

/**
 * A video model's cheapest price across its sellers, as the listing prices
 * each video offer (`videoUsdPerSecond`, plus `videoUsdPerVideo` for a fixed
 * charge per video). Null when no seller lists one.
 */
export function minVideoPrice(peers: Array<Record<string, unknown>>): ChatModel['videoPrice'] | null {
  let best: { perSecondUsd: number; perVideoUsd: number } | null = null;
  for (const peer of peers) {
    const perSecondUsd = finiteNumber(peer['videoUsdPerSecond']);
    if (perSecondUsd === null || !(perSecondUsd > 0)) continue;
    const perVideoUsd = finiteNumber(peer['videoUsdPerVideo']) ?? 0;
    if (!best || perSecondUsd < best.perSecondUsd || (perSecondUsd === best.perSecondUsd && perVideoUsd < best.perVideoUsd)) {
      best = { perSecondUsd, perVideoUsd };
    }
  }
  return best;
}

function entryContextWindow(entry: GatewayModelEntry): number | undefined {
  for (const key of ['context_length', 'context_window']) {
    const value = Number(entry[key]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

/** The offer summary the picker shows, worked out like the gateway console's chat. */
function entryOfferSummary(entry: GatewayModelEntry, peers: Array<Record<string, unknown>>, options: CatalogOptions = {}): Pick<ChatModel, 'sellers' | 'free' | 'minImageUsd' | 'freeSellerId' | 'freeForStakers' | 'stakersOnlyFreeSellerIds' | 'tee' | 'teeEndToEnd' | 'toolUse' | 'reasoning' | 'inputUsdPerMillion' | 'outputUsdPerMillion'> {
  const declared = record(entry['capabilities']);
  // Coverage only counts sellers that reported at all, including those reporting false.
  const anyPeerDeclares = (capability: 'toolUse'): boolean => peers.some((peer) => record(peer['capabilities'])[capability] === true);
  const stakersOnly = (peer: Record<string, unknown>): boolean => record(record(peer['freeTier'])['base'])['stakersOnly'] === true;
  // Free means every token price is $0, cached input included, as the buyer decides it.
  const zeroPriced = (peer: Record<string, unknown>): boolean => isFreeOffer({
    inputUsdPerMillion: finiteNumber(peer['inputUsdPerMillion']),
    outputUsdPerMillion: finiteNumber(peer['outputUsdPerMillion']),
    cachedInputUsdPerMillion: finiteNumber(peer['cachedInputUsdPerMillion']),
  });
  const isStakersOnlyFree = (peer: Record<string, unknown>): boolean => stakersOnly(peer) && zeroPriced(peer);
  const stakersOnlyFree = peers.filter(isStakersOnlyFree);
  // What anyone can pay: a stakers-only $0 offer would show a paid model as free.
  const openPeers = peers.filter((peer) => !isStakersOnlyFree(peer));
  const pricedPeers = openPeers.length > 0 ? openPeers : peers;
  const cheapest = (field: string, from = peers): number | null => {
    const values = from.map((peer) => finiteNumber(peer[field])).filter((value): value is number => value !== null && value >= 0);
    return values.length > 0 ? Math.min(...values) : null;
  };
  // An image model's token prices are $0 too: it charges per image.
  const chargesPerImage = (peer: Record<string, unknown>): boolean => (finiteNumber(peer['minImageUsdPerImage']) ?? 0) > 0;
  // Advertising the TEE verifier is only a claim: a buyer that checked the
  // seller's attestation reports how far it reaches (`teeScope`).
  const isTee = (peer: Record<string, unknown>): boolean => strings(peer['advertisedVerifierIds']).includes(TEE_VERIFIER_ID)
    && (peer['teeScope'] === 'end-to-end' || peer['teeScope'] === 'seller-node');
  // Under TEE-only routing (Private) a free seller outside a TEE never answers,
  // so it can't make the model free.
  const freeSeller = peers.find((peer) => zeroPriced(peer) && !stakersOnly(peer) && !chargesPerImage(peer) && (!options.teeOnly || isTee(peer)));
  const stakersOnlyFreeSellerIds = stakersOnlyFree.flatMap((peer) => typeof peer['peerId'] === 'string'
    ? [normalizeSellerId(peer['peerId'])]
    : []);
  return {
    sellers: peers.length,
    free: freeSeller !== undefined,
    minImageUsd: cheapest('minImageUsdPerImage'),
    freeSellerId: typeof freeSeller?.['peerId'] === 'string' ? freeSeller['peerId'] : null,
    freeForStakers: peers.some(stakersOnly),
    ...(stakersOnlyFreeSellerIds.length > 0 ? { stakersOnlyFreeSellerIds } : {}),
    tee: peers.some(isTee),
    // Only the seller's own TEE is checked unless its model provider is attested too.
    ...(peers.some((peer) => isTee(peer) && peer['teeScope'] === 'end-to-end') ? { teeEndToEnd: true } : {}),
    toolUse: declared['tool_use'] === true || anyPeerDeclares('toolUse'),
    reasoning: entryReasons(entry),
    inputUsdPerMillion: cheapest('inputUsdPerMillion', pricedPeers),
    outputUsdPerMillion: cheapest('outputUsdPerMillion', pricedPeers),
  };
}

/** The entry's retail reference prices; only for a text model, whose sellers charge per token too. */
function entryReferencePrice(entry: GatewayModelEntry, type: string): ChatModel['referencePrice'] | undefined {
  if (type !== 'text') return undefined;
  const reference = record(entry['reference_price']);
  const price = (field: string): number | null => {
    const value = finiteNumber(reference[field]);
    return value !== null && value > 0 ? value : null;
  };
  const inputUsdPerMillion = price('input_usd_per_million');
  const outputUsdPerMillion = price('output_usd_per_million');
  return inputUsdPerMillion === null && outputUsdPerMillion === null ? undefined : { inputUsdPerMillion, outputUsdPerMillion };
}

/** How the listing will be routed: TEE-only routing (Private) changes what counts as free. */
export type CatalogOptions = { teeOnly?: boolean };

export function toChatModel(entry: GatewayModelEntry, options: CatalogOptions = {}): ChatModel {
  // Normalized once; every projection below reads the same peer list.
  const peers = records(entry['peers']);
  const protocols = entryProtocols(entry, peers);
  const type = entryType(entry, protocols);
  const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim() : entry.id;
  const contextWindow = entryContextWindow(entry);
  const imageSellers = imageInputSellerIds(peers);
  const imagePrices = type === 'image' ? imageUsdBySeller(peers) : {};
  const videoPrice = type === 'video' ? minVideoPrice(peers) : null;
  const referencePrice = entryReferencePrice(entry, type);
  return {
    id: entry.id,
    label: name,
    type,
    protocol: type === 'text' ? resolveEntryProtocol(entry, protocols) : null,
    supportsImages: entrySupportsImages(entry, peers),
    ...(imageSellers.length > 0 ? { imageInputSellerIds: imageSellers } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(Object.keys(imagePrices).length > 0 ? { imageUsdBySeller: imagePrices } : {}),
    ...(videoPrice ? { videoPrice } : {}),
    ...entryOfferSummary(entry, peers, options),
    ...(referencePrice ? { referencePrice } : {}),
  };
}

/**
 * Picker rows: one per gateway model id (duplicates keep the first entry),
 * ordered like the gateway console's chat — models that can use tools first,
 * then the most sellers, then by name.
 */
export function toChatModels(entries: GatewayModelEntry[], options: CatalogOptions = {}): ChatModel[] {
  const seen = new Set<string>();
  const models: ChatModel[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(toChatModel(entry, options));
  }
  return models.sort((left, right) => Number(right.toolUse) - Number(left.toolUse)
    || right.sellers - left.sellers
    || left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
}

/**
 * The chat's rows: every model, with `lowTrust` on those no trusted seller
 * serves (`trustedAppEntries`, judged per type), so the chat lists the apps'
 * set (`listedModels`). The rest stay in the list for a chat or saved default
 * already on one.
 */
export function toTrustedChatModels(entries: GatewayModelEntry[], options: CatalogOptions = {}): ChatModel[] {
  const trusted = new Set(trustedAppEntries(entries).map((entry) => entry.id));
  return toChatModels(entries, options).map((model) => (trusted.has(model.id) ? model : { ...model, lowTrust: true }));
}

/**
 * Models worth defaulting connected apps to, best first: free for everyone (an
 * app's background calls must not need funds), served by a trusted seller
 * before a low-trust one, then able to use tools, then the most sellers.
 */
export function recommendAppModels(models: ChatModel[]): ChatModel[] {
  return models
    .filter((model) => model.type === 'text' && model.protocol !== null)
    .sort(compareDefaultModels);
}
