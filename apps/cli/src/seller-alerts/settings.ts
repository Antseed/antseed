import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '@antseed/node';
import { normalizeSellerAlerts } from '../config/seller-alerts.js';
import type { SellerAlertsCLIConfig as SellerAlertsConfig } from '../config/types.js';

export const DEFAULT_TELEGRAM_TOKEN_ENV = 'ANTSEED_ALERTS_TELEGRAM_TOKEN';
/** Where alert secrets live: the Telegram bot token and the webhook URL (which often carries a token). */
export const ALERT_SECRETS_FILE = join('secrets', 'seller-alerts.json');
/** How often a running seller looks for edits to config.json and the secrets file. */
const RELOAD_CHECK_MS = 2_000;

export interface AlertSecrets {
  telegramBotToken?: string;
  webhookUrl?: string;
}

export const alertSecretsPath = (dataDir: string) => join(dataDir, ALERT_SECRETS_FILE);

/**
 * Alert settings saved from the dashboard or console: `<dataDir>/seller-alerts.json`,
 * layered over `seller.alerts` in config.json (a value here wins; null turns the
 * config value off). It lives in the data dir so alerts can be set up even when
 * config.json is read-only, e.g. mounted from a Kubernetes ConfigMap.
 */
export const ALERT_OVERRIDES_FILE = 'seller-alerts.json';

export interface AlertOverrides {
  telegramChatId?: string | null;
  idleMinutes?: number | null;
  cooldownMinutes?: number | null;
  lowBalanceUsd?: number | null;
  minSeverity?: 'info' | 'warning' | 'critical' | null;
  /** false ignores a webhook URL written in config.json (cleared from the dashboard). */
  webhookFromConfig?: false;
}

export const alertOverridesPath = (dataDir: string) => join(dataDir, ALERT_OVERRIDES_FILE);

export function readAlertOverrides(dataDir: string): AlertOverrides {
  try {
    const parsed = JSON.parse(readFileSync(alertOverridesPath(dataDir), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AlertOverrides : {};
  } catch {
    return {};
  }
}

/**
 * Merges `patch` into the overrides file (undefined keeps a key), written
 * atomically with mode 0600 under the cross-process file lock, so a dashboard
 * and a CLI saving at once both keep their fields.
 */
export async function writeAlertOverrides(dataDir: string, patch: AlertOverrides): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  await withFileLock(alertOverridesPath(dataDir), async () => {
    const next: Record<string, unknown> = { ...readAlertOverrides(dataDir) };
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) next[key] = value;
    writeJsonAtomic(alertOverridesPath(dataDir), next);
  });
}

