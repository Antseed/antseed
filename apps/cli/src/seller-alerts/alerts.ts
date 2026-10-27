import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSellerEvent, type SellerEvent, type SellerEventKind, type SellerEventSeverity } from '@antseed/node';
import type { SellerAlertsCLIConfig as SellerAlertsConfig } from '../config/types.js';
import { AlertSettingsSource, DEFAULT_TELEGRAM_TOKEN_ENV, telegramApiBase } from './settings.js';

export type { SellerAlertsConfig };
export { DEFAULT_TELEGRAM_TOKEN_ENV };

export const DEFAULT_ALERT_COOLDOWN_MINUTES = 30;
/** USD under which an upstream that reports its balance is a warning (`seller.alerts.lowBalanceUsd`). */
export const DEFAULT_LOW_BALANCE_USD = 5;

export interface SellerAlertsState {
  channels: string[];
  lastSentAt: number | null;
  lastError: string | null;
}

const SEVERITY_RANK: Record<SellerEventSeverity, number> = { info: 0, warning: 1, critical: 2 };
/** Recoveries close an alert that was sent, so they go out whatever their severity. */
const RECOVERY_OF: Partial<Record<SellerEventKind, SellerEventKind>> = {
  model_up: 'model_down', gas_ok: 'gas_low', active: 'idle', upstream_credit_ok: 'upstream_credit', upstream_balance_ok: 'upstream_balance_low',
};
const ICON: Record<SellerEventSeverity, string> = { info: '✅', warning: '⚠️', critical: '🚨' };
/**
 * Alerts whose send times outlive the process, so a crash-looping seller
 * (say, restarted by Kubernetes) still waits out the cooldown between them.
 */
const PERSISTED_KINDS = new Set<SellerEventKind>(['crashed']);
/** Send times of PERSISTED_KINDS alerts, by destination and incident, in the data dir. */
export const ALERT_HISTORY_FILE = 'seller-alerts-sent.json';

/** One alert's delivery to one destination: when it went out, and whether its recovery has closed it since. */
interface Delivery { at: number; open: boolean }

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
  /** First wait before resending an alert a channel failed to take (doubled per attempt, capped at 10 minutes). */
  retryMs?: number;
}

/** Resends of a failed alert, while its incident stays open, before giving up. */
const MAX_RETRIES = 8;
const MAX_RETRY_MS = 10 * 60_000;

/** Records seller events to the journal and sends the ones that matter to the configured channels. */
export class SellerAlerts {
  private readonly _opts: SellerAlertsOptions;
  private readonly _settings: AlertSettingsSource;
  private readonly _fetch: typeof fetch;
  private readonly _now: () => number;
  /** When each alert last reached each destination, keyed `destination|kind:provider/service`. */
  private readonly _lastSent = new Map<string, Delivery>();
  /** Alerts held back by the cooldown after their incident had closed, sent when it ends unless a recovery comes first. */
  private readonly _held = new Map<string, { timer: NodeJS.Timeout; event: SellerEvent }>();
  /**
   * Resends scheduled for alerts a channel failed to take, per incident: the
   * latest event, to the channels still missing it, cancelled by the recovery.
   */
  private readonly _retries = new Map<string, { timer: NodeJS.Timeout; event: SellerEvent; incident: string; recovery: boolean; channels: Map<AlertChannel, string>; attempt: number }>();
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
    for (const [key, at] of Object.entries(readHistory(options.dataDir))) this._lastSent.set(key, { at, open: false });
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
   * minSeverity or the same alert went there within the cooldown. The cooldown
   * spans recoveries, so a flapping model alerts once per cooldown: an alert
   * whose incident closed less than a cooldown ago is held, and sent when the
   * cooldown ends unless its recovery arrives first (then neither is sent).
   * Delivery state is kept per destination and only for sends that went
   * through, so a failed alert is resent with backoff (to the channels that
   * missed it) until it arrives or its recovery comes, and only an alert that
   * arrived gets its recovery.
   *
   * `quiet` closes an incident without announcing it, for one superseded by a
   * worse one (a low balance that ran out).
   */
  async record(input: Omit<SellerEvent, 'at'> & { at?: number }, options: { journal?: boolean; notify?: boolean; update?: boolean; quiet?: boolean } = {}): Promise<void> {
    const event: SellerEvent = { ...input, at: input.at ?? this._now() };
    // `journal: false` for a summary of events already journaled one by one; `notify: false` for one a summary will announce.
    const journaled = options.journal !== false
      ? appendSellerEvent(this._opts.dataDir, event).catch((err) => this._opts.log?.(`seller events: ${(err as Error).message}`))
      : Promise.resolve();
    if (options.notify === false) return journaled.then(() => {});
    const recovery = RECOVERY_OF[event.kind] !== undefined;
    const key = alertKey(RECOVERY_OF[event.kind] ?? event.kind, event);
    // A new outage makes a recovery still being resent stale; a recovery stops the alert's resends.
    this._release(recovery ? key : recoveryRetryKey(key));
    // The event takes its place in its incident now, in the order it was recorded; the
    // journal write it waits for inside must not let a later (say, quiet) recovery overtake it.
    await this._inIncident(key, async () => {
      await journaled;
      // Again in turn: a failure queued ahead of this recovery may have held an alert since,
      // and a recovery sending ahead of this outage may have scheduled a resend since.
      this._release(recovery ? key : recoveryRetryKey(key));
      if (recovery && options.quiet) {
        this._closeIncident(key);
        return;
      }
      return this._deliver(event, key, recovery, options.update === true);
    });
  }

