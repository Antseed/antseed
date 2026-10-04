import type { RuntimeMode } from './runtime/process-manager.js';

export type AppendLogFn = (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void;

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

export function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

const RPC_TROUBLE = /rate limit|too many requests|\b429\b|\b50[234]\b|timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|network error|failed to detect network|could not detect network|missing revert data|SERVER_ERROR|NETWORK_ERROR|TIMEOUT|fetch failed|every rpc endpoint|indexer|antscan/i;

/**
 * One short line for errors shown in the UI: chain RPC and explorer trouble
 * (rate limits, timeouts, unreachable endpoints) becomes a friendly retry
 * hint instead of raw text like "http://127.0.0.1:8547 is rate limiting
 * requests"; anything else keeps its message.
 */
export function friendlyNetworkError(error: unknown): string {
  const message = asErrorMessage(error);
  return RPC_TROUBLE.test(message) ? 'The network is busy right now. Try again in a minute.' : message;
}

export function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const text = String(error ?? '').trim();
  return text.length > 0 ? text : 'Unexpected error';
}
