import { randomBytes } from 'node:crypto'
import type { ObservabilitySettings } from './console-api/types.js'
import { errorMessage } from './errors.js'
import type { GatewayStore } from './store.js'

export const OBSERVABILITY_SETTING = 'observability'

const MAX_QUEUE = 1_000
const MAX_BATCH = 100
const FLUSH_INTERVAL_MS = 1_000
const EXPORT_TIMEOUT_MS = 5_000
/** Content attributes are truncated to this many characters. */
const MAX_CONTENT_ATTRIBUTE = 16 * 1024

const DEFAULT_OBSERVABILITY: ObservabilitySettings = {
  otlpEndpoint: null,
  otlpHeaders: {},
  logContent: false,
  retentionDays: null,
}

export function observabilitySettings(store: GatewayStore): ObservabilitySettings {
  return { ...DEFAULT_OBSERVABILITY, ...(store.getSetting<Partial<ObservabilitySettings>>(OBSERVABILITY_SETTING) ?? {}) }
}

/** One finished gateway request, as exported. */
export interface RequestSpan {
  tag: string
  method: string
  path: string
  model: string | null
  status: number
  startedAt: number
  finishedAt: number
  keyId: string
  workspaceId: string
  memberId: string | null
  endUser: string | null
  sellerPeerId: string | null
  latencyMs: number | null
  requestBody?: string | null
  responseBody?: string | null
}

type Attribute = { key: string; value: { stringValue: string } | { intValue: string } }

function attr(key: string, value: string | number | null | undefined): Attribute[] {
  if (value === null || value === undefined) return []
  return [{ key, value: typeof value === 'number' ? { intValue: String(Math.trunc(value)) } : { stringValue: value } }]
}

export function tracesUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '')
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`
}

function spanToOtlp(span: RequestSpan, includeContent: boolean) {
  const nanos = (ms: number) => `${BigInt(Math.trunc(ms)) * 1_000_000n}`
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    name: `${span.method} ${span.path}`,
    kind: 2,
    startTimeUnixNano: nanos(span.startedAt),
    endTimeUnixNano: nanos(span.finishedAt),
    attributes: [
      ...attr('http.request.method', span.method),
      ...attr('url.path', span.path),
      ...attr('http.response.status_code', span.status),
      ...attr('gen_ai.request.model', span.model),
      ...attr('antseed.request.tag', span.tag),
      ...attr('antseed.key.id', span.keyId),
      ...attr('antseed.workspace.id', span.workspaceId),
      ...attr('antseed.member.id', span.memberId),
      ...attr('antseed.end_user', span.endUser),
      ...attr('antseed.seller.peer_id', span.sellerPeerId),
      ...attr('antseed.latency_ms', span.latencyMs),
      ...(includeContent ? attr('antseed.request.body', span.requestBody?.slice(0, MAX_CONTENT_ATTRIBUTE)) : []),
      ...(includeContent ? attr('antseed.response.body', span.responseBody?.slice(0, MAX_CONTENT_ATTRIBUTE)) : []),
    ],
    status: { code: span.status >= 400 ? 2 : 1 },
  }
}

/**
 * Fire-and-forget OTLP/HTTP JSON exporter: one span per finished request,
 * batched every second. The queue is bounded; when the collector is slow or
 * down, the oldest spans are dropped instead of growing memory.
 */
export class OtlpExporter {
  private _queue: RequestSpan[] = []
  private _timer: ReturnType<typeof setInterval> | null = null
  private _inFlight: Promise<void> | null = null
  dropped = 0

  constructor(
    private readonly _settings: () => ObservabilitySettings,
    private readonly _options: { fetchImpl?: typeof fetch; onLog?: (message: string) => void; flushIntervalMs?: number } = {},
  ) {}

  record(span: RequestSpan): void {
    if (!this._settings().otlpEndpoint) return
    if (this._queue.length >= MAX_QUEUE) {
      this._queue.shift()
      this.dropped += 1
    }
    this._queue.push(span)
    if (!this._timer) {
      this._timer = setInterval(() => void this.flush(), this._options.flushIntervalMs ?? FLUSH_INTERVAL_MS)
      this._timer.unref?.()
    }
  }

  /**
   * Sends one batch; while a full batch is still queued afterwards it keeps
   * going, so a burst drains instead of waiting one interval per batch.
   */
  async flush(): Promise<void> {
    if (this._inFlight) return this._inFlight
    await this._send()
    if (this._queue.length >= MAX_BATCH && this._settings().otlpEndpoint) await this.flush()
  }

  private async _send(): Promise<void> {
    const settings = this._settings()
    if (!settings.otlpEndpoint || this._queue.length === 0) {
      if (!settings.otlpEndpoint) this._queue = []
      return
    }
    const batch = this._queue.splice(0, MAX_BATCH)
    const payload = {
      resourceSpans: [{
        resource: { attributes: attr('service.name', 'antseed-gateway') },
        scopeSpans: [{ scope: { name: 'antseed-gateway' }, spans: batch.map((span) => spanToOtlp(span, settings.logContent)) }],
      }],
    }
    const fetchImpl = this._options.fetchImpl ?? fetch
    this._inFlight = fetchImpl(tracesUrl(settings.otlpEndpoint), {
      method: 'POST',
      headers: { ...settings.otlpHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    }).then((response) => {
      if (!response.ok) this._options.onLog?.(`otlp export failed: HTTP ${response.status}`)
    }).catch((error: unknown) => {
      this._options.onLog?.(`otlp export failed: ${errorMessage(error)}`)
    }).finally(() => { this._inFlight = null })
    return this._inFlight
  }

  /** Stops the timer and sends everything still queued. */
  async stop(): Promise<void> {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    if (this._inFlight) await this._inFlight
    while (this._queue.length > 0 && this._settings().otlpEndpoint) await this.flush()
    if (!this._settings().otlpEndpoint) this._queue = []
  }
}
