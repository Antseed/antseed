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
export function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const text = String(error ?? '').trim();
  return text.length > 0 ? text : 'Unexpected error';
}
