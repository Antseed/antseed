import type { ServiceHealth, ServiceHealthReason, ServiceHealthSource, ServiceHealthState } from '../discovery/peer-metadata.js';
import type { Provider, ServiceHealthStatus, UpstreamAccountStatus } from '../interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { isNativeVideoProtocol, isRoutingProtocol, type ServiceApiProtocol } from '../types/service-api.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { isLiveResponseOutOfCredit, isUpstreamOutOfCredit } from './upstream-credit.js';

/** Default sweep interval. Each sweep sends one 1-token probe per service without recent buyer traffic. */
export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5 * 60_000;
/** Consecutive failed checks before a service is announced as failing. */
export const DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD = 3;
/** Per-probe timeout. A model that hangs this long is treated as failing. */
export const DEFAULT_HEALTH_CHECK_PROBE_TIMEOUT_MS = 60_000;
/** Shortest gap between probes triggered by failed buyer requests for one service. */
export const LIVE_FAILURE_PROBE_MIN_GAP_MS = 30_000;

export interface ModelHealthTarget {
  /**
   * The provider registered with the node. The checker publishes results on
   * its `serviceHealth`, which the announcer signs into metadata and the
   * request handler quotes in errors.
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
  /** `failing`: the service crossed the failure threshold; `recovered`: a check passed again. */
  status: 'failing' | 'recovered';
  consecutiveFailures: number;
  /** Why the service is failing (unset on recovery). */
  reason?: ServiceHealthReason;
  /** Short description of the most recent check outcome. Local only, never announced. */
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
  /** The upstream's services. */
  services: string[];
}

export interface ServiceHealthSnapshot {
  provider: string;
  /** The target's `id` (the configured provider name). */
  providerId: string;
  service: string;
  status: ServiceHealthState;
  consecutiveFailures: number;
  failingSince: number | null;
  reason: ServiceHealthReason | null;
  /** When the evidence behind `status` was gathered, and from where. */
  checkedAt: number | null;
  source: ServiceHealthSource | null;
  lastProbeAt: number | null;
  lastStatusCode: number | null;
  lastDetail: string | null;
  /** Last successful billable buyer request. */
  lastTrafficAt: number | null;
}

export interface ModelHealthCheckerConfig {
  targets: ModelHealthTarget[];
  intervalMs?: number;
  failureThreshold?: number;
  probeTimeoutMs?: number;
  /**
   * Invoked when a service starts failing or recovers. Callers should re-sign
   * seller metadata here (e.g. `node.refreshSellerMetadata()`).
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

interface TrackedService {
  /** The provider instance this state belongs to (several can share a name, e.g. four upstreams on the openai plugin). */
  provider: Provider;
  providerName: string;
  providerId: string;
  service: string;
  status: ServiceHealthState;
  consecutiveFailures: number;
  failingSince: number | null;
  reason: ServiceHealthReason | null;
  httpStatus: number | null;
  checkedAt: number | null;
  source: ServiceHealthSource | null;
  lastProbeAt: number | null;
  lastStatusCode: number | null;
  lastDetail: string | null;
  lastTrafficAt: number | null;
  probeInFlight: boolean;
}

class ProbeTimeoutError extends Error {}

/**
 * The seller's self health check. Every service stays announced; its latest
 * result is published on `provider.serviceHealth`, which goes into signed
 * metadata (v13+) so buyers can hide failing services from catalogs and
 * routing and explain why a pinned request failed.
 *
 * Buyer traffic is the main evidence: a successful billable response marks a
 * service healthy, and a service that had one within the last interval is not
 * probed. Idle services get a minimal (1-token) completion each interval, and
 * a failed buyer request triggers an early probe. A service is failing after
 * `failureThreshold` failed checks in a row and recovers on the first pass.
 */
export class ModelHealthChecker {
  private readonly _targets: ModelHealthTarget[];
  private readonly _intervalMs: number;
  private readonly _failureThreshold: number;
  private readonly _probeTimeoutMs: number;
  private readonly _onChange: ModelHealthCheckerConfig['onChange'];
  private readonly _states = new Map<string, TrackedService>();
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
  /** Services marked failing before `onChange` could be told; reported on the first start. */
  private _failingAtInit: TrackedService[] = [];

  constructor(config: ModelHealthCheckerConfig) {
    this._targets = config.targets;
    this._intervalMs = config.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this._failureThreshold = Math.max(1, config.failureThreshold ?? DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD);
    this._probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_HEALTH_CHECK_PROBE_TIMEOUT_MS;
    this._onChange = config.onChange;
    this._onUpstreamAccount = config.onUpstreamAccount;
    this._lowBalanceUsd = config.lowBalanceUsd;
    this._onSweepComplete = config.onSweepComplete;
    // Providers retained after an OAuth initialization failure stay announced
    // as failing until a real check passes.
    const now = Date.now();
    for (const { provider } of this._targets) {
      if (provider.healthCheckAvailable !== false) continue;
      for (const service of provider.services) {
        const state = this._stateFor(provider, service);
        state.status = 'failing';
        state.reason = 'init_failed';
        state.failingSince = now;
        state.checkedAt = now;
        state.source = 'probe';
        state.lastDetail = 'Initialization failed; awaiting a successful check';
        this._publish(state);
        this._failingAtInit.push(state);
      }
    }
  }

