import type { TokenProvider } from '@antseed/node';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '@antseed/node';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/node';
import { swapAuthHeader, validateRequestService } from './auth-swap.js';
import Bottleneck from 'bottleneck';
import { stripRelayRequestHeaders, stripRelayResponseHeaders } from './http-headers.js';

export const DEFAULT_HTTP_TIMEOUT_MS = 5 * 60_000;

export interface RelayConfig {
  redirect?: 'error' | 'follow' | 'manual';
  baseUrl: string;
  authHeaderName: string;
  authHeaderValue: string;
  tokenProvider?: TokenProvider;
  extraHeaders?: Record<string, string>;
  extraHeadersProvider?: () => Promise<Record<string, string> | undefined>;
  maxConcurrency: number;
  allowedServices: string[];
  timeoutMs?: number;
  /** Lowercase header-name prefixes to strip before forwarding upstream. */
  stripHeaderPrefixes?: string[];
  /** Optional lowercase map: announced service -> upstream service. */
  serviceRewriteMap?: Record<string, string>;
  /** Fields to deep-merge into the JSON request body before forwarding upstream. */
  injectJsonFields?: Record<string, unknown>;
  /** If true, retry once with a force-refreshed token on 401. Only meaningful for providers with a refreshable tokenProvider (e.g. OAuth). */
  retryOn401?: boolean;
  /** Throttle settings for upstream requests (uses bottleneck). */
  throttle?: {
    /** Minimum time between requests in ms (e.g. 1000 = max 1 req/sec). */
    minTime?: number;
    /** Max concurrent requests to upstream. Overrides maxConcurrency for throttling purposes. */
    maxConcurrent?: number;
    /** Max requests in the reservoir per interval. */
    reservoir?: number;
    /** Reservoir refill interval in ms. */
    reservoirRefreshInterval?: number;
    /** How many requests to add on each refill. */
    reservoirRefreshAmount?: number;
  };
  /** Retry on 500/502/503/504 with exponential backoff. Default: 0 (no retries). */
  retryOn5xx?: number;
  /** Base delay in ms for 5xx retries. Default: 1000. */
  retryBaseDelayMs?: number;
  /** Additional status codes eligible for retry. */
  retryStatusCodes?: number[];
  /**
   * Rewrite request paths before forwarding upstream.
   * Keys are exact incoming paths, values are their replacements.
   * Applied before URL construction; first match wins.
   * Example: `{ "/v1/chat/completions": "/v4/chat/completions" }`
   */
  pathRewrite?: Record<string, string>;
  /**
   * Backup upstreams for the same services, tried in order when an earlier
   * upstream fails before anything reaches the buyer: a network error or
   * timeout, or a status in {@link FAILOVER_STATUS_CODES}. They share this
   * relay's headers, body injection and limits.
   */
  fallbackUpstreams?: RelayFallbackUpstream[];
}

export interface RelayFallbackUpstream {
  baseUrl: string;
  /** Auth header value for this upstream. Defaults to the primary upstream's credentials. */
  authHeaderValue?: string;
  /** Lowercase announced service -> upstream model here. Merged over the primary's map. */
  serviceRewriteMap?: Record<string, string>;
  /** Lowercase announced services this upstream serves. Omit to serve every service. */
  services?: string[];
  /** Path rewrites for this upstream. Defaults to the primary's. */
  pathRewrite?: Record<string, string>;
}

/**
 * Upstream statuses that move a request to the next upstream: auth, credit,
 * missing model, rate limit or quota, and server errors. Request errors such
 * as 400, 413 and 422 come from the buyer's request and are returned as-is.
 */
export const FAILOVER_STATUS_CODES: ReadonlySet<number> = new Set([401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529]);
/** How long a failed upstream is skipped for a service when it sent no Retry-After. */
export const DEFAULT_UPSTREAM_COOLDOWN_MS = 30_000;
const MAX_UPSTREAM_COOLDOWN_MS = 5 * 60_000;

interface ResolvedUpstream {
  baseUrl: string;
  /** null = the primary's credentials (static header or token provider). */
  authHeaderValue: string | null;
  serviceRewriteMap?: Record<string, string>;
  services: ReadonlySet<string> | null;
  pathRewrite?: Record<string, string>;
  primary: boolean;
}

