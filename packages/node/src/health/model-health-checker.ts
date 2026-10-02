import type { Provider } from '../interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { isNativeVideoProtocol, type ServiceApiProtocol } from '../types/service-api.js';
import { debugLog, debugWarn } from '../utils/debug.js';

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
}

export interface ModelHealthEvent {
  provider: string;
  service: string;
  status: 'removed' | 'restored';
  consecutiveFailures: number;
  /** Short description of the most recent probe outcome. */
  detail: string;
}

export interface ServiceHealthSnapshot {
  provider: string;
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
}

type ProbeOutcome = 'healthy' | 'unhealthy' | 'inconclusive';

interface ServiceHealthState {
  providerName: string;
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
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _sweepInFlight: Promise<void> | null = null;
  private _stopped = false;

  constructor(config: ModelHealthCheckerConfig) {
    this._targets = config.targets;
    this._intervalMs = config.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this._failureThreshold = Math.max(1, config.failureThreshold ?? DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD);
    this._probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_HEALTH_CHECK_PROBE_TIMEOUT_MS;
    this._onChange = config.onChange;
  }

  /** Start periodic sweeps. The first sweep runs immediately (async). */
  start(): void {
    if (this._timer) return;
    this._stopped = false;
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
    });
    return this._sweepInFlight;
  }

  getSnapshot(): ServiceHealthSnapshot[] {
    return Array.from(this._states.values()).map((state) => ({
      provider: state.providerName,
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
        if (state.providerName === provider.name && state.removed) {
          services.add(state.service);
        }
      }

      for (const service of services) {
        if (this._stopped) return;
        await this._probeService(target, service);
      }
    }
  }

  private _stateFor(providerName: string, service: string): ServiceHealthState {
    const key = `${providerName}\0${service}`;
    let state = this._states.get(key);
    if (!state) {
      state = {
        providerName,
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
    const state = this._stateFor(provider.name, service);
    state.lastProbeAt = Date.now();

    let outcome: ProbeOutcome;
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
      state.lastDetail = outcome === 'healthy'
        ? `HTTP ${response.statusCode}`
        : `HTTP ${response.statusCode}: ${summarizeBody(response.body)}`;
    } catch (err) {
      state.lastStatusCode = null;
      state.lastDetail = err instanceof Error ? err.message : String(err);
      outcome = 'unhealthy';
    }

    if (outcome === 'inconclusive') {
      // The endpoint answered but the probe result proves nothing either way
      // (for example, 400 for an unsupported probe parameter). Leave failure
      // counters and advertisement untouched.
      debugLog(`[ModelHealth] ${provider.name}/${service}: inconclusive (${state.lastDetail})`);
      return;
    }

    if (outcome === 'healthy') {
      state.consecutiveFailures = 0;
      if (state.removed) {
        this._restoreService(provider, state);
      }
      return;
    }

    state.consecutiveFailures += 1;
    debugWarn(
      `[ModelHealth] ${provider.name}/${service}: probe failed `
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
  // Image generations cost real money per probe; everything else has a
  // near-free minimal request shape.
  return protocol !== 'openai-images' && !isNativeVideoProtocol(protocol);
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