  /** Drops alerts held back by the cooldown and pending resends, on shutdown. */
  close(): void {
    for (const key of new Set([...this._held.keys(), ...this._retries.keys()])) this._release(key);
  }

  private _release(key: string): void {
    const held = this._held.get(key);
    if (held) clearTimeout(held.timer);
    this._held.delete(key);
    const retry = this._retries.get(key);
    if (retry) clearTimeout(retry.timer);
    this._retries.delete(key);
  }

  private _closeIncident(key: string): void {
    for (const [historyKey, delivery] of this._lastSent) {
      if (historyKey.slice(historyKey.indexOf('|') + 1) === key) delivery.open = false;
    }
  }

  private async _inIncident(key: string, deliver: () => Promise<void>): Promise<void> {
    const run = (this._incidents.get(key) ?? Promise.resolve()).then(deliver);
    const settled = run.catch(() => {});
    this._incidents.set(key, settled);
    try {
      await run;
    } finally {
      if (this._incidents.get(key) === settled) this._incidents.delete(key);
    }
  }

  /** `update`: news about an incident still open (it grew), sent where its alert went regardless of the cooldown. */
  private async _deliver(event: SellerEvent, key: string, recovery: boolean, update = false, retry?: { channels: Map<AlertChannel, string>; attempt: number }): Promise<void> {
    const destinations = this._destinations();
    // A resend goes only to the channels that missed it, still configured. A recovery
    // goes only to the destination that missed it: a chat or webhook set up since never had the outage.
    const { channels, holdMs } = retry
      ? { channels: [...retry.channels].filter(([channel, destination]) => recovery ? destinations[channel] === destination : destinations[channel] !== undefined).map(([channel]) => channel), holdMs: null }
      : this._channelsFor(event, key, recovery, update);
    // A held alert goes out with the incident's latest news (say, more models withdrawn while it waited).
    const held = this._held.get(key);
    if (holdMs !== null && held) held.event = event;
    else if (holdMs !== null) {
      const entry = { event, timer: setTimeout(() => {
        this._held.delete(key);
        void this._inIncident(key, () => this._deliver(entry.event, key, false)).catch(() => {});
      }, holdMs) };
      entry.timer.unref?.();
      this._held.set(key, entry);
    }
    if (channels.length === 0) return;
    // History is kept per destination, as of when the send started, so a changed chat or webhook starts fresh.
    const { sent, delivered } = await this._send(event, channels);
    const failed = channels.filter((channel) => !sent.includes(channel));
    this._scheduleRetry(event, key, recovery, new Map(failed.map((channel) => [channel, destinations[channel]!])), sent as AlertChannel[], retry?.attempt ?? 0);
    // The incident is over whether or not its recovery got through, so the next outage is a new one (held by the cooldown, not dropped as a repeat).
    if (recovery) this._closeIncident(key);
    for (const destination of delivered) {
      const historyKey = `${destination}|${key}`;
      const last = this._lastSent.get(historyKey);
      if (recovery) {
        if (last) last.open = false;
      } else {
        this._lastSent.set(historyKey, { at: this._now(), open: true });
      }
    }
    if (!recovery && delivered.length > 0 && PERSISTED_KINDS.has(event.kind)) this._saveHistory();
  }

  /**
   * Health events come on changes only, so nothing else would resend an alert
   * that failed: resend it with backoff to the channels that missed it. A
   * newer event for the same incident replaces the pending one.
   */
  private _scheduleRetry(event: SellerEvent, incident: string, recovery: boolean, failed: Map<AlertChannel, string>, sent: AlertChannel[], attempt: number): void {
    const retryKey = recovery ? recoveryRetryKey(incident) : incident;
    const pending = this._retries.get(retryKey);
    if (pending) {
      for (const channel of sent) pending.channels.delete(channel);
      for (const [channel, destination] of failed) pending.channels.set(channel, destination);
      pending.event = event;
      if (pending.channels.size === 0) this._release(retryKey);
      return;
    }
    if (failed.size === 0 || attempt >= MAX_RETRIES) return;
    const entry = { event, incident, recovery, channels: new Map(failed), attempt, timer: setTimeout(() => {
      this._retries.delete(retryKey);
      void this._inIncident(incident, () => this._deliver(entry.event, incident, recovery, false, { channels: new Map(entry.channels), attempt: entry.attempt + 1 })).catch(() => {});
    }, Math.min((this._opts.retryMs ?? 30_000) * 2 ** attempt, MAX_RETRY_MS)) };
    entry.timer.unref?.();
    this._retries.set(retryKey, entry);
  }

