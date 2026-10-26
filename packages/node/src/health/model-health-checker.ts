import type { Provider, ServiceHealthStatus, UpstreamAccountStatus } from '../interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { isNativeVideoProtocol, isRoutingProtocol, type ServiceApiProtocol } from '../types/service-api.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { isLiveResponseOutOfCredit, isUpstreamOutOfCredit } from './upstream-credit.js';

/** Default sweep interval. Each sweep sends one 1-token probe per advertised service. */
export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5 * 60_000;
/** Consecutive probe failures before a service is unadvertised. */
export const DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD = 3;
/** Per-probe timeout. A model that hangs this long is treated as failing. */
export const DEFAULT_HEALTH_CHECK_PROBE_TIMEOUT_MS = 60_000;

export interface ModelHealthTarget {
  /**
   * The provider whose advertised `services` array is managed. Must be the
   * same object (or share the same `services` array) as the one registered
   * with the node, so removals propagate to both request matching and
   * announced metadata.
   */
  provider: Provider;
  /**
   * Provider used to execute probes. Pass the unwrapped provider when the
   * registered one is wrapped (e.g. AntAgentProvider) so a 1-token probe
   * doesn't run a full agent loop. Defaults to `provider`.
   */
  probeProvider?: Provider;
  /**
   * The seller config's name for this provider instance. Several instances
   * can share a plugin and so a `provider.name` (four upstreams on the openai
   * plugin); this tells them apart in snapshots and events. Defaults to `provider.name`.
   */
  id?: string;
}

export interface ModelHealthEvent {
  provider: string;
  /** The target's `id` (the configured provider name). */
  providerId: string;
  service: string;
  status: 'removed' | 'restored';
  consecutiveFailures: number;
  /** Short description of the most recent probe outcome. */
  detail: string;
}

/**
 * An upstream account's credit changed: out of credit (an HTTP 402 or a
 * billing error from a probe, an account check or a live request), below the
 * low-balance line (from the account check), or funded again.
 */
export interface UpstreamAccountEvent {
  provider: string;
  /** The target's `id` (the configured provider name). */
  providerId: string;
  status: 'out_of_credit' | 'low_balance' | 'funded';
  /** The upstream's error, or the balance read. */
  detail: string;
  /** USD balance, when the provider can read it. */
  balanceUsd: number | null;
  /** The upstream's services (advertised or withdrawn). */
  services: string[];
}

export interface ServiceHealthSnapshot {
  provider: string;
  /** The target's `id` (the configured provider name). */
  providerId: string;
  service: string;
  advertised: boolean;
  consecutiveFailures: number;
  lastProbeAt: number | null;
  lastStatusCode: number | null;
  lastDetail: string | null;
}

export interface ModelHealthCheckerConfig {
  targets: ModelHealthTarget[];
  intervalMs?: number;
  failureThreshold?: number;
  probeTimeoutMs?: number;
  /**
   * Invoked after a service is unadvertised or restored. Callers should
   * re-sign seller metadata here (e.g. `node.refreshSellerMetadata()`).
   */
  onChange?: (event: ModelHealthEvent) => void | Promise<void>;
  /** Invoked when an upstream account runs out of credit, drops below `lowBalanceUsd`, or is funded again. */
  onUpstreamAccount?: (event: UpstreamAccountEvent) => void | Promise<void>;
  /** Invoked after each sweep, so changes from one round can be reported together. */
  onSweepComplete?: () => void;
  /** USD balance under which a provider that reads its balance reports `low_balance`; a function is read on every check. */
  lowBalanceUsd?: number | (() => number | undefined);
}

type AccountState = 'out' | 'low' | 'ok';

type ProbeOutcome = 'healthy' | 'unhealthy' | 'inconclusive';

interface ServiceHealthState {
  /** The provider instance this state belongs to (several can share a name, e.g. four upstreams on the openai plugin). */
  provider: Provider;
  providerName: string;
  providerId: string;
  service: string;
  consecutiveFailures: number;
  removed: boolean;
  removedAtIndex: number;
  lastProbeAt: number | null;
  lastStatusCode: number | null;
  lastDetail: string | null;
}

