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
  /** When each alert last reached each channel, keyed `channel|kind:provider/service`. */
  private readonly _lastSent = new Map<string, number>();
  /**
   * Deliveries in flight per incident (`kind:provider/service` of the alert):
   * an alert, its repeats and its recovery go out one after another, so a
   * recovery that arrives mid-send waits to see whether its alert got through.
   */
  private readonly _incidents = new Map<string, Promise<void>>();
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

  /**
   * Journal the event, then send it to each channel unless it is below
   * minSeverity or repeats within the cooldown there. Delivery state is kept
   * per channel and only for sends that went through, so a failed alert is
   * retried on its next repeat and only an alert that arrived gets its recovery.
   */
  async record(input: Omit<SellerEvent, 'at'> & { at?: number }): Promise<void> {
    const event: SellerEvent = { ...input, at: input.at ?? this._now() };
    await appendSellerEvent(this._opts.dataDir, event).catch((err) => this._opts.log?.(`seller events: ${(err as Error).message}`));
    const recovery = RECOVERY_OF[event.kind] !== undefined;
    const key = alertKey(RECOVERY_OF[event.kind] ?? event.kind, event);
    const run = (this._incidents.get(key) ?? Promise.resolve()).then(() => this._deliver(event, key, recovery));
    const settled = run.catch(() => {});
    this._incidents.set(key, settled);
    try {
      await run;
    } finally {
      if (this._incidents.get(key) === settled) this._incidents.delete(key);
    }
  }

  private async _deliver(event: SellerEvent, key: string, recovery: boolean): Promise<void> {
    const channels = this._channelsFor(event, key, recovery);
    if (channels.length === 0) return;
    const { sent } = await this.send(event, channels);
    for (const channel of sent) {
      if (recovery) this._lastSent.delete(`${channel}|${key}`);
      else this._lastSent.set(`${channel}|${key}`, this._now());
    }
  }

  private _channelsFor(event: SellerEvent, key: string, recovery: boolean): AlertChannel[] {
    const channels = this.channels() as AlertChannel[];
    // Only announce a recovery where its alert actually went out.
    if (recovery) return channels.filter((channel) => this._lastSent.has(`${channel}|${key}`));
    if (event.kind === 'test') return channels;
    const config = this.settings.config;
    if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[config.minSeverity ?? 'warning']) return [];
    const cooldownMs = (config.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES) * 60_000;
    return channels.filter((channel) => {
      const last = this._lastSent.get(`${channel}|${key}`);
      return last === undefined || this._now() - last >= cooldownMs;
    });
  }

  /** Send to every configured channel (or only those in `only`); failures are kept in state() rather than thrown. */
  async send(event: SellerEvent, only?: AlertChannel | AlertChannel[]): Promise<{ sent: string[]; errors: string[] }> {
    const wanted = (channel: AlertChannel) => only === undefined || (Array.isArray(only) ? only.includes(channel) : only === channel)
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
    if (telegram && wanted('telegram')) {
      await attempt('telegram', () => this._fetch(`${telegramApiBase(this._opts.env)}/bot${telegram.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: telegram.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      }));
    }
    if (webhookUrl && wanted('webhook')) {
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

type AlertChannel = 'telegram' | 'webhook'

/** One incident: upstreams sharing a plugin name are told apart by their configured name. */
const alertKey = (kind: SellerEventKind, event: SellerEvent) => `${kind}:${event.providerId ?? event.provider ?? ''}/${event.service ?? ''}`

export function formatAlert(sellerName: string, event: SellerEvent): string {
  const lines = [`${ICON[event.severity]} ${sellerName}: ${event.title}`];
  if (event.detail) lines.push(event.detail.length > 500 ? `${event.detail.slice(0, 500)}…` : event.detail);
  return lines.join('\n');
}