  private _saveHistory(): void {
    const kept: Record<string, number> = {};
    for (const [historyKey, delivery] of this._lastSent) {
      const kind = historyKey.slice(historyKey.indexOf('|') + 1).split(':')[0] as SellerEventKind;
      if (PERSISTED_KINDS.has(kind)) kept[historyKey] = delivery.at;
    }
    try {
      const path = join(this._opts.dataDir, ALERT_HISTORY_FILE);
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    } catch (err) {
      this._opts.log?.(`seller alerts: cannot save alert history: ${(err as Error).message}`);
    }
  }

  /**
   * Where each channel sends right now: the channel type plus its chat, or a hash of
   * the webhook URL (a secret, and crash-alert history is written to the data dir).
   */
  private _destinations(): Partial<Record<AlertChannel, string>> {
    const { telegram, webhookUrl } = this.settings;
    const webhook = webhookUrl ? createHash('sha256').update(webhookUrl).digest('hex').slice(0, 16) : null;
    return { ...(telegram ? { telegram: `telegram:${telegram.chatId}` } : {}), ...(webhook ? { webhook: `webhook:${webhook}` } : {}) };
  }

  /**
   * Where the event goes now, and, for an alert held back on a channel whose
   * incident had closed (a flap), how long until the cooldown lets it out.
   */
  private _channelsFor(event: SellerEvent, key: string, recovery: boolean, update = false): { channels: AlertChannel[]; holdMs: number | null } {
    const destinations = this._destinations();
    const channels = (Object.keys(destinations) as AlertChannel[]);
    const historyKey = (channel: AlertChannel) => `${destinations[channel]}|${key}`;
    if (update) {
      const open = channels.filter((channel) => this._lastSent.get(historyKey(channel))?.open === true);
      if (open.length > 0) return { channels: open, holdMs: null };
    }
    // Only announce a recovery where its alert actually went out and is still open.
    if (recovery) return { channels: channels.filter((channel) => this._lastSent.get(historyKey(channel))?.open === true), holdMs: null };
    if (event.kind === 'test') return { channels, holdMs: null };
    const config = this.settings.config;
    if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[config.minSeverity ?? 'warning']) return { channels: [], holdMs: null };
    const cooldownMs = (config.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES) * 60_000;
    let holdMs: number | null = null;
    const ready = channels.filter((channel) => {
      const last = this._lastSent.get(historyKey(channel));
      const wait = last === undefined ? 0 : cooldownMs - (this._now() - last.at);
      if (wait <= 0) return true;
      // A repeat while the incident is open is simply dropped; a new incident inside the cooldown waits it out.
      if (!last!.open && !PERSISTED_KINDS.has(event.kind)) holdMs = Math.min(holdMs ?? wait, wait);
      return false;
    });
    return { channels: ready, holdMs };
  }

  /** Send to every configured channel (or only those in `only`); failures are kept in state() rather than thrown. */
  async send(event: SellerEvent, only?: AlertChannel | AlertChannel[]): Promise<{ sent: string[]; errors: string[] }> {
    const { sent, errors } = await this._send(event, only);
    return { sent, errors };
  }

  private async _send(event: SellerEvent, only?: AlertChannel | AlertChannel[]): Promise<{ sent: string[]; errors: string[]; delivered: string[] }> {
    const wanted = (channel: AlertChannel) => only === undefined || (Array.isArray(only) ? only.includes(channel) : only === channel)
    const text = formatAlert(this._opts.sellerName, event);
    const { telegram, webhookUrl } = this.settings;
    const destinations = this._destinations();
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
    return { sent, errors, delivered: sent.map((channel) => destinations[channel as AlertChannel]!) };
  }
}

type AlertChannel = 'telegram' | 'webhook'

function readHistory(dataDir: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, ALERT_HISTORY_FILE), 'utf-8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return {};
  }
}

/** Where a recovery being resent waits, apart from its incident's alert resends. */
const recoveryRetryKey = (key: string) => `recovery|${key}`

/** One incident: upstreams sharing a plugin name are told apart by their configured name. */
const alertKey = (kind: SellerEventKind, event: SellerEvent) => `${kind}:${event.providerId ?? event.provider ?? ''}/${event.service ?? ''}`

export function formatAlert(sellerName: string, event: SellerEvent): string {
  const lines = [`${ICON[event.severity]} ${sellerName}: ${event.title}`];
  if (event.detail) lines.push(event.detail.length > 500 ? `${event.detail.slice(0, 500)}…` : event.detail);
  return lines.join('\n');
}