  /** Start periodic sweeps. The first sweep runs immediately (async). */
  start(): void {
    if (this._timer) return;
    this._stopped = false;
    for (const state of this._failingAtInit.splice(0)) {
      if (state.status !== 'failing') continue;
      this._emitChange({
        provider: state.providerName,
        providerId: state.providerId,
        service: state.service,
        status: 'failing',
        consecutiveFailures: state.consecutiveFailures,
        reason: 'init_failed',
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

  /** Check every service once, skipping probes for services with recent buyer traffic. */
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
      status: state.status,
      consecutiveFailures: state.consecutiveFailures,
      failingSince: state.failingSince,
      reason: state.reason,
      checkedAt: state.checkedAt,
      source: state.source,
      lastProbeAt: state.lastProbeAt,
      lastStatusCode: state.lastStatusCode,
      lastDetail: state.lastDetail,
      lastTrafficAt: state.lastTrafficAt,
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

      const services = [...provider.services];
      const hasFreeCheck = (candidate?: Provider) => Boolean(candidate?.checkServiceHealth || candidate?.checkUpstreamAccount);
      const checkProvider = hasFreeCheck(target.probeProvider) ? target.probeProvider! : provider;
      // Free checks also read the account balance, so they run even with traffic.
      const checked = hasFreeCheck(checkProvider)
        ? services.filter((service) => !supportsHealthProbe(resolveProbeProtocol(provider, service)))
        : [];
      if (checked.length > 0) {
        await this._checkServices(target, checkProvider, checked);
      }
      const now = Date.now();
      for (const service of services) {
        if (this._stopped) return;
        if (checked.includes(service)) continue;
        const state = this._stateFor(provider, service);
        if (state.lastTrafficAt !== null && now - state.lastTrafficAt < this._intervalMs) {
          debugLog(`[ModelHealth] ${provider.name}/${service}: skipping probe, served a buyer ${Math.round((now - state.lastTrafficAt) / 1000)}s ago`);
          continue;
        }
        await this._probeService(target, service);
      }
    }
  }

  /**
   * Run the provider's free checks for services the probe skips: the
   * upstream account check (key valid, account funded) once, and the model
   * check (model still offered) for every service. A service is unavailable
   * when either check says so, and available only when no check is unsure.
   * `unavailable` counts as a failed check, `available` as a pass,
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
    const accountOutOfCredit = account?.status === 'unavailable' && (account.outOfCredit === true || isUpstreamOutOfCredit(null, account.reason));
    if (accountOutOfCredit) {
      this._setAccount(provider, 'out', account.reason, null);
    } else if (account?.status === 'available') {
      const low = this._lowLine();
      // Without a balance, an answering account endpoint is no proof of credit: only a billable success clears "out".
      const unproven = balance === undefined && this._accounts.get(provider) === 'out';
      if (balance !== undefined && balance <= 0) this._setAccount(provider, 'out', `Balance $${balance.toFixed(2)}`, balance);
      else if (balance !== undefined && low !== undefined && balance < low) this._setAccount(provider, 'low', `Balance $${balance.toFixed(2)}, under $${low.toFixed(2)}`, balance);
      else if (!unproven) this._setAccount(provider, 'ok', balance === undefined ? 'Account check passed' : `Balance $${balance.toFixed(2)}`, balance ?? null);
    }
    const combine = (service: string): { result: UpstreamAccountStatus; reason: ServiceHealthReason } => {
      const model: ServiceHealthStatus | undefined = models === undefined
        ? undefined
        : models?.[service] ?? { status: 'unknown', reason: 'model check gave no result' };
      if (account?.status === 'unavailable') return { result: account, reason: accountOutOfCredit ? 'out_of_credit' : reasonForAccount(account.reason) };
      if (model?.status === 'unavailable') return { result: model, reason: 'model_unavailable' };
      const unsure = [account, model].find((result) => result?.status === 'unknown');
      return { result: unsure ?? { status: 'available', balanceUsd: balance }, reason: 'upstream_error' };
    };
    for (const service of services) {
      if (this._stopped) return;
      const { result, reason } = combine(service);
      const state = this._stateFor(provider, service);
      if (result.status === 'unknown') {
        debugLog(`[ModelHealth] ${provider.name}/${service}: inconclusive (${result.reason ?? 'no result'})`);
        continue;
      }
      state.lastProbeAt = Date.now();
      state.lastStatusCode = null;
      if (result.status === 'unavailable') {
        state.lastDetail = result.reason;
        this._recordFailure(state, reason, null);
        continue;
      }
      this._recordSuccess(state, 'probe', balance === undefined ? 'Account check passed' : `Account check passed (balance $${balance.toFixed(2)})`);
    }
  }

  private _stateFor(provider: Provider, service: string): TrackedService {
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
        status: 'unknown',
        consecutiveFailures: 0,
        failingSince: null,
        reason: null,
        httpStatus: null,
        checkedAt: null,
        source: null,
        lastProbeAt: null,
        lastStatusCode: null,
        lastDetail: null,
        lastTrafficAt: null,
        probeInFlight: false,
      };
      this._states.set(key, state);
    }
    return state;
  }

  private async _probeService(target: ModelHealthTarget, service: string): Promise<void> {
    const provider = target.provider;
    const probeProvider = target.probeProvider ?? provider;
    const state = this._stateFor(provider, service);
    if (state.probeInFlight) return;
    state.probeInFlight = true;
    state.lastProbeAt = Date.now();

    let outcome: ProbeOutcome;
    let reason: ServiceHealthReason;
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
      reason = reasonForStatus(response.statusCode);
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
      reason = err instanceof ProbeTimeoutError ? 'timeout' : 'unreachable';
    } finally {
      state.probeInFlight = false;
    }

    // A billing error is a failure whatever its status (Anthropic answers one with a 400);
    // a 404 or 422 is about the probe itself, so its text never marks the account.
    if (outcome !== 'healthy' && state.lastStatusCode !== 404 && state.lastStatusCode !== 422 && isUpstreamOutOfCredit(state.lastStatusCode, errorText)) {
      outcome = 'unhealthy';
      reason = 'out_of_credit';
      this._setAccount(provider, 'out', state.lastDetail ?? 'out of credit', null);
    }
    if (outcome === 'inconclusive') {
      // The endpoint answered but the probe result proves nothing either way
      // (for example, 400 for an unsupported probe parameter). Leave the
      // service's health untouched.
      debugLog(`[ModelHealth] ${provider.name}/${service}: inconclusive (${state.lastDetail})`);
      return;
    }

    if (outcome === 'healthy') {
      // An answered completion means the account pays again (its balance is unknown here).
      if (this._accounts.get(provider) === 'out') this._setAccount(provider, 'ok', state.lastDetail ?? 'probe succeeded', null);
      this._recordSuccess(state, 'probe', state.lastDetail ?? 'probe succeeded');
      return;
    }

    this._recordFailure(state, reason, state.lastStatusCode);
  }

  /**
   * A live request's upstream answer (the seller's own traffic). A billable
   * success marks `service` healthy and spares it the next probe. A failure
   * the upstream is responsible for (auth, limits, 5xx) triggers an early
   * probe instead of counting directly, so one buyer's odd request cannot mark
   * a service failing. An out-of-credit error is reported at once, and a
   * billable success after one means the account pays again (polling or
   * downloading a video already paid for is not billable and proves nothing).
   */
  reportUpstreamResponse(provider: Provider, statusCode: number, body: string, billable = true, service?: string): void {
    const target = this._findTarget(provider);
    if (!target || this._stopped) return;
    if (statusCode >= 400 && isLiveResponseOutOfCredit(statusCode, body)) {
      this._setAccount(target.provider, 'out', `HTTP ${statusCode}: ${summarizeBody(new TextEncoder().encode(body))}`, null);
    } else if (statusCode < 400 && billable && this._accounts.get(target.provider) === 'out') {
      this._setAccount(target.provider, 'ok', `HTTP ${statusCode} on a request`, null);
    }
    if (!service || !target.provider.services.includes(service)) return;
    if (statusCode < 400) {
      if (!billable) return;
      const state = this._stateFor(target.provider, service);
      state.lastTrafficAt = Date.now();
      this._recordSuccess(state, 'traffic', `HTTP ${statusCode} on a buyer request`);
      return;
    }
    if (statusCode !== 404 && classifyProbeStatus(statusCode) === 'unhealthy') {
      this._probeSoon(target, service);
    }
  }

  /** A live request threw before the upstream answered (network error, timeout). */
  reportUpstreamFailure(provider: Provider, service: string): void {
    const target = this._findTarget(provider);
    if (!target || this._stopped || !target.provider.services.includes(service)) return;
    this._probeSoon(target, service);
  }

  /** The announced health of `service`, if it has been checked. */
  getServiceHealth(provider: Provider, service: string): ServiceHealth | undefined {
    const target = this._findTarget(provider);
    return target?.provider.serviceHealth?.[service];
  }

  private _findTarget(provider: Provider): ModelHealthTarget | undefined {
    return this._targets.find((entry) => entry.provider === provider || entry.probeProvider === provider);
  }

  private _probeSoon(target: ModelHealthTarget, service: string): void {
    // Image and video services are never probed (a probe would cost a real generation).
    if (!supportsHealthProbe(resolveProbeProtocol(target.provider, service))) return;
    const state = this._stateFor(target.provider, service);
    if (state.probeInFlight) return;
    if (state.lastProbeAt !== null && Date.now() - state.lastProbeAt < LIVE_FAILURE_PROBE_MIN_GAP_MS) return;
    debugLog(`[ModelHealth] ${target.provider.name}/${service}: buyer request failed upstream, probing now`);
    void this._probeService(target, service).catch((err) => {
      debugWarn(`[ModelHealth] early probe failed: ${err instanceof Error ? err.message : err}`);
    });
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
    const event: UpstreamAccountEvent = {
      provider: provider.name,
      providerId: target?.id ?? provider.name,
      status: next === 'out' ? 'out_of_credit' : next === 'low' ? 'low_balance' : 'funded',
      detail,
      balanceUsd,
      services: [...provider.services],
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

  private _recordSuccess(state: TrackedService, source: ServiceHealthSource, detail: string): void {
    const wasFailing = state.status === 'failing';
    state.status = 'healthy';
    state.consecutiveFailures = 0;
    state.failingSince = null;
    state.reason = null;
    state.httpStatus = null;
    state.checkedAt = Date.now();
    state.source = source;
    state.lastDetail = detail;
    if (state.provider.healthCheckAvailable === false) state.provider.healthCheckAvailable = true;
    this._publish(state);
    if (!wasFailing) return;
    this._emitChange({
      provider: state.providerName,
      providerId: state.providerId,
      service: state.service,
      status: 'recovered',
      consecutiveFailures: 0,
      detail,
    });
  }

  private _recordFailure(state: TrackedService, reason: ServiceHealthReason, httpStatus: number | null): void {
    const now = Date.now();
    state.consecutiveFailures += 1;
    state.reason = reason;
    state.httpStatus = httpStatus;
    state.failingSince ??= now;
    debugWarn(
      `[ModelHealth] ${state.providerName}/${state.service}: health check failed `
      + `(${state.consecutiveFailures}/${this._failureThreshold}, ${reason}) — ${state.lastDetail}`,
    );
    const crossed = state.status !== 'failing' && state.consecutiveFailures >= this._failureThreshold;
    if (crossed) state.status = 'failing';
    // Below the threshold the announced status and its evidence stand; only
    // a failing status is backed by this check.
    if (state.status !== 'failing') return;
    state.checkedAt = now;
    state.source = 'probe';
    this._publish(state);
    if (!crossed) return;
    this._emitChange({
      provider: state.providerName,
      providerId: state.providerId,
      service: state.service,
      status: 'failing',
      consecutiveFailures: state.consecutiveFailures,
      reason,
      detail: state.lastDetail ?? 'check failed',
    });
  }

  /** Writes the announced form of `state` onto the provider. */
  private _publish(state: TrackedService): void {
    const health: ServiceHealth = { status: state.status };
    if (state.checkedAt !== null) health.checkedAt = state.checkedAt;
    if (state.source !== null) health.source = state.source;
    if (state.status === 'failing') {
      if (state.failingSince !== null) health.failingSince = state.failingSince;
      if (state.consecutiveFailures > 0) health.consecutiveFailures = Math.min(0xffff, state.consecutiveFailures);
      if (state.reason !== null) health.reason = state.reason;
      if (state.httpStatus !== null && state.httpStatus >= 100 && state.httpStatus <= 599) health.httpStatus = state.httpStatus;
    }
    state.provider.serviceHealth ??= {};
    state.provider.serviceHealth[state.service] = health;
  }

  private _emitChange(event: ModelHealthEvent): void {
    debugLog(`[ModelHealth] ${event.provider}/${event.service} ${event.status === 'failing' ? 'marked failing' : 'recovered'} (${event.detail})`);
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

/** The announced reason for an account check that says the upstream cannot serve. */
function reasonForAccount(reason: string): ServiceHealthReason {
  if (/balance|credit|fund|top.?up|quota/i.test(reason)) return 'out_of_credit';
  if (/key|auth|credential|forbidden|permission|token/i.test(reason)) return 'auth';
  return 'upstream_error';
}

/** The announced reason for a failed check's upstream status. */
function reasonForStatus(statusCode: number): ServiceHealthReason {
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 402) return 'out_of_credit';
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode === 404) return 'model_unavailable';
  return 'upstream_error';
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
 *   so a working model is never marked failing over a probe quirk.
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
    timer = setTimeout(() => reject(new ProbeTimeoutError(message)), timeoutMs);
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