export interface RelayCallbacks {
  onResponse: (response: SerializedHttpResponse) => void;
  onResponseChunk?: (chunk: SerializedHttpResponseChunk) => void;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && typeof out[key] === 'object' && out[key] !== null && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function getHeader(headers: Record<string, string>, name: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? '';
}

function multipartBoundary(contentType: string): string {
  const match = /^multipart\/form-data\s*;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType.trim());
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

function readMultipartTextField(body: Uint8Array, contentType: string, fieldName: string): string | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  const text = new TextDecoder('latin1').decode(body);
  const delimiter = `--${boundary}`;
  let index = text.indexOf(delimiter);
  while (index !== -1) {
    index += delimiter.length;
    if (text.startsWith('--', index)) break;
    const headerEnd = text.indexOf('\r\n\r\n', index);
    if (headerEnd === -1) break;
    const next = text.indexOf(`\r\n${delimiter}`, headerEnd + 4);
    if (next === -1) break;
    const headers = text.slice(index, headerEnd);
    const params = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(params)?.[1] ?? '';
    if (name === fieldName && !/filename\s*=/i.test(params)) {
      const raw = body.subarray(headerEnd + 4, next);
      return new TextDecoder().decode(raw).trim();
    }
    index = next + 2;
  }
  return null;
}

function setMultipartTextField(
  body: Uint8Array,
  contentType: string,
  fieldName: string,
  value: string,
): Uint8Array | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary || !/^[A-Za-z0-9_.-]+$/.test(fieldName)) return null;
  const text = new TextDecoder('latin1').decode(body);
  const delimiter = `--${boundary}`;
  let index = text.indexOf(delimiter);
  while (index !== -1) {
    index += delimiter.length;
    if (text.startsWith('--', index)) break;
    const headerEnd = text.indexOf('\r\n\r\n', index);
    if (headerEnd === -1) break;
    const next = text.indexOf(`\r\n${delimiter}`, headerEnd + 4);
    if (next === -1) break;
    const headers = text.slice(index, headerEnd);
    const params = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(params)?.[1] ?? '';
    if (name === fieldName && !/filename\s*=/i.test(params)) {
      const replacement = new TextEncoder().encode(value);
      const out = new Uint8Array(headerEnd + 4 + replacement.length + body.length - next);
      out.set(body.subarray(0, headerEnd + 4), 0);
      out.set(replacement, headerEnd + 4);
      out.set(body.subarray(next), headerEnd + 4 + replacement.length);
      return out;
    }
    index = next + 2;
  }

  const finalDelimiter = `${delimiter}--`;
  const finalIndex = text.lastIndexOf(finalDelimiter);
  if (finalIndex === -1) return null;
  const insertion = new TextEncoder().encode(
    `${delimiter}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`,
  );
  const out = new Uint8Array(finalIndex + insertion.length + body.length - finalIndex);
  out.set(body.subarray(0, finalIndex), 0);
  out.set(insertion, finalIndex);
  out.set(body.subarray(finalIndex), finalIndex + insertion.length);
  return out;
}

export class HttpRelay {
  private readonly _config: RelayConfig;
  private readonly _callbacks: RelayCallbacks;
  private readonly _validationServices: ReadonlySet<string>;
  private readonly _limiter: Bottleneck | null;
  private readonly _upstreams: ResolvedUpstream[];
  /** `${upstreamIndex}:${service}` -> time until which that upstream is tried last for the service. */
  private readonly _cooldownUntil = new Map<string, number>();
  private _activeCount = 0;

