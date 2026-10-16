import type { AiChatMessage } from './conversation-types.js';

export const RESPONSE_ROUTE_ENTRY = 'antseed-response-route';

export function restoreResponseRoutes(messages: AiChatMessage[], entries: Array<{ type: string; customType?: string; data?: unknown }>): AiChatMessage[] {
  const routes = new Map<number, { service: string; peerId: string }>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== RESPONSE_ROUTE_ENTRY || !entry.data || typeof entry.data !== 'object') continue;
    const data = entry.data as Record<string, unknown>;
    if (typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt) || data.createdAt <= 0
      || typeof data.service !== 'string' || !data.service.trim()
      || typeof data.peerId !== 'string' || !data.peerId.trim()) continue;
    routes.set(data.createdAt, { service: data.service, peerId: data.peerId });
  }
  return messages.map((message) => {
    const route = message.role === 'assistant' && message.createdAt ? routes.get(message.createdAt) : undefined;
    return route ? { ...message, meta: { ...message.meta, ...route } } : message;
  });
}
