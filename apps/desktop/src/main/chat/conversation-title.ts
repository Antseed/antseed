/**
 * Conversation titles: the cheap local fallback, and the model-generated
 * title we ask the routed service for after the first exchange.
 */

import type { Message } from '@mariozechner/pi-ai';
import type { GatewayEndpoint } from '../gateway/service.js';
import type { ChatServiceProtocol } from './gateway-model.js';
import { gatewayRequestHeaders } from '../gateway/request-headers.js';

export function sanitizeGeneratedConversationTitle(value: unknown): string | null {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/^```(?:text)?/i, '')
    .replace(/```$/i, '')
    .replace(/^Title:\s*/i, '')
    .replace(/^['\"]|['\"]$/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  return cleaned.slice(0, 60).trim();
}

export function titleTextFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    const data = block as Record<string, unknown>;
    return typeof data.text === 'string'
      ? data.text
      : typeof data.output_text === 'string'
        ? data.output_text
        : '';
  }).join('');
}

export function getMessageText(message: Message | null | undefined): string {
  if (!message) return '';
  return titleTextFromContent((message as unknown as Record<string, unknown>).content).trim();
}

export function legacyFallbackTitleForMessage(messageText: string): string {
  const normalized = messageText.trim();
  if (!normalized) return 'New conversation';
  return normalized.slice(0, 60) + (normalized.length > 60 ? '...' : '');
}

export function shouldGenerateConversationTitleForSession(sessionName: string | undefined, firstUserMessage: string): boolean {
  const current = sessionName?.trim() ?? '';
  if (!current || current === 'Conversation' || current === 'New Chat' || current === 'New conversation') {
    return true;
  }
  const legacyFallback = legacyFallbackTitleForMessage(firstUserMessage);
  return current === legacyFallback;
}

export function extractGeneratedTitleFromResponse(protocol: ChatServiceProtocol, body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const data = body as Record<string, unknown>;

  if (protocol === 'openai-chat-completions') {
    const choice = Array.isArray(data.choices) ? data.choices[0] as Record<string, unknown> | undefined : undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    return sanitizeGeneratedConversationTitle(
      titleTextFromContent(message?.content)
        || titleTextFromContent(choice?.text),
    );
  }

  if (protocol === 'openai-responses') {
    if (typeof data.output_text === 'string') {
      return sanitizeGeneratedConversationTitle(data.output_text);
    }
    const output = Array.isArray(data.output) ? data.output : [];
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const content = Array.isArray((item as Record<string, unknown>).content)
        ? (item as Record<string, unknown>).content as Record<string, unknown>[]
        : [];
      for (const block of content) {
        const title = sanitizeGeneratedConversationTitle(titleTextFromContent([block]));
        if (title) return title;
      }
    }
    return null;
  }

  const content = Array.isArray(data.content) ? data.content : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const title = sanitizeGeneratedConversationTitle((block as Record<string, unknown>).text);
    if (title) return title;
  }
  return null;
}

export function extractGeneratedTitleFromResponsesSse(text: string): string | null {
  let eventName = '';
  let dataLines: string[] = [];
  let streamedText = '';

  const flushEvent = (): string | null => {
    if (dataLines.length === 0) return null;
    const dataText = dataLines.join('\n').trim();
    const event = eventName;
    eventName = '';
    dataLines = [];
    if (!dataText || dataText === '[DONE]') return null;

    try {
      const data = JSON.parse(dataText) as Record<string, unknown>;
      const type = typeof data.type === 'string' ? data.type : event;
      if (type === 'response.output_text.delta' && typeof data.delta === 'string') {
        streamedText += data.delta;
        return null;
      }
      if (type === 'response.output_text.done' && typeof data.text === 'string') {
        return sanitizeGeneratedConversationTitle(data.text);
      }
      if (type === 'response.completed') {
        return extractGeneratedTitleFromResponse('openai-responses', data.response ?? data);
      }
    } catch {
      // Ignore malformed SSE records and fall back to accumulated deltas.
    }
    return null;
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line === '') {
      const title = flushEvent();
      if (title) return title;
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  return flushEvent() ?? sanitizeGeneratedConversationTitle(streamedText);
}

export async function generateConversationTitleWithModel({
  endpoint,
  serviceId,
  protocol,
  userMessage,
}: {
  endpoint: GatewayEndpoint;
  serviceId: string;
  protocol: ChatServiceProtocol;
  userMessage: string;
}): Promise<string | null> {
  const titleInstructions = 'You write short, accurate chat titles.';
  const prompt = [
    'Create a concise title for this chat conversation.',
    'Rules: 3-6 words, no quotes, no period, title case only if natural, return only the title.',
    '',
    `User message:\n${userMessage.slice(0, 4000)}`,
  ].join('\n');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...gatewayRequestHeaders(endpoint),
  };

  let url = `${endpoint.origin}/v1/messages`;
  let body: Record<string, unknown> = {
    model: serviceId,
    max_tokens: 64,
    system: titleInstructions,
    messages: [{ role: 'user', content: prompt }],
  };

  if (protocol === 'openai-chat-completions') {
    url = `${endpoint.origin}/v1/chat/completions`;
    body = {
      model: serviceId,
      max_tokens: 256,
      messages: [
        { role: 'system', content: `${titleInstructions} Return only the title.` },
        { role: 'user', content: prompt },
      ],
    };
  } else if (protocol === 'openai-responses') {
    url = `${endpoint.origin}/v1/responses`;
    headers.accept = 'text/event-stream';
    body = {
      model: serviceId,
      max_output_tokens: 64,
      instructions: titleInstructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      stream: true,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) return null;

  if (protocol === 'openai-responses') {
    return extractGeneratedTitleFromResponsesSse(await response.text());
  }

  try {
    return extractGeneratedTitleFromResponse(protocol, await response.json());
  } catch {
    return null;
  }
}
