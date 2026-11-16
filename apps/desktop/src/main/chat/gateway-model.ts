/**
 * The chat's view of the gateway: which protocol to speak to a model, the
 * model list the picker shows, and the pi-ai model definition pointed at the
 * gateway with its API key. The chat talks to the gateway like any external
 * API — base URL, bearer key, `/v1/models` — with no peer routing of its own.
 */

import type { ChatModel, ChatServiceProtocol } from '../../shared/chat-gateway-types.js';
import type { Model } from '@mariozechner/pi-ai';
import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import type { GatewayEndpoint } from '../gateway/service.js';
import { gatewayRequestHeaders } from '../gateway/request-headers.js';

/** pi-ai provider id for gateway models; never sent on the wire. */
export const GATEWAY_PROVIDER_ID = 'antseed-gateway';

export type { ChatServiceProtocol };

/** One row of the chat model picker: a gateway model id, not a peer offer. */
export type { ChatModel };


export type GatewayModelOptions = {
  modelId: string;
  endpoint: GatewayEndpoint;
  protocol: ChatServiceProtocol;
  supportsImages: boolean;
  contextWindow?: number;
  /** The desktop chat, sent as its session id so the buyer keeps chats apart (two can open the same way). */
  conversationId?: string;
};

/** The desktop chat's session header (the buyer's `x-<tool>-session-id` convention). */
export const DESKTOP_SESSION_HEADER = 'x-vpr-session-id';

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
export function makeGatewayModel({ modelId, endpoint, protocol, supportsImages, contextWindow, conversationId }: GatewayModelOptions): GatewayChatModel {
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
    headers: { ...gatewayRequestHeaders(endpoint), ...(conversationId ? { [DESKTOP_SESSION_HEADER]: conversationId } : {}) },
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
