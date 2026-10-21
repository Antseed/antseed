/**
 * Wiring between the chat agent and the local buyer proxy: the pi-ai model
 * definition pointed at the proxy, port discovery, and the system prompt.
 */

import { createConnection } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from '@mariozechner/pi-ai';
import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import { LOCALHOST, LOCALHOST_URL } from '../constants.js';
import { PROXY_PROVIDER_ID } from './provider-hint.js';
import type { ChatServiceProtocol } from './service-catalog.js';

export const DEFAULT_PROXY_PORT = 8377;
export const DEFAULT_CHAT_SERVICE = 'claude-sonnet-4-20250514';
export const PROXY_RUNTIME_API_KEY = 'antseed-local';

export const CHAT_SYSTEM_PROMPT_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT';
export const CHAT_SYSTEM_PROMPT_FILE_ENV = 'ANTSEED_CHAT_SYSTEM_PROMPT_FILE';

export function makeProxyService(
  serviceId: string,
  port: number,
  protocol: ChatServiceProtocol = 'anthropic-messages',
  preferredPeerId?: string | null,
  spendingAuth?: string | null,
  supportsMultimodal: boolean = false,
  routeMode: 'auto' | 'pinned' = 'auto',
  conversationId?: string | null,
): Model<any> {
  // The buyer proxy resolves the route plan from the pinned peer + the
  // service ID in the request body, so we don't need to send
  // `x-antseed-provider`. Stripping it keeps internal labels (e.g. the
  // local `antseed-proxy` SDK key) out of the wire entirely.
  const headers: Record<string, string> = {};
  if (preferredPeerId) {
    headers[routeMode === 'pinned' ? 'x-antseed-pin-peer' : 'x-antseed-prefer-peer'] = preferredPeerId;
  }
  // The buyer proxy derives the conversation identity generically from the
  // `x-<tool>-session-id` header name, so this yields tool slug "vpr" and
  // conversation key `vpr:<id>`. Existing chats stored under the legacy
  // `antstation:` key re-establish peer affinity on their next message.
  if (conversationId) headers['x-vpr-session-id'] = conversationId;
  if (spendingAuth) headers['x-antseed-spending-auth'] = spendingAuth;

  // The OpenAI SDK appends API paths (e.g. /responses, /chat/completions)
  // to baseUrl, so include /v1 to match the buyer proxy's expected paths.
  const needsV1 = protocol === 'openai-responses' || protocol === 'openai-chat-completions';
  // Image input is only enabled when the selected service advertises the
  // `multimodal` category tag. Otherwise we declare the model as text-only so
  // pi-ai strips image blocks before hitting the wire (upstream providers
  // return errors like "Multimodal is not supported for model" for text-only
  // LLMs even when the provider catalog lists vision-capable siblings).
  const inputModalities: ('text' | 'image')[] = supportsMultimodal ? ['text', 'image'] : ['text'];
  const base = {
    id: serviceId,
    name: serviceId,
    provider: PROXY_PROVIDER_ID,
    baseUrl: needsV1 ? `${LOCALHOST_URL}:${port}/v1` : `${LOCALHOST_URL}:${port}`,
    reasoning: true,
    input: inputModalities,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW,
    maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
    headers,
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
    return {
      ...base,
      api: 'openai-responses' as const,
    };
  }

  return { ...base, api: 'anthropic-messages' as const };
}

export async function fetchProxyConversationRoute(
  port: number,
  conversationId: string,
): Promise<{ peerId: string; service: string; router: string | null } | null> {
  try {
    const id = encodeURIComponent(`vpr:${conversationId}`);
    const response = await fetch(`${LOCALHOST_URL}:${port}/_antseed/conversations/${id}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { conversation?: { lastModel?: unknown; lastRouter?: unknown } };
    const lastModel = typeof payload.conversation?.lastModel === 'string'
      ? payload.conversation.lastModel.trim()
      : '';
    const separator = lastModel.indexOf('@');
    if (separator <= 0 || separator === lastModel.length - 1) return null;
    return {
      peerId: lastModel.slice(0, separator),
      service: lastModel.slice(separator + 1),
      // The routing service that chose this model, when one did.
      router: typeof payload.conversation?.lastRouter === 'string' && payload.conversation.lastRouter.trim()
        ? payload.conversation.lastRouter.trim()
        : null,
    };
  } catch {
    return null;
  }
}

export async function isPortReachable(port: number, timeoutMs = 700): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: LOCALHOST, port: Math.floor(port) });

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function resolveProxyPort(configPath: string): Promise<number> {
  try {
    const raw = await stat(configPath);
    if (!raw.isFile()) {
      return DEFAULT_PROXY_PORT;
    }
  } catch {
    return DEFAULT_PROXY_PORT;
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      buyer?: { proxyPort?: unknown };
    };
    const configured = Number(parsed.buyer?.proxyPort);
    if (Number.isFinite(configured) && configured > 0 && configured <= 65535) {
      return Math.floor(configured);
    }
  } catch {
    return DEFAULT_PROXY_PORT;
  }

  return DEFAULT_PROXY_PORT;
}

export function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function resolveSystemPrompt(configPath: string): Promise<string | undefined> {
  const fromEnv = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_ENV]);
  if (fromEnv) {
    return fromEnv;
  }

  const promptPath = normalizePromptText(process.env[CHAT_SYSTEM_PROMPT_FILE_ENV]);
  if (promptPath) {
    try {
      const fileText = await readFile(path.resolve(promptPath), 'utf8');
      const normalized = normalizePromptText(fileText);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Ignore invalid prompt files and continue to config fallback.
    }
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      buyer?: { chatSystemPrompt?: unknown };
    };
    return normalizePromptText(parsed.buyer?.chatSystemPrompt);
  } catch {
    return undefined;
  }
}

/**
 * Amount the payment card should ask for: the reserve this seller's session
 * would lock (buyer-capped), falling back to the seller's suggestion.
 */
export function paymentRequiredAmount(body: Record<string, unknown> | null | undefined, fallback: string): string {
  const required = body?.requiredReserve;
  return typeof required === 'string' && /^\d+$/.test(required) && required !== '0' ? required : fallback;
}

export function normalizePaymentBody(body: Record<string, unknown>): Record<string, unknown> {
  if (body.peerId) return body;
  const inner = body.error;
  if (typeof inner === 'object' && inner !== null) {
    const innerObj = inner as Record<string, unknown>;
    if (innerObj.peerId) {
      return { ...body, peerId: innerObj.peerId };
    }
  }
  return body;
}