/**
 * Periodically probes every advertised service with a minimal (1-token)
 * completion and unadvertises services that fail repeatedly, so buyers stop
 * discovering models the seller cannot actually serve. Removed services keep
 * being probed and are re-advertised on the first healthy probe.
 *
 * Removal mutates `provider.services` in place — the same array reference the
 * announcer and the seller request handler read live — so it takes effect on
 * the next `/metadata` fetch and the next incoming request. If every service
 * is removed, `provider.healthCheckAvailable` becomes false so discovery omits
 * the provider instead of treating its empty service list as a wildcard.
 */
export class ModelHealthChecker {
  private readonly _targets: ModelHealthTarget[];
  private readonly _intervalMs: number;
  private readonly _failureThreshold: number;
  private readonly _probeTimeoutMs: number;
  private readonly _onChange: ModelHealthCheckerConfig['onChange'];
  private readonly _states = new Map<string, ServiceHealthState>();
  /** Stable per-instance ids: providers are told apart by instance, not by name. */
  private readonly _providerIds = new Map<Provider, number>();
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _sweepInFlight: Promise<void> | null = null;
  private _stopped = false;
  private readonly _onUpstreamAccount: ModelHealthCheckerConfig['onUpstreamAccount'];
  private readonly _lowBalanceUsd: ModelHealthCheckerConfig['lowBalanceUsd'];
  private readonly _onSweepComplete: ModelHealthCheckerConfig['onSweepComplete'];
  /** Each upstream's credit as last seen; unset until something said. */
  private readonly _accounts = new Map<Provider, AccountState>();
  /** Services withdrawn before `onChange` could be told; reported on the first start. */
  private _withdrawnAtInit: ServiceHealthState[] = [];

  constructor(config: ModelHealthCheckerConfig) {
    this._targets = config.targets;
    this._intervalMs = config.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this._failureThreshold = Math.max(1, config.failureThreshold ?? DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD);
    this._probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_HEALTH_CHECK_PROBE_TIMEOUT_MS;
    this._onChange = config.onChange;
    this._onUpstreamAccount = config.onUpstreamAccount;
    this._lowBalanceUsd = config.lowBalanceUsd;
    this._onSweepComplete = config.onSweepComplete;
    // Providers retained after an OAuth initialization failure must pass a real
    // probe before any service is advertised. Keep their services in recovery
    // state rather than dropping the provider permanently.
    for (const { provider } of this._targets) {
      if (provider.healthCheckAvailable !== false) continue;
      for (const [index, service] of provider.services.entries()) {
        const state = this._stateFor(provider, service);
        state.removed = true;
        state.removedAtIndex = index;
        state.lastDetail = 'Awaiting successful probe after initialization failure';
        this._withdrawnAtInit.push(state);
      }
      provider.services.splice(0);
    }
  }

  /** Start periodic sweeps. The first sweep runs immediately (async). */
  start(): void {
    if (this._timer) return;
    this._stopped = false;
    for (const state of this._withdrawnAtInit.splice(0)) {
      if (!state.removed) continue;
      this._emitChange({
        provider: state.providerName,
        providerId: state.providerId,
        service: state.service,
        status: 'removed',
        consecutiveFailures: state.consecutiveFailures,
        detail: state.lastDetail ?? 'initialization failed',
      });
    }
    void this.runSweep();
    this._timer = setInterval(() => {
      void this.runSweep();
    }, this._intervalMs);
    // Never keep the process alive just for health checks.
    this._timer.unref?.();
  }

