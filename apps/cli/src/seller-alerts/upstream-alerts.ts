import type { ModelHealthEvent, UpstreamAccountEvent } from '@antseed/node';
import type { SellerAlerts } from './alerts.js';

type Recorder = Pick<SellerAlerts, 'record'>;

interface Upstream {
  provider: string;
  /** Withdrawn services, with the last reason. */
  down: Map<string, string>;
  /** Whether a withdrawal alert is open for this upstream. */
  announced: boolean;
  /** How many were withdrawn when it was last announced. */
  announcedCount: number;
  credit: 'out' | 'low' | null;
  /** Something changed since the last flush. */
  dirty: boolean;
}

/**
 * Seller alerts per upstream (a configured provider) rather than per model:
 * models withdrawn or restored in one health-check round are one message
 * (`flush` after each round), more withdrawn later update it,
 * and an upstream out of credit is one critical alert naming the cause, sent
 * on its first billing error. Every model change is still journaled by itself.
 */
export class UpstreamAlerts {
  private readonly _upstreams = new Map<string, Upstream>();
  private _closed = false;

  constructor(
    private readonly _alerts: Recorder,
    private readonly _options: { hostOf?: (providerId: string) => string | null } = {},
  ) {}

  /** A model withdrawn or restored by the health checker. */
  modelChanged(event: ModelHealthEvent): void {
    if (this._closed) return;
    const removed = event.status === 'removed';
    void this._alerts.record({
      kind: removed ? 'model_down' : 'model_up',
      severity: removed ? 'warning' : 'info',
      title: removed ? `${event.service} withdrawn after ${event.consecutiveFailures} failed health checks` : `${event.service} is healthy again and advertised`,
      detail: event.detail, provider: event.provider, providerId: event.providerId, service: event.service,
    }, { notify: false });
    const upstream = this._upstream(event.providerId, event.provider);
    if (removed) upstream.down.set(event.service, event.detail);
    else upstream.down.delete(event.service);
    upstream.dirty = true;
  }

  /** After a health-check round: one message per upstream for what changed in it. */
  flush(): void {
    if (this._closed) return;
    for (const [providerId, upstream] of this._upstreams) {
      if (!upstream.dirty) continue;
      upstream.dirty = false;
      this._flush(providerId, upstream);
    }
  }

  /** The upstream account's credit, from the health checker (probes, account checks and live requests). */
  account(event: UpstreamAccountEvent): void {
    if (this._closed) return;
    const upstream = this._upstream(event.providerId, event.provider);
    const name = this._name(event.providerId);
    const common = { provider: event.provider, providerId: event.providerId, detail: event.detail };
    const previous = upstream.credit;
    // Leaving a state closes its alert, whichever state comes next.
    if (previous === 'out' && event.status !== 'out_of_credit') void this._alerts.record({ kind: 'upstream_credit_ok', severity: 'info', title: `${name} has credit again`, ...common });
    if (previous === 'low' && event.status !== 'low_balance') void this._alerts.record({ kind: 'upstream_balance_ok', severity: 'info', title: `${name} balance is back above the warning line`, ...common });
    if (event.status === 'out_of_credit') {
      upstream.credit = 'out';
      const withdrawn = upstream.down.size;
      const models = `${event.services.length} model${event.services.length === 1 ? '' : 's'}`;
      void this._alerts.record({
        kind: 'upstream_credit', severity: 'critical',
        title: `${name} is out of credit: ${withdrawn > 0 ? `${withdrawn} of ${models} withdrawn` : `its ${models} fail until it is topped up`}. Top up the upstream account.`,
        ...common,
      });
    } else if (event.status === 'low_balance') {
      upstream.credit = 'low';
      void this._alerts.record({ kind: 'upstream_balance_low', severity: 'warning', title: `${name} is running low on credit. Top up the upstream account.`, ...common });
    } else {
      upstream.credit = null;
    }
  }

  /** Nothing more is sent after shutdown starts (a sweep may still finish). */
  close(): void {
    this._closed = true;
  }

  private _upstream(providerId: string, provider: string): Upstream {
    let upstream = this._upstreams.get(providerId);
    if (!upstream) {
      upstream = { provider, down: new Map(), announced: false, announcedCount: 0, credit: null, dirty: false };
      this._upstreams.set(providerId, upstream);
    }
    return upstream;
  }

  private _name(providerId: string): string {
    const host = this._options.hostOf?.(providerId);
    return host ? `${providerId} (${host})` : providerId;
  }

  private _flush(providerId: string, upstream: Upstream): void {
    const withdrawn = [...upstream.down.keys()];
    const common = { provider: upstream.provider, providerId };
    if (withdrawn.length === 0) {
      if (upstream.announced) void this._alerts.record({ kind: 'model_up', severity: 'info', title: `${this._name(providerId)}: every withdrawn model is healthy again and advertised`, ...common }, { journal: false });
      upstream.announced = false;
      upstream.announcedCount = 0;
      return;
    }
    // Out of credit already said why; more withdrawals add nothing to act on.
    if (upstream.credit === 'out' || withdrawn.length <= upstream.announcedCount) return;
    const shown = withdrawn.slice(0, 10).join(', ') + (withdrawn.length > 10 ? ` and ${withdrawn.length - 10} more` : '');
    void this._alerts.record({
      kind: 'model_down', severity: 'warning',
      title: withdrawn.length === 1
        ? `${withdrawn[0]} on ${this._name(providerId)} withdrawn after failed health checks`
        : `${withdrawn.length} models on ${this._name(providerId)} withdrawn after failed health checks: ${shown}`,
      detail: upstream.down.get(withdrawn.at(-1)!) ?? '',
      ...common,
    }, { journal: false, update: upstream.announced });
    upstream.announced = true;
    upstream.announcedCount = withdrawn.length;
  }
}
