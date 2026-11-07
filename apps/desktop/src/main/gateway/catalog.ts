/**
 * What a `/v1/models` entry means for the desktop: which protocol to speak, what
 * the picker shows, and which models to default connected apps to. Shared by the
 * chat and the connected apps.
 */
import type { ChatModel, ChatServiceProtocol } from '../../shared/chat-gateway-types.js';
import { compareDefaultModels } from '../../shared/chat-model-ranking.js';
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status';
import type { GatewayModelEntry } from './models.js';

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

function normalizeProtocol(value: string): string {
  const protocol = value.trim().toLowerCase();
  return protocol === 'openai-completions' ? 'openai-chat-completions' : protocol;
}

/** Every protocol the gateway reports for an entry: `supported_protocols`, then the peers' own. */
export function entryProtocols(entry: GatewayModelEntry): string[] {
  const reported = [
    ...strings(entry['supported_protocols']),
    ...records(entry['peers']).flatMap((peer) => [
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
export function resolveEntryProtocol(entry: GatewayModelEntry): ChatServiceProtocol | null {
  const protocols = entryProtocols(entry);
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
function entrySupportsImages(entry: GatewayModelEntry): boolean {
  const architecture = entry['architecture'];
  if (architecture && typeof architecture === 'object'
    && strings((architecture as Record<string, unknown>)['input_modalities']).includes('image')) {
    return true;
  }
  const peers = records(entry['peers']);
  return peers.length > 0 && peers.every(peerTakesImages);
}

function peerTakesImages(peer: Record<string, unknown>): boolean {
  const capabilities = peer['capabilities'];
  const inputs = capabilities && typeof capabilities === 'object'
    ? strings((capabilities as Record<string, unknown>)['inputs'])
    : [];
  return inputs.includes('image') || strings(peer['categories']).includes('multimodal');
}

function imageInputSellerIds(entry: GatewayModelEntry): string[] {
  return records(entry['peers'])
    .filter(peerTakesImages)
    .flatMap((peer) => (typeof peer['peerId'] === 'string' ? [peer['peerId'].toLowerCase().replace(/^0x/, '')] : []));
}

function entryContextWindow(entry: GatewayModelEntry): number | undefined {
  for (const key of ['context_length', 'context_window']) {
    const value = Number(entry[key]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The offer summary the picker shows, worked out like the gateway console's chat. */
function entryOfferSummary(entry: GatewayModelEntry): Pick<ChatModel, 'sellers' | 'free' | 'minImageUsd' | 'freeSellerId' | 'freeForStakers' | 'tee' | 'toolUse' | 'reasoning' | 'inputUsdPerMillion' | 'outputUsdPerMillion'> {
  const peers = records(entry['peers']);
  const declared = record(entry['capabilities']);
  // Coverage only counts sellers that reported at all, including those reporting false.
  const anyPeerDeclares = (capability: 'toolUse' | 'reasoning'): boolean => peers.some((peer) => record(peer['capabilities'])[capability] === true);
  const cheapest = (field: string): number | null => {
    const values = peers.map((peer) => finiteNumber(peer[field])).filter((value): value is number => value !== null && value >= 0);
    return values.length > 0 ? Math.min(...values) : null;
  };
  const stakersOnly = (peer: Record<string, unknown>): boolean => record(record(peer['freeTier'])['base'])['stakersOnly'] === true;
  // An image model's token prices are $0 too: it charges per image.
  const chargesPerImage = (peer: Record<string, unknown>): boolean => (finiteNumber(peer['minImageUsdPerImage']) ?? 0) > 0;
  const freeSeller = peers.find((peer) => peer['inputUsdPerMillion'] === 0 && peer['outputUsdPerMillion'] === 0 && !stakersOnly(peer) && !chargesPerImage(peer));
  return {
    sellers: peers.length,
    free: freeSeller !== undefined,
    minImageUsd: cheapest('minImageUsdPerImage'),
    freeSellerId: typeof freeSeller?.['peerId'] === 'string' ? freeSeller['peerId'] : null,
    freeForStakers: peers.some(stakersOnly),
    tee: peers.some((peer) => strings(peer['advertisedVerifierIds']).includes(TEE_VERIFIER_ID)),
    toolUse: declared['tool_use'] === true || anyPeerDeclares('toolUse'),
    reasoning: declared['reasoning'] === true || anyPeerDeclares('reasoning'),
    inputUsdPerMillion: cheapest('inputUsdPerMillion'),
    outputUsdPerMillion: cheapest('outputUsdPerMillion'),
  };
}

export function toChatModel(entry: GatewayModelEntry): ChatModel {
  const protocols = entryProtocols(entry);
  const type = entryType(entry, protocols);
  const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim() : entry.id;
  const contextWindow = entryContextWindow(entry);
  const imageSellers = imageInputSellerIds(entry);
  return {
    id: entry.id,
    label: name,
    type,
    protocol: type === 'text' ? resolveEntryProtocol(entry) : null,
    supportsImages: entrySupportsImages(entry),
    ...(imageSellers.length > 0 ? { imageInputSellerIds: imageSellers } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...entryOfferSummary(entry),
  };
}

/**
 * Picker rows: one per gateway model id (duplicates keep the first entry),
 * ordered like the gateway console's chat — models that can use tools first,
 * then the most sellers, then by name.
 */
export function toChatModels(entries: GatewayModelEntry[]): ChatModel[] {
  const seen = new Set<string>();
  const models: ChatModel[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(toChatModel(entry));
  }
  return models.sort((left, right) => Number(right.toolUse) - Number(left.toolUse)
    || right.sellers - left.sellers
    || left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
}

/**
 * Models worth defaulting connected apps to, best first: free for everyone
 * (an app's background calls must not need funds), then able to use tools,
 * then the most sellers.
 */
export function recommendAppModels(models: ChatModel[]): ChatModel[] {
  return models
    .filter((model) => model.type === 'text' && model.protocol !== null)
    .sort(compareDefaultModels);
}
