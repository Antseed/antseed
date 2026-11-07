/**
 * The chat's view of the gateway: which protocol to speak to a model, the
 * model list the picker shows, and the pi-ai model definition pointed at the
 * gateway with its API key. The chat talks to the gateway like any external
 * API — base URL, bearer key, `/v1/models` — with no peer routing of its own.
 */

import type { ChatModel, ChatServiceProtocol } from '../../shared/chat-gateway-types.js';
import { compareDefaultModels } from '../../shared/chat-model-ranking.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from '@mariozechner/pi-ai';
import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status';
import type { GatewayEndpoint } from '../gateway/service.js';
import type { GatewayModelEntry } from '../gateway/models.js';

/** pi-ai provider id for gateway models; never sent on the wire. */
export const GATEWAY_PROVIDER_ID = 'antseed-gateway';

export type { ChatServiceProtocol };

/** One row of the chat model picker: a gateway model id, not a peer offer. */
export type { ChatModel };

export const CHAT_SYSTEM_PROMPT_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT';
export const CHAT_SYSTEM_PROMPT_FILE_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT_FILE';

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
  const coverage = record(entry['capability_coverage']);
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
    toolUse: Number(coverage['tool_use'] ?? 0) > 0 || peers.some((peer) => record(peer['capabilities'])['toolUse'] === true),
    reasoning: Number(coverage['reasoning'] ?? 0) > 0 || peers.some((peer) => record(peer['capabilities'])['reasoning'] === true),
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

export type GatewayModelOptions = {
  modelId: string;
  endpoint: GatewayEndpoint;
  protocol: ChatServiceProtocol;
  supportsImages: boolean;
  contextWindow?: number;
};

type GatewayChatModel =
  | Model<'openai-completions'>
  | Model<'openai-responses'>
  | Model<'anthropic-messages'>;

/**
 * pi-ai model definition aimed at the gateway. The key goes in as the runtime
 * API key (`authStorage.setRuntimeApiKey(GATEWAY_PROVIDER_ID, …)`) and as an
 * explicit bearer header: the Anthropic SDK otherwise only sends `x-api-key`,
 * which the gateway does not accept.
 */
export function makeGatewayModel({ modelId, endpoint, protocol, supportsImages, contextWindow }: GatewayModelOptions): GatewayChatModel {
  // The OpenAI SDK appends /responses or /chat/completions to the base URL;
  // the Anthropic SDK appends /v1/messages itself.
  const baseUrl = protocol === 'anthropic-messages' ? endpoint.origin : `${endpoint.origin}/v1`;
  const base = {
    id: modelId,
    name: modelId,
    provider: GATEWAY_PROVIDER_ID,
    baseUrl,
    reasoning: true,
    input: (supportsImages ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindow ?? ANTSEED_MODEL_CONTEXT_WINDOW,
    maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
    headers: { authorization: `Bearer ${endpoint.apiKey}` },
  };

  if (protocol === 'openai-chat-completions') {
    return {
      ...base,
      api: 'openai-completions' as const,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: 'max_tokens' as const,
        supportsStrictMode: false,
      },
    };
  }
  if (protocol === 'openai-responses') {
    return { ...base, api: 'openai-responses' as const };
  }
  return { ...base, api: 'anthropic-messages' as const };
}

export function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** User system-prompt override: env text, env file, then `buyer.chatSystemPrompt` in the config. */
export async function resolveSystemPrompt(configPath: string): Promise<string | undefined> {
  const fromEnv = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_ENV]);
  if (fromEnv) return fromEnv;

  const promptPath = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_FILE_ENV]);
  if (promptPath) {
    try {
      const normalized = normalizePromptText(await readFile(path.resolve(promptPath), 'utf8'));
      if (normalized) return normalized;
    } catch {
      // Ignore invalid prompt files and continue to the config fallback.
    }
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { buyer?: { chatSystemPrompt?: unknown } };
    return normalizePromptText(parsed.buyer?.chatSystemPrompt);
  } catch {
    return undefined;
  }
}
