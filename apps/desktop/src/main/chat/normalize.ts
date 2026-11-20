/**
 * Small value normalizers shared across the chat engine modules.
 */

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

/** A gateway model id, trimmed; '' when absent. */
export function normalizeServiceId(service?: unknown): string {
  return typeof service === 'string' ? service.trim() : '';
}
