import { appendSellerEvent, type SellerEvent, type SellerEventKind, type SellerEventSeverity } from '@antseed/node';
import type { SellerAlertsCLIConfig as SellerAlertsConfig } from '../config/types.js';
import { AlertSettingsSource, DEFAULT_TELEGRAM_TOKEN_ENV, telegramApiBase } from './settings.js';

export type { SellerAlertsConfig };
export { DEFAULT_TELEGRAM_TOKEN_ENV };

export const DEFAULT_ALERT_COOLDOWN_MINUTES = 30;

export interface SellerAlertsState {
  channels: string[];
  lastSentAt: number | null;
  lastError: string | null;
}

const SEVERITY_RANK: Record<SellerEventSeverity, number> = { info: 0, warning: 1, critical: 2 };
/** Recoveries close an alert that was sent, so they go out whatever their severity. */
const RECOVERY_OF: Partial<Record<SellerEventKind, SellerEventKind>> = { model_up: 'model_down', gas_ok: 'gas_low', active: 'idle' };
const ICON: Record<SellerEventSeverity, string> = { info: '✅', warning: '⚠️', critical: '🚨' };

export interface SellerAlertsOptions {
  dataDir: string;
  /**
   * The config file to read `seller.alerts` from, re-read when it changes (a
   * running seller picks up edits without a restart). Without it, `config` is used as is.
   */
  configPath?: string;
  config?: SellerAlertsConfig;
  /** Shown in every message, e.g. the seller's display name or short peer id. */
  sellerName: string;
  peerId?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** Records seller events to the journal and sends the ones that matter to the configured channels. */
export class SellerAlerts {
  private readonly _opts: SellerAlertsOptions;
  private readonly _settings: AlertSettingsSource;
  private readonly _fetch: typeof fetch;
  private readonly _now: () => number;
  private readonly _lastSent = new Map<string, number>();
  private _lastSentAt: number | null = null;
  private _lastError: string | null = null;

  constructor(options: SellerAlertsOptions) {
    this._opts = options;
    this._fetch = options.fetch ?? fetch;
    this._now = options.now ?? Date.now;
    this._settings = new AlertSettingsSource({
      dataDir: options.dataDir,
      ...(options.configPath ? { configPath: options.configPath } : { config: options.config }),
      ...(options.env ? { env: options.env } : {}),
      now: this._now,
    });
  }

  /** The current settings: config.json and the secrets file as of the last check. */
  get settings() {
    return this._settings.current();
  }

  /** Current idle threshold, so an idle watch follows edits. */
  idleMinutes(): number | undefined {
    return this.settings.config.idleMinutes;
  }

  channels(): string[] {
    const { telegram, webhookUrl } = this.settings;
    return [...(telegram ? ['telegram'] : []), ...(webhookUrl ? ['webhook'] : [])];
  }

  state(): SellerAlertsState {
    return { channels: this.channels(), lastSentAt: this._lastSentAt, lastError: this._lastError };
  }

  /** Journal the event, then send it unless it is below minSeverity or repeats within the cooldown. */
  async record(input: Omit<SellerEvent, 'at'> & { at?: number }): Promise<void> {
    const event: SellerEvent = { ...input, at: input.at ?? this._now() };
    await appendSellerEvent(this._opts.dataDir, event).catch((err) => this._opts.log?.(`seller events: ${(err as Error).message}`));
    if (!this._shouldSend(event)) return;
    await this.send(event);
  }

  private _shouldSend(event: SellerEvent): boolean {
    if (this.channels().length === 0) return false;
    const recovers = RECOVERY_OF[event.kind];
    if (recovers) {
      // Only announce a recovery for an alert that actually went out.
      const key = `${recovers}:${event.provider ?? ''}/${event.service ?? ''}`;
      if (!this._lastSent.has(key)) return false;
      this._lastSent.delete(key);
      return true;
    }
    const config = this.settings.config;
    const min = SEVERITY_RANK[config.minSeverity ?? 'warning'];
    if (SEVERITY_RANK[event.severity] < min && event.kind !== 'test') return false;
    const key = `${event.kind}:${event.provider ?? ''}/${event.service ?? ''}`;
    const cooldownMs = (config.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES) * 60_000;
    const last = this._lastSent.get(key);
    if (last !== undefined && this._now() - last < cooldownMs && event.kind !== 'test') return false;
    this._lastSent.set(key, this._now());
    return true;
  }

  /** Send to every configured channel (or only `only`); failures are kept in state() rather than thrown. */
  async send(event: SellerEvent, only?: 'telegram' | 'webhook'): Promise<{ sent: string[]; errors: string[] }> {
    const text = formatAlert(this._opts.sellerName, event);
    const { telegram, webhookUrl } = this.settings;
    const secrets = [telegram?.token, webhookUrl].filter((value): value is string => Boolean(value));
    // Never echo a secret: fetch errors can carry the request URL.
    const redact = (message: string) => secrets.reduce((out, secret) => out.replaceAll(secret, secret === webhookUrl ? '<webhook>' : '<token>'), message);
    const sent: string[] = [];
    const errors: string[] = [];
    const attempt = async (channel: string, run: () => Promise<Response>) => {
      try {
        const res = await run();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sent.push(channel);
      } catch (err) {
        errors.push(redact(`${channel}: ${(err as Error).message}`));
      }
    };
    if (telegram && only !== 'webhook') {
      await attempt('telegram', () => this._fetch(`${telegramApiBase(this._opts.env)}/bot${telegram.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: telegram.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      }));
    }
    if (webhookUrl && only !== 'telegram') {
      await attempt('webhook', () => this._fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text, seller: { name: this._opts.sellerName, peerId: this._opts.peerId ?? null }, event }),
        signal: AbortSignal.timeout(10_000),
      }));
    }
    if (sent.length > 0) this._lastSentAt = this._now();
    this._lastError = errors.length > 0 ? errors.join('; ') : null;
    if (this._lastError) this._opts.log?.(`seller alerts: ${this._lastError}`);
    return { sent, errors };
  }
}

export function formatAlert(sellerName: string, event: SellerEvent): string {
  const lines = [`${ICON[event.severity]} ${sellerName}: ${event.title}`];
  if (event.detail) lines.push(event.detail.length > 500 ? `${event.detail.slice(0, 500)}…` : event.detail);
  return lines.join('\n');
}