  constructor(config: RelayConfig, callbacks: RelayCallbacks) {
    this._config = config;
    this._callbacks = callbacks;
    this._limiter = config.throttle
      ? new Bottleneck({
          minTime: config.throttle.minTime,
          maxConcurrent: config.throttle.maxConcurrent,
          reservoir: config.throttle.reservoir,
          reservoirRefreshInterval: config.throttle.reservoirRefreshInterval,
          reservoirRefreshAmount: config.throttle.reservoirRefreshAmount,
        })
      : null;
    const rewriteValues = Object.values(config.serviceRewriteMap ?? {});
    this._validationServices = new Set([
      ...config.allowedServices.map((m) => m.trim().toLowerCase()),
      ...rewriteValues.map((m) => m.trim().toLowerCase()),
    ]);
    this._upstreams = [
      {
        baseUrl: config.baseUrl,
        authHeaderValue: null,
        serviceRewriteMap: config.serviceRewriteMap,
        services: null,
        pathRewrite: config.pathRewrite,
        primary: true,
      },
      ...(config.fallbackUpstreams ?? []).map((fallback): ResolvedUpstream => ({
        baseUrl: fallback.baseUrl,
        authHeaderValue: fallback.authHeaderValue ?? null,
        serviceRewriteMap: config.serviceRewriteMap || fallback.serviceRewriteMap
          ? { ...config.serviceRewriteMap, ...fallback.serviceRewriteMap }
          : undefined,
        services: fallback.services ? new Set(fallback.services.map((m) => m.trim().toLowerCase())) : null,
        pathRewrite: fallback.pathRewrite ?? config.pathRewrite,
        primary: false,
      })),
    ];
  }

  getActiveCount(): number {
    return this._activeCount;
  }

