import type { SellerAlertsCLIConfig } from './types.js';

const SEVERITIES = new Set(['info', 'warning', 'critical']);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isMinutes = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
/** A Telegram chat id: written as a string, or as the number Telegram shows. */
const chatIdOf = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;

/** What is wrong with a `seller.alerts` block, as `validateConfig` reports it. */
export function sellerAlertsErrors(value: unknown, path = 'seller.alerts'): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [];
  const { telegram, webhook } = value;
  if (telegram !== undefined) {
    if (!isRecord(telegram)) errors.push(`${path}.telegram must be an object`);
    else {
      if (chatIdOf(telegram.chatId) === null) errors.push(`${path}.telegram.chatId must be a string or an integer`);
      if (telegram.botTokenEnv !== undefined && typeof telegram.botTokenEnv !== 'string') errors.push(`${path}.telegram.botTokenEnv must be a string`);
    }
  }
  if (webhook !== undefined && (!isRecord(webhook) || typeof webhook.url !== 'string')) errors.push(`${path}.webhook.url must be a string`);
  for (const key of ['idleMinutes', 'cooldownMinutes'] as const) {
    if (value[key] !== undefined && !isMinutes(value[key])) errors.push(`${path}.${key} must be a positive number`);
  }
  if (value.minSeverity !== undefined && !SEVERITIES.has(value.minSeverity as string)) errors.push(`${path}.minSeverity must be "info", "warning" or "critical"`);
  return errors;
}

/**
 * `seller.alerts` as a running seller uses it: a numeric chat id becomes a
 * string and fields of the wrong type are left out, so a hand edit never
 * throws inside the alert timers (`validateConfig` reports it instead).
 */
export function normalizeSellerAlerts(value: unknown): SellerAlertsCLIConfig | undefined {
  if (!isRecord(value)) return undefined;
  const out: SellerAlertsCLIConfig = {};
  const { telegram, webhook } = value;
  const chatId = isRecord(telegram) ? chatIdOf(telegram.chatId) : null;
  if (isRecord(telegram) && chatId !== null) {
    out.telegram = { chatId, ...(typeof telegram.botTokenEnv === 'string' ? { botTokenEnv: telegram.botTokenEnv } : {}) };
  }
  if (isRecord(webhook) && typeof webhook.url === 'string') out.webhook = { url: webhook.url };
  for (const key of ['idleMinutes', 'cooldownMinutes'] as const) if (isMinutes(value[key])) out[key] = value[key];
  if (SEVERITIES.has(value.minSeverity as string)) out.minSeverity = value.minSeverity as SellerAlertsCLIConfig['minSeverity'];
  return out;
}
