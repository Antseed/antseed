import type { ModelHealthEvent, UpstreamAccountEvent } from '@antseed/node';
import type { SellerAlerts } from './alerts.js';

type Recorder = Pick<SellerAlerts, 'record'>;

interface Upstream {
  provider: string;
  /** Services marked failing, with the last reason. */
  down: Map<string, string>;
  /** Whether a failing-models alert is open for this upstream. */
  announced: boolean;
  /** The failing services the open alert names, less any recovered since. */
  announcedServices: Set<string>;
  credit: 'out' | 'low' | null;
  /** Something changed since the last flush. */
  dirty: boolean;
}

/**
 * Seller alerts per upstream (a configured provider) rather than per model:
 * models marked failing or recovered in one health-check round are one message
 * (`flush` after each round), more failing later update it,
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

  /** A model the self health check marked failing, or that recovered. */
  modelChanged(event: ModelHealthEvent): void {
    if (this._closed) return;
    const removed = event.status === 'failing';
    void this._alerts.record({
      kind: removed ? 'model_down' : 'model_up',
      severity: removed ? 'warning' : 'info',
      title: removed ? `${event.service} marked failing after ${event.consecutiveFailures} failed health checks` : `${event.service} is healthy again`,
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
    // Running out supersedes the low-balance warning: it closes without a recovery message.
    if (previous === 'low' && event.status === 'out_of_credit') void this._alerts.record({ kind: 'upstream_balance_ok', severity: 'info', title: `${name} ran out of credit`, ...common }, { journal: false, quiet: true });
    else if (previous === 'low' && event.status !== 'low_balance') void this._alerts.record({ kind: 'upstream_balance_ok', severity: 'info', title: `${name} balance is back above the warning line`, ...common });
    if (event.status === 'out_of_credit') {
      upstream.credit = 'out';
      const failing = upstream.down.size;
      const models = `${event.services.length} model${event.services.length === 1 ? '' : 's'}`;
      void this._alerts.record({
        kind: 'upstream_credit', severity: 'critical',
        title: `${name} is out of credit: ${failing > 0 ? `${failing} of ${models} failing` : `its ${models} fail until it is topped up`}. Top up the upstream account.`,
        ...common,
      });
    } else if (event.status === 'low_balance') {
      upstream.credit = 'low';
      void this._alerts.record({ kind: 'upstream_balance_low', severity: 'warning', title: `${name} is running low on credit. Top up the upstream account.`, ...common });
    } else {
      upstream.credit = null;
    }
    // Failing-model alerts were held back while it was out of credit. Models still down after the
    // round that brought credit back are a separate outage: the next flush announces them.
    if (previous === 'out' && upstream.credit !== 'out' && upstream.down.size > 0) upstream.dirty = true;
  }

  /** Nothing more is sent after shutdown starts (a sweep may still finish). */
  close(): void {
    this._closed = true;
  }

  private _upstream(providerId: string, provider: string): Upstream {
    let upstream = this._upstreams.get(providerId);
    if (!upstream) {
      upstream = { provider, down: new Map(), announced: false, announcedServices: new Set(), credit: null, dirty: false };
      this._upstreams.set(providerId, upstream);
    }
    return upstream;
  }

  private _name(providerId: string): string {
    const host = this._options.hostOf?.(providerId);
    return host ? `${providerId} (${host})` : providerId;
  }

  private _flush(providerId: string, upstream: Upstream): void {
    const failing = [...upstream.down.keys()];
    const common = { provider: upstream.provider, providerId };
    if (failing.length === 0) {
      if (upstream.announced) void this._alerts.record({ kind: 'model_up', severity: 'info', title: `${this._name(providerId)}: every failing model is healthy again`, ...common }, { journal: false });
      upstream.announced = false;
      upstream.announcedServices.clear();
      return;
    }
    // A recovered model drops out, so it is announced again if it fails again.
    for (const service of upstream.announcedServices) if (!upstream.down.has(service)) upstream.announcedServices.delete(service);
    // Out of credit already said why; more failing models add nothing to act on.
    if (upstream.credit === 'out' || failing.every((service) => upstream.announcedServices.has(service))) return;
    const shown = failing.slice(0, 10).join(', ') + (failing.length > 10 ? ` and ${failing.length - 10} more` : '');
    void this._alerts.record({
      kind: 'model_down', severity: 'warning',
      title: failing.length === 1
        ? `${failing[0]} on ${this._name(providerId)} marked failing after failed health checks`
        : `${failing.length} models on ${this._name(providerId)} marked failing after failed health checks: ${shown}`,
      detail: upstream.down.get(failing.at(-1)!) ?? '',
      ...common,
    }, { journal: false, update: upstream.announced });
    upstream.announced = true;
    upstream.announcedServices = new Set(failing);
  }
}