  private _sendError(requestId: string, statusCode: number, error: string): void {
    this._callbacks.onResponse({
      requestId,
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ error })),
    });
  }

  async handleRequest(request: SerializedHttpRequest): Promise<void> {
    // Validate service against pre-computed set (normalized at construction time).
    const validationError = validateRequestService(request, this._validationServices);
    if (validationError) {
      this._sendError(request.requestId, 403, validationError);
      return;
    }

    // Check concurrency
    if (this._activeCount >= this._config.maxConcurrency) {
      this._sendError(request.requestId, 429, 'Max concurrency reached');
      return;
    }

    // Increment active count
    this._activeCount++;

    try {
      const service = this._upstreams.length > 1 ? serviceOfRequest(request) : '';
      const candidates = this._candidateUpstreams(service);
      for (const [position, { upstream, index }] of candidates.entries()) {
        const isLast = position === candidates.length - 1;
        let attempt: UpstreamAttempt;
        try {
          attempt = await this._fetchUpstream(request, upstream);
        } catch (err) {
          if (isLast) throw err;
          this._coolDown(index, service, null);
          this._logFailover(service, upstream, candidates[position + 1]!.upstream, err instanceof Error ? err.message : String(err));
          continue;
        }
        if (!isLast && FAILOVER_STATUS_CODES.has(attempt.response.status)) {
          this._coolDown(index, service, attempt.response.headers.get('retry-after'));
          this._logFailover(service, upstream, candidates[position + 1]!.upstream, `HTTP ${attempt.response.status}`);
          await attempt.response.body?.cancel().catch(() => undefined);
          continue;
        }
        if (!isStreamingAttempt(attempt)) {
          // Buffer a complete response before delivering it, so a connection that
          // drops mid-body can still fail over: nothing has reached the buyer yet.
          try {
            attempt.body = new Uint8Array(await attempt.response.arrayBuffer());
          } catch (err) {
            if (isLast) throw err;
            this._coolDown(index, service, null);
            this._logFailover(service, upstream, candidates[position + 1]!.upstream, err instanceof Error ? err.message : String(err));
            continue;
          }
        }
        if (attempt.response.status < 400) {
          this._cooldownUntil.delete(`${index}:${service}`);
        }
        await this._deliver(request, attempt);
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const sanitized = errMsg.replace(/sk-ant-[a-zA-Z0-9_-]+/g, 'sk-***');
      this._sendError(request.requestId, 502, `Upstream error: ${sanitized}`);
    } finally {
      this._activeCount--;
    }
  }

  /** Upstreams that serve `service`, in configured order, with ones cooling down after a failure moved last. */
  private _candidateUpstreams(service: string): Array<{ upstream: ResolvedUpstream; index: number }> {
    const serving = this._upstreams
      .map((upstream, index) => ({ upstream, index }))
      .filter(({ upstream }) => upstream.services === null || upstream.services.has(service));
    if (serving.length <= 1) return serving;
    const now = Date.now();
    const cooling = (index: number) => (this._cooldownUntil.get(`${index}:${service}`) ?? 0) > now;
    return [
      ...serving.filter(({ index }) => !cooling(index)),
      ...serving.filter(({ index }) => cooling(index)),
    ];
  }

  private _coolDown(index: number, service: string, retryAfter: string | null): void {
    this._cooldownUntil.set(`${index}:${service}`, Date.now() + cooldownMs(retryAfter));
  }

  private _logFailover(service: string, from: ResolvedUpstream, to: ResolvedUpstream, reason: string): void {
    console.warn(
      `[http-relay] ${service || 'request'}: ${from.primary ? 'primary' : 'fallback'} upstream ${hostOf(from.baseUrl)} failed (${reason}); trying fallback ${hostOf(to.baseUrl)}`,
    );
  }

  private async _fetchUpstream(request: SerializedHttpRequest, upstream: ResolvedUpstream): Promise<UpstreamAttempt> {
    // Resolve dynamic auth token if provider uses OAuth / keychain
    let effectiveConfig: { authHeaderName: string; authHeaderValue: string; extraHeaders?: Record<string, string> } = {
      authHeaderName: this._config.authHeaderName,
      authHeaderValue: upstream.authHeaderValue ?? this._config.authHeaderValue,
      extraHeaders: this._config.extraHeaders,
    };
    if (upstream.authHeaderValue === null && this._config.tokenProvider) {
      const freshToken = await this._config.tokenProvider.getToken();
      // Preserve Bearer prefix for OAuth providers that use Authorization header
      const isBearer = this._config.authHeaderName === 'authorization';
      const headerValue = isBearer ? `Bearer ${freshToken}` : freshToken;
      effectiveConfig = { ...effectiveConfig, authHeaderValue: headerValue };
    }
    if (this._config.extraHeadersProvider) {
      const providedHeaders = await this._config.extraHeadersProvider();
      if (providedHeaders && Object.keys(providedHeaders).length > 0) {
        effectiveConfig = {
          ...effectiveConfig,
          extraHeaders: {
            ...(effectiveConfig.extraHeaders ?? {}),
            ...providedHeaders,
          },
        };
      }
    }

    // Swap auth headers
    let swappedRequest = swapAuthHeader(request, effectiveConfig);

    // Normalize the requested service into the upstream model for both JSON
    // and multipart Images API requests. Multipart edits otherwise bypass
    // alias rewriting and some upstreams report the model as missing.
    if (swappedRequest.method !== 'GET' && swappedRequest.method !== 'HEAD') {
      const contentType = getHeader(swappedRequest.headers, 'content-type');
      if (/^multipart\/form-data/i.test(contentType.trim())) {
        const requestedService = getHeader(swappedRequest.headers, 'x-antseed-service').trim()
          || readMultipartTextField(swappedRequest.body, contentType, 'service')
          || readMultipartTextField(swappedRequest.body, contentType, 'model')
          || '';
        if (requestedService) {
          const rewrittenService = upstream.serviceRewriteMap?.[requestedService.toLowerCase()]?.trim();
          const upstreamModel = rewrittenService || requestedService;
          const rewrittenBody = setMultipartTextField(swappedRequest.body, contentType, 'model', upstreamModel);
          if (rewrittenBody) swappedRequest = { ...swappedRequest, body: rewrittenBody };
        }
      } else {
        try {
          const decoded = JSON.parse(new TextDecoder().decode(swappedRequest.body)) as Record<string, unknown>;
          const transformed: Record<string, unknown> = { ...decoded };

          // Read from both "model" (upstream API compat) and "service" (native) fields
          const requestedService = (transformed.service ?? transformed.model) as string | undefined;

          if (upstream.serviceRewriteMap && typeof requestedService === 'string' && requestedService.trim().length > 0) {
            const rewrittenService = upstream.serviceRewriteMap[requestedService.trim().toLowerCase()];
            if (typeof rewrittenService === 'string' && rewrittenService.trim().length > 0) {
              transformed.model = rewrittenService.trim();
            }
          }

          // Normalize: if client sent "service" without "model", copy to "model" for upstream API compat.
          if (transformed.service !== undefined && transformed.model === undefined) {
            transformed.model = transformed.service;
          }
          // Remove the "service" field — upstream APIs don't understand it.
          delete transformed.service;

          // Force `stream_options.include_usage = true` on streaming OpenAI Chat
          // Completions requests. Without this, strict OpenAI-spec upstreams
          // (e.g. api.minimax.io) return SSE streams with no `usage` chunk,
          // which makes `parseResponseUsage` return zeros and causes the
          // seller to record `cost=0 (in=0 out=0)` for every request —
          // effectively giving away inference for free.
          //
          // We only touch `/v1/chat/completions` with `stream:true`, and we
          // preserve any caller-supplied `stream_options` fields. We don't
          // override an explicit `include_usage:false` (operators can still
          // disable via `injectJsonFields` below if they really need to).
          if (
            request.path.toLowerCase().startsWith('/v1/chat/completions')
            && transformed.stream === true
          ) {
            const existing = transformed.stream_options && typeof transformed.stream_options === 'object' && !Array.isArray(transformed.stream_options)
              ? transformed.stream_options as Record<string, unknown>
              : {};
            if (existing.include_usage === undefined) {
              transformed.stream_options = { ...existing, include_usage: true };
            }
          }

          const isImageRequest = request.path.toLowerCase().startsWith('/v1/images/');
          const merged = this._config.injectJsonFields && !isImageRequest
            ? deepMerge(transformed, this._config.injectJsonFields)
            : transformed;

          swappedRequest = { ...swappedRequest, body: new TextEncoder().encode(JSON.stringify(merged)) };
        } catch {
          // Not JSON — leave body unchanged
        }
      }
    }

    // Build upstream URL
    const base = upstream.baseUrl.replace(/\/+$/, '');
    let path = request.path.startsWith('/') ? request.path : `/${request.path}`;
    if (upstream.pathRewrite && path in upstream.pathRewrite) {
      path = upstream.pathRewrite[path]!;
    }
    const url = `${base}${path}`;

    // Build fetch headers, stripping hop-by-hop and provider-specific prefixes
    const stripPrefixes = this._config.stripHeaderPrefixes ?? [];
    const fetchHeaders = stripRelayRequestHeaders(swappedRequest.headers, {
      stripHeaderPrefixes: stripPrefixes,
    });

    const timeoutMs = this._config.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

    const doFetch = async (headers: Record<string, string>): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          redirect: this._config.redirect,
          method: swappedRequest.method,
          headers,
          body: swappedRequest.method !== 'GET' && swappedRequest.method !== 'HEAD'
            ? Buffer.from(swappedRequest.body)
            : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`Upstream request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };

    let currentHeaders = fetchHeaders;
    const maxRetries = this._config.retryOn5xx ?? 0;
    const baseDelay = this._config.retryBaseDelayMs ?? 1000;
    const retryableStatusCodes = new Set(this._config.retryStatusCodes ?? []);

    const runFetch = this._limiter
      ? (headers: Record<string, string>) => this._limiter!.schedule(() => doFetch(headers))
      : doFetch;

    const fetchWithRetries = async (): Promise<Response> => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          const delay = baseDelay * (2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        try {
          const response = await runFetch(currentHeaders);
          if (attempt === maxRetries || (response.status < 500 && !retryableStatusCodes.has(response.status))) {
            return response;
          }
        } catch (error) {
          lastError = error;
          if (attempt === maxRetries) {
            throw error;
          }
        }
      }

      throw (lastError instanceof Error ? lastError : new Error('Upstream request failed after retries'));
    };

    let fetchResponse = await fetchWithRetries();

    if (fetchResponse.status === 401 && upstream.authHeaderValue === null && this._config.retryOn401 && this._config.tokenProvider?.forceRefresh) {
      const refreshedToken = await this._config.tokenProvider.forceRefresh();
      const isBearer = this._config.authHeaderName === 'authorization';
      const newHeaderValue = isBearer ? `Bearer ${refreshedToken}` : refreshedToken;
      currentHeaders = { ...currentHeaders };
      currentHeaders[this._config.authHeaderName] = newHeaderValue;
      if (this._config.extraHeadersProvider) {
        const providedHeaders = await this._config.extraHeadersProvider();
        if (providedHeaders) {
          currentHeaders = {
            ...currentHeaders,
            ...providedHeaders,
          };
        }
      }
      fetchResponse = await fetchWithRetries();
    }

    return { response: fetchResponse, headers: currentHeaders, url };
  }

  private async _deliver(request: SerializedHttpRequest, attempt: UpstreamAttempt): Promise<void> {
    const { response: fetchResponse, url } = attempt;
    const isSSE = isStreamingAttempt(attempt);

    // Build response headers, stripping hop-by-hop and encoding headers.
    // Node.js fetch auto-decompresses gzip/br responses, so we must strip
    // content-encoding to prevent the client from double-decompressing.
    const responseHeaders = stripRelayResponseHeaders(fetchResponse);

    if (isSSE && fetchResponse.body) {
      responseHeaders[ANTSEED_STREAMING_RESPONSE_HEADER] = '1';
      this._callbacks.onResponse({
        requestId: request.requestId,
        statusCode: fetchResponse.status,
        headers: responseHeaders,
        body: new Uint8Array(0),
      });

      const reader = fetchResponse.body.getReader();
      let totalStreamBytes = 0;
      const debugChunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalStreamBytes += value.byteLength;
          if (totalStreamBytes <= 500) debugChunks.push(value);
          this._callbacks.onResponseChunk?.({
            requestId: request.requestId,
            data: value,
            done: false,
          });
        }
      } catch (err) {
        this._callbacks.onResponseChunk?.({
          requestId: request.requestId,
          data: new TextEncoder().encode(
            `event: error\ndata: ${err instanceof Error ? err.message : 'stream error'}\n\n`
          ),
          done: false,
        });
      }
      if (totalStreamBytes < 300) {
        const body = new TextDecoder().decode(
          debugChunks.reduce((a, b) => { const r = new Uint8Array(a.byteLength + b.byteLength); r.set(a); r.set(b, a.byteLength); return r; }, new Uint8Array(0))
        );
        let model = 'unknown';
        try { model = JSON.parse(new TextDecoder().decode(request.body))?.model ?? 'unknown'; } catch {}
        console.warn(`[http-relay] Short stream (${totalStreamBytes}b) model="${model}" url=${url}: ${JSON.stringify(body)}`);
      }

      this._callbacks.onResponseChunk?.({
        requestId: request.requestId,
        data: new Uint8Array(0),
        done: true,
      });
    } else {
      // Complete response
      const body = attempt.body ?? new Uint8Array(await fetchResponse.arrayBuffer());
      this._callbacks.onResponse({
        requestId: request.requestId,
        statusCode: fetchResponse.status,
        headers: responseHeaders,
        body,
      });
    }
  }
}

interface UpstreamAttempt {
  response: Response;
  headers: Record<string, string>;
  url: string;
  /** The complete response body, once buffered for a non-streaming response. */
  body?: Uint8Array;
}

function isStreamingAttempt({ response, headers }: UpstreamAttempt): boolean {
  if (!response.body) return false;
  const contentType = response.headers.get('content-type') ?? '';
  const acceptedSSE = (headers['accept'] ?? '').includes('text/event-stream');
  return contentType.includes('text/event-stream') || (acceptedSSE && !contentType && response.status >= 200 && response.status < 300);
}

/** Lowercase service named by a JSON or multipart request body, or '' when there is none. */
function serviceOfRequest(request: SerializedHttpRequest): string {
  if (request.method === 'GET' || request.method === 'HEAD') return '';
  const contentType = getHeader(request.headers, 'content-type');
  if (/^multipart\/form-data/i.test(contentType.trim())) {
    return (getHeader(request.headers, 'x-antseed-service').trim()
      || readMultipartTextField(request.body, contentType, 'service')
      || readMultipartTextField(request.body, contentType, 'model')
      || '').toLowerCase();
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown> | null;
    const service = decoded?.service ?? decoded?.model;
    return typeof service === 'string' ? service.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

function cooldownMs(retryAfter: string | null): number {
  const value = retryAfter?.trim();
  if (!value) return DEFAULT_UPSTREAM_COOLDOWN_MS;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return DEFAULT_UPSTREAM_COOLDOWN_MS;
  return Math.min(MAX_UPSTREAM_COOLDOWN_MS, Math.max(1000, ms));
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
