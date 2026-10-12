/**
 * Small value normalizers shared across the chat engine modules.
 *
 * NOTE: `asPlainObject` is deliberately stricter than `asRecord` in
 * `../utils.js` — it rejects arrays and reports failure as `null` rather than
 * substituting `{}`, because the catalog parsers need to tell "absent" from
 * "present but empty".
 */
import type { ChatServiceProtocol } from './service-catalog.js';

export const DEFAULT_CHAT_SERVICE = 'claude-sonnet-4-20250514';

export function normalizeTokenCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function normalizeOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export function normalizeServiceId(service?: string): string {
  const trimmed = String(service ?? '').trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_CHAT_SERVICE;
}

export function isChatServiceProtocol(value: unknown): value is ChatServiceProtocol {
  return value === 'anthropic-messages'
    || value === 'openai-chat-completions'
    || value === 'openai-responses';
}

export function normalizeServiceValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const service = value.trim();
  return service.length > 0 ? service : null;
}

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function normalizeNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizePeerId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const peerId = value.trim().toLowerCase();
  // Antseed currently uses 20-byte EVM-address peer IDs in the buyer catalog,
  // while some older/local router paths can surface 32-byte IDs. Accept both
  // so response metadata never silently fails to bind a conversation.
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(peerId) ? peerId : null;
}