/** config.json's `seller.alerts` with the dashboard's overrides applied. */
export function applyAlertOverrides(config: SellerAlertsConfig | undefined, overrides: AlertOverrides): SellerAlertsConfig {
  const merged: SellerAlertsConfig = { ...(config ?? {}) };
  if (overrides.telegramChatId !== undefined) merged.telegram = { ...merged.telegram, chatId: overrides.telegramChatId === null ? '' : String(overrides.telegramChatId) };
  for (const key of ['idleMinutes', 'cooldownMinutes', 'lowBalanceUsd', 'minSeverity'] as const) {
    if (overrides[key] === undefined) continue;
    if (overrides[key] === null) { delete merged[key]; continue; }
    // The file is hand-editable: a malformed value is ignored, as in config.json.
    const value = normalizeSellerAlerts({ [key]: overrides[key] })?.[key];
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  if (overrides.webhookFromConfig === false) delete merged.webhook;
  return merged;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readAlertSecrets(dataDir: string): AlertSecrets {
  try {
    const parsed = JSON.parse(readFileSync(alertSecretsPath(dataDir), 'utf-8')) as Record<string, unknown>;
    return {
      ...(typeof parsed.telegramBotToken === 'string' && parsed.telegramBotToken ? { telegramBotToken: parsed.telegramBotToken } : {}),
      ...(typeof parsed.webhookUrl === 'string' && parsed.webhookUrl ? { webhookUrl: parsed.webhookUrl } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Sets (string) or clears (null) alert secrets; undefined keeps a value. The
 * directory is 0700 and the file 0600, replaced atomically under the
 * cross-process file lock.
 */
export async function writeAlertSecrets(dataDir: string, patch: { telegramBotToken?: string | null; webhookUrl?: string | null }): Promise<void> {
  const dir = join(dataDir, 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  await withFileLock(alertSecretsPath(dataDir), async () => {
    const next: AlertSecrets = { ...readAlertSecrets(dataDir) };
    for (const key of ['telegramBotToken', 'webhookUrl'] as const) {
      const value = patch[key];
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    writeJsonAtomic(alertSecretsPath(dataDir), next);
  });
}

export interface ResolvedAlerts {
  config: SellerAlertsConfig;
  telegram: { token: string; chatId: string; tokenSource: 'env' | 'file' } | null;
  webhookUrl: string | null;
}

/** The env var (telegram.botTokenEnv) wins over the secrets file; the secrets file's webhook URL over config.json's. */
export function resolveAlerts(config: SellerAlertsConfig | undefined, secrets: AlertSecrets, env: NodeJS.ProcessEnv): ResolvedAlerts {
  const alerts = config ?? {};
  const fromEnv = env[alerts.telegram?.botTokenEnv || DEFAULT_TELEGRAM_TOKEN_ENV]?.trim();
  const token = fromEnv || secrets.telegramBotToken;
  const chatId = String(alerts.telegram?.chatId ?? '').trim();
  return {
    config: alerts,
    telegram: token && chatId ? { token, chatId, tokenSource: fromEnv ? 'env' : 'file' } : null,
    webhookUrl: secrets.webhookUrl || alerts.webhook?.url || null,
  };
}

/**
 * `seller.alerts` as written in the config file (alerts have no defaults), with
 * malformed fields left out. Throws when the file cannot be read or parsed, so
 * a live reload keeps its last good settings instead of dropping them.
 */
export function readAlertsConfigStrict(configPath: string): SellerAlertsConfig | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${configPath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${configPath} is not valid JSON`);
  }
  const seller = parsed && typeof parsed === 'object' ? (parsed as { seller?: unknown }).seller : undefined;
  return normalizeSellerAlerts(seller && typeof seller === 'object' ? (seller as { alerts?: unknown }).alerts : undefined);
}

/** `readAlertsConfigStrict`, but an unreadable file reads as no alerts (one-off reads for display). */
export function readAlertsConfig(configPath: string): SellerAlertsConfig | undefined {
  try {
    return readAlertsConfigStrict(configPath);
  } catch {
    return undefined;
  }
}

const fileStamp = (path: string): string => {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return 'missing';
  }
};

/**
 * The alert settings a running seller uses, re-read when config.json, the
 * dashboard's overrides file or the secrets file change (checked at most every 2 s, by mtime, size and inode, so
 * a Kubernetes ConfigMap swap counts too). With `config` instead of
 * `configPath`, the config part is fixed (tests, one-shot commands).
 */
export class AlertSettingsSource {
  private _resolved: ResolvedAlerts | null = null;
  private _stamp = '';
  private _checkedAt = 0;

  constructor(private readonly _options: { dataDir: string; configPath?: string; config?: SellerAlertsConfig; env?: NodeJS.ProcessEnv; now?: () => number }) {}

  current(): ResolvedAlerts {
    const now = (this._options.now ?? Date.now)();
    if (this._resolved && now - this._checkedAt < RELOAD_CHECK_MS) return this._resolved;
    this._checkedAt = now;
    const { configPath, dataDir } = this._options;
    const stamp = `${configPath ? fileStamp(configPath) : 'static'}|${fileStamp(alertSecretsPath(dataDir))}|${fileStamp(alertOverridesPath(dataDir))}`;
    if (!this._resolved || stamp !== this._stamp) {
      this._stamp = stamp;
      try {
        const config = applyAlertOverrides(configPath ? readAlertsConfigStrict(configPath) : this._options.config, readAlertOverrides(dataDir));
        this._resolved = resolveAlerts(config, readAlertSecrets(dataDir), this._options.env ?? process.env);
      } catch (error) {
        // An edit that cannot be applied keeps the last good settings; the timers that ask must never throw.
        if (!this._resolved) this._resolved = resolveAlerts(undefined, {}, this._options.env ?? process.env);
        console.error(`[alerts] Keeping the previous alert settings: ${(error as Error).message}`);
      }
    }
    return this._resolved;
  }
}

/** Telegram Bot API base; ANTSEED_TELEGRAM_API_URL points it at a local stub in tests. */
export function telegramApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['ANTSEED_TELEGRAM_API_URL']?.trim() || 'https://api.telegram.org').replace(/\/+$/, '');
}

export interface TelegramChat {
  id: string;
  title: string;
  type: string;
}

/**
 * Chats that recently messaged the bot or added it, from getUpdates, newest
 * first. Telegram keeps updates for 24 hours and only while no webhook is set.
 * Reads the latest 100 (a negative offset), so a backlog never hides a new chat;
 * Telegram then drops the older pending updates, which an alerts bot never reads.
 */
export async function findTelegramChats(token: string, options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<TelegramChat[]> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${telegramApiBase(options.env)}/bot${token}/getUpdates?offset=-100&limit=100`, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`Could not reach Telegram: ${(error as Error).message.replaceAll(token, '<token>')}`);
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: unknown[] } | null;
  if (response.status === 401) throw new Error('Telegram rejected the bot token');
  if (response.status === 409) throw new Error('This bot has a webhook set, so Telegram does not keep its updates. Enter the chat id by hand');
  if (!response.ok || !body?.ok) throw new Error(`Telegram answered HTTP ${response.status}${body?.description ? `: ${body.description}` : ''}`.replaceAll(token, '<token>'));
  const chats = new Map<string, TelegramChat>();
  for (const update of [...(body.result ?? [])].reverse() as Array<Record<string, { chat?: Record<string, unknown> } | undefined>>) {
    for (const field of ['message', 'edited_message', 'channel_post', 'my_chat_member', 'chat_member']) {
      const chat = update[field]?.chat;
      if (!chat || chat.id === undefined) continue;
      const id = String(chat.id);
      if (chats.has(id)) continue;
      const name = [chat.first_name, chat.last_name].filter((part) => typeof part === 'string').join(' ');
      chats.set(id, { id, type: String(chat.type ?? 'chat'), title: String(chat.title ?? (name || (chat.username ? `@${chat.username}` : id))) });
    }
  }
  return [...chats.values()];
}

/** Host of a webhook URL for display; the URL itself may carry a secret. */
export function webhookHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}