  stop(): void {
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Probe every advertised (and previously removed) service once. */
  async runSweep(): Promise<void> {
    if (this._sweepInFlight) return this._sweepInFlight;
    this._sweepInFlight = this._runSweep().finally(() => {
      this._sweepInFlight = null;
      if (this._stopped || !this._onSweepComplete) return;
      try {
        this._onSweepComplete();
      } catch (err) {
        debugWarn(`[ModelHealth] onSweepComplete failed: ${err instanceof Error ? err.message : err}`);
      }
    });
    return this._sweepInFlight;
  }

  getSnapshot(): ServiceHealthSnapshot[] {
    return Array.from(this._states.values()).map((state) => ({
      provider: state.providerName,
      providerId: state.providerId,
      service: state.service,
      advertised: !state.removed,
      consecutiveFailures: state.consecutiveFailures,
      lastProbeAt: state.lastProbeAt,
      lastStatusCode: state.lastStatusCode,
      lastDetail: state.lastDetail,
    }));
  }

  private async _runSweep(): Promise<void> {
    for (const target of this._targets) {
      if (this._stopped) return;
      const provider = target.provider;

      // Don't compete with paying buyers for concurrency slots.
      try {
        const capacity = provider.getCapacity();
        if (capacity.current >= capacity.max) {
          debugLog(`[ModelHealth] Skipping ${provider.name}: at capacity (${capacity.current}/${capacity.max})`);
          continue;
        }
      } catch {
        // getCapacity should not throw; probe anyway if it does.
      }

      // Probe currently advertised services plus ones we removed earlier
      // (so they can recover). Snapshot before iterating — probes mutate
      // the live array on state transitions.
      const services = new Set<string>(provider.services);
      for (const state of this._states.values()) {
        if (state.provider === provider && state.removed) {
          services.add(state.service);
        }
      }

      const hasFreeCheck = (candidate?: Provider) => Boolean(candidate?.checkServiceHealth || candidate?.checkUpstreamAccount);
      const checkProvider = hasFreeCheck(target.probeProvider) ? target.probeProvider! : provider;
      const checked = hasFreeCheck(checkProvider)
        ? [...services].filter((service) => !supportsHealthProbe(resolveProbeProtocol(provider, service)))
        : [];
      if (checked.length > 0) {
        await this._checkServices(target, checkProvider, checked);
      }
      for (const service of services) {
        if (this._stopped) return;
        if (checked.includes(service)) continue;
        await this._probeService(target, service);
      }
    }
  }

  /**
   * Run the provider's free checks for services the probe skips: the
   * upstream account check (key valid, account funded) once, and the model
   * check (model still offered) for every service. A service is unavailable
   * when either check says so, and available only when no check is unsure.
   * `unavailable` counts as a failed check, `available` re-advertises,
   * `unknown` changes nothing.
   */
  private async _checkServices(target: ModelHealthTarget, checkProvider: Provider, services: string[]): Promise<void> {
    const provider = target.provider;
    const timed = <T>(label: string, check: () => Promise<T>) => withTimeout(
      Promise.resolve().then(check),
      this._probeTimeoutMs,
      `${label} for ${provider.name} timed out after ${this._probeTimeoutMs}ms`,
    );
    const [account, models] = await Promise.all([
      checkProvider.checkUpstreamAccount
        ? timed('account check', () => checkProvider.checkUpstreamAccount!())
          .catch((err): UpstreamAccountStatus => ({ status: 'unknown', reason: `account check failed: ${err instanceof Error ? err.message : err}` }))
        : undefined,
      checkProvider.checkServiceHealth
        ? timed('model check', () => checkProvider.checkServiceHealth!(services)).catch(() => null)
        : undefined,
    ]);
    const balance = account?.status === 'available' ? account.balanceUsd : undefined;
    if (account?.status === 'unavailable' && (account.outOfCredit === true || isUpstreamOutOfCredit(null, account.reason))) {
      this._setAccount(provider, 'out', account.reason, null);
    } else if (account?.status === 'available') {
      const low = this._lowLine();
      if (balance !== undefined && low !== undefined && balance < low) this._setAccount(provider, 'low', `Balance $${balance.toFixed(2)}, under $${low.toFixed(2)}`, balance);
      else this._setAccount(provider, 'ok', balance === undefined ? 'Account check passed' : `Balance $${balance.toFixed(2)}`, balance ?? null);
    }
    const combine = (service: string): UpstreamAccountStatus => {
      const model: ServiceHealthStatus | undefined = models === undefined
        ? undefined
        : models?.[service] ?? { status: 'unknown', reason: 'model check gave no result' };
      const results = [account, model].filter((result): result is UpstreamAccountStatus => result !== undefined);
      return results.find((result) => result.status === 'unavailable')
        ?? results.find((result) => result.status === 'unknown')
        ?? { status: 'available', balanceUsd: balance };
    };
    for (const service of services) {
      if (this._stopped) return;
      const result = combine(service);
      const state = this._stateFor(provider, service);
      if (result.status === 'unknown') {
        debugLog(`[ModelHealth] ${provider.name}/${service}: inconclusive (${result.reason ?? 'no result'})`);
        continue;
      }
      state.lastProbeAt = Date.now();
      state.lastStatusCode = null;
      if (result.status === 'unavailable') {
        state.lastDetail = result.reason;
        this._recordFailure(provider, state);
        continue;
      }
      state.consecutiveFailures = 0;
      if (!state.removed) continue;
      state.lastDetail = balance === undefined ? 'Account check passed' : `Account check passed (balance $${balance.toFixed(2)})`;
      this._restoreService(provider, state);
    }
  }

  private _stateFor(provider: Provider, service: string): ServiceHealthState {
    let id = this._providerIds.get(provider);
    if (id === undefined) {
      id = this._providerIds.size;
      this._providerIds.set(provider, id);
    }
    const key = `${id}\0${service}`;
    let state = this._states.get(key);
    if (!state) {
      state = {
        provider,
        providerName: provider.name,
        providerId: this._targets.find((target) => target.provider === provider)?.id ?? provider.name,
        service,
        consecutiveFailures: 0,
        removed: false,
        removedAtIndex: 0,
        lastProbeAt: null,
        lastStatusCode: null,
        lastDetail: null,
      };
      this._states.set(key, state);
    }
    return state;
  }

  private async _probeService(target: ModelHealthTarget, service: string): Promise<void> {
    const provider = target.provider;
    const probeProvider = target.probeProvider ?? provider;
    const state = this._stateFor(provider, service);
    state.lastProbeAt = Date.now();

    let outcome: ProbeOutcome;
    let errorText: string | null = null;
    try {
      const protocol = resolveProbeProtocol(provider, service);
      if (!supportsHealthProbe(protocol)) {
        state.lastStatusCode = null;
        state.lastDetail = `Skipped health probe for unsupported protocol ${protocol}`;
        debugLog(`[ModelHealth] ${provider.name}/${service}: ${state.lastDetail}`);
        return;
      }
      const request = buildHealthProbeRequest(service, protocol);
      const response = await withTimeout(
        probeProvider.handleRequest(request),
        this._probeTimeoutMs,
        `health probe for ${service} timed out after ${this._probeTimeoutMs}ms`,
      );
      state.lastStatusCode = response.statusCode;
      outcome = classifyProbeStatus(response.statusCode);
      // Classified on the body itself, not the 200-byte summary: a billing code can follow a long message.
      if (outcome !== 'healthy') errorText = decodeBody(response.body, 16_384);
      state.lastDetail = outcome === 'healthy'
        ? `HTTP ${response.statusCode}`
        : `HTTP ${response.statusCode}: ${summarizeBody(response.body)}`;
    } catch (err) {
      state.lastStatusCode = null;
      state.lastDetail = err instanceof Error ? err.message : String(err);
      errorText = state.lastDetail;
      outcome = 'unhealthy';
    }

    // A billing error is a failure whatever its status (Anthropic answers one with a 400).
    if (outcome !== 'healthy' && isUpstreamOutOfCredit(state.lastStatusCode, errorText)) {
      outcome = 'unhealthy';
      this._setAccount(provider, 'out', state.lastDetail ?? 'out of credit', null);
    }
    if (outcome === 'inconclusive') {
      // The endpoint answered but the probe result proves nothing either way
      // (for example, 400 for an unsupported probe parameter). Leave failure
      // counters and advertisement untouched.
      debugLog(`[ModelHealth] ${provider.name}/${service}: inconclusive (${state.lastDetail})`);
      return;
    }

    if (outcome === 'healthy') {
      // An answered completion means the account pays again (its balance is unknown here).
      if (this._accounts.get(provider) === 'out') this._setAccount(provider, 'ok', state.lastDetail ?? 'probe succeeded', null);
      state.consecutiveFailures = 0;
      if (state.removed) {
        this._restoreService(provider, state);
      }
      return;
    }

    this._recordFailure(provider, state);
  }

  /**
   * A live request's upstream answer (the seller's own traffic): an out-of-credit
   * error is reported at once instead of waiting for the probes, and a billable
   * success after one means the account pays again (polling or downloading a
   * video already paid for is not billable and proves nothing).
   */
  reportUpstreamResponse(provider: Provider, statusCode: number, body: string, billable = true): void {
    const target = this._targets.find((entry) => entry.provider === provider || entry.probeProvider === provider);
    if (!target || this._stopped) return;
    if (statusCode >= 400 && isLiveResponseOutOfCredit(statusCode, body)) {
      this._setAccount(target.provider, 'out', `HTTP ${statusCode}: ${summarizeBody(new TextEncoder().encode(body))}`, null);
    } else if (statusCode < 400 && billable && this._accounts.get(target.provider) === 'out') {
      this._setAccount(target.provider, 'ok', `HTTP ${statusCode} on a request`, null);
    }
  }

  private _lowLine(): number | undefined {
    const value = typeof this._lowBalanceUsd === 'function' ? this._lowBalanceUsd() : this._lowBalanceUsd;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /** Records an upstream's credit and reports a change; the first reading of a funded account is not a change. */
  private _setAccount(provider: Provider, next: AccountState, detail: string, balanceUsd: number | null): void {
    const previous = this._accounts.get(provider);
    if (previous === next) return;
    this._accounts.set(provider, next);
    if (next === 'ok' && previous === undefined) return;
    const target = this._targets.find((entry) => entry.provider === provider);
    const services = [...new Set([...provider.services, ...[...this._states.values()].filter((state) => state.provider === provider).map((state) => state.service)])];
    const event: UpstreamAccountEvent = {
      provider: provider.name,
      providerId: target?.id ?? provider.name,
      status: next === 'out' ? 'out_of_credit' : next === 'low' ? 'low_balance' : 'funded',
      detail,
      balanceUsd,
      services,
    };
    debugWarn(`[ModelHealth] ${event.providerId}: upstream ${event.status} (${detail})`);
    if (!this._onUpstreamAccount) return;
    try {
      const result = this._onUpstreamAccount(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => debugWarn(`[ModelHealth] onUpstreamAccount failed: ${err instanceof Error ? err.message : err}`));
      }
    } catch (err) {
      debugWarn(`[ModelHealth] onUpstreamAccount failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private _recordFailure(provider: Provider, state: ServiceHealthState): void {
    state.consecutiveFailures += 1;
    debugWarn(
      `[ModelHealth] ${provider.name}/${state.service}: health check failed `
      + `(${state.consecutiveFailures}/${this._failureThreshold}) — ${state.lastDetail}`,
    );
    if (!state.removed && state.consecutiveFailures >= this._failureThreshold) {
      this._removeService(provider, state);
    }
  }

  private _removeService(provider: Provider, state: ServiceHealthState): void {
    const services = provider.services;
    const index = services.indexOf(state.service);
    if (index < 0) {
      // Already gone (removed externally) — track it as removed so it can recover.
      state.removed = true;
      if (services.length === 0) {
        provider.healthCheckAvailable = false;
      }
      return;
    }
    services.splice(index, 1);
    state.removed = true;
    state.removedAtIndex = index;
    if (services.length === 0) {
      provider.healthCheckAvailable = false;
    }
    this._emitChange({
      provider: provider.name,
      providerId: state.providerId,
      service: state.service,
      status: 'removed',
      consecutiveFailures: state.consecutiveFailures,
      detail: state.lastDetail ?? 'probe failed',
    });
  }

  private _restoreService(provider: Provider, state: ServiceHealthState): void {
    const services = provider.services;
    state.removed = false;
    if (!services.includes(state.service)) {
      services.splice(Math.min(state.removedAtIndex, services.length), 0, state.service);
    }
    provider.healthCheckAvailable = true;
    this._emitChange({
      provider: provider.name,
      providerId: state.providerId,
      service: state.service,
      status: 'restored',
      consecutiveFailures: 0,
      detail: state.lastDetail ?? 'probe succeeded',
    });
  }

  private _emitChange(event: ModelHealthEvent): void {
    const action = event.status === 'removed' ? 'unadvertised' : 're-advertised';
    debugLog(`[ModelHealth] ${event.provider}/${event.service} ${action} (${event.detail})`);
    if (!this._onChange) return;
    try {
      const result = this._onChange(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          debugWarn(`[ModelHealth] onChange failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    } catch (err) {
      debugWarn(`[ModelHealth] onChange failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Pick the probe request shape from the service's advertised API protocol. */
function resolveProbeProtocol(provider: Provider, service: string): ServiceApiProtocol {
  return provider.serviceApiProtocols?.[service]?.[0] ?? 'openai-chat-completions';
}

export function supportsHealthProbe(protocol: ServiceApiProtocol): boolean {
  return protocol !== 'openai-images' && !isRoutingProtocol(protocol) && !isNativeVideoProtocol(protocol);
}

/**
 * Build the cheapest request that proves the upstream model responds: a
 * single-token completion. Sent through `Provider.handleRequest`, so the
 * relay's service alias rewrites and auth handling apply — the probe
 * validates exactly what buyers would hit.
 */
export function buildHealthProbeRequest(service: string, protocol: ServiceApiProtocol): SerializedHttpRequest {
  let path: string;
  let body: Record<string, unknown>;
  switch (protocol) {
    case 'anthropic-messages':
      path = '/v1/messages';
      body = { model: service, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
      break;
    case 'openai-responses':
      path = '/v1/responses';
      // Use the canonical Responses message-list shape accepted by adapters
      // and strict upstreams. The API also rejects max_output_tokens below 16.
      body = {
        model: service,
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }],
        }],
        max_output_tokens: 16,
      };
      break;
    case 'openai-completions':
      path = '/v1/completions';
      body = { model: service, prompt: 'ping', max_tokens: 1 };
      break;
    case 'openai-chat-completions':
      path = '/v1/chat/completions';
      body = { model: service, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
      break;
    case 'typesafe-systemone':
      path = '/v1/systemone';
      // One tiny state and one yes/no question: a few input tokens, no
      // generated text.
      body = {
        model: service,
        state: 'ping',
        questions: { ok: { type: 'noul', instructions: 'Is the state the word ping?' } },
      };
      break;
    default:
      throw new Error(`Health probes are not supported for ${protocol} services`);
  }
  return {
    requestId: `health-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/**
 * Classify a probe response status.
 *
 * - 2xx/3xx — the model answered: healthy.
 * - 401/402/403/404, 429, and 5xx — credentials broken, billing unavailable,
 *   rate or usage limited, model gone, or upstream down: unhealthy. (The relay
 *   collapses upstream network errors/timeouts to 502.)
 * - Everything else (400, 422, ...) — the endpoint is alive but the probe
 *   itself was rejected (for example, an unsupported parameter): inconclusive,
 *   so a working model is never unadvertised over a probe quirk.
 */
export function classifyProbeStatus(statusCode: number): ProbeOutcome {
  if (statusCode >= 200 && statusCode < 400) return 'healthy';
  if (statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 404 || statusCode === 429) {
    return 'unhealthy';
  }
  if (statusCode >= 500) return 'unhealthy';
  return 'inconclusive';
}

function decodeBody(body: Uint8Array, maxBytes: number): string {
  try {
    return new TextDecoder().decode(body.slice(0, maxBytes));
  } catch {
    return '';
  }
}

function summarizeBody(body: Uint8Array): string {
  try {
    return new TextDecoder().decode(body.slice(0, 200)).replace(/\s+/g, ' ').trim() || '(empty body)';
  } catch {
    return '(unreadable body)';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
    // The losing probe promise may still reject later — don't let it surface
    // as an unhandled rejection.
    promise.catch(() => {});
  }
}
