/**
 * Request headers with an underscore in the name, kept by the Caddy in front
 * of the gateway.
 *
 * Caddy (2.11.4 and later) drops every such header before it reaches the
 * gateway, unless the header is listed in the server's
 * `expected_underscore_headers`. The gateway owner lists the names in the
 * gateway's settings; the gateway writes them into Caddy's running config
 * through Caddy's admin API, which needs no root. Caddy's running config goes
 * back to its Caddyfile whenever Caddy restarts or reloads, so the gateway
 * checks it again every minute and puts the list back.
 *
 * Keeping `x_name` makes Caddy drop `x-name` (Caddy does so to keep the two
 * from being confused), so nothing is kept unless the owner asks for it.
 */

import type { UnderscoreHeadersStatus } from './console-api/types.js'
import type { GatewayStore } from './store.js'

/** The names the owner listed (null: never set). */
export const UNDERSCORE_HEADERS_SETTING = 'underscoreHeaders'
/** The gateway's last report of applying them, for the console and CLI. */
export const UNDERSCORE_HEADERS_STATUS_SETTING = 'underscoreHeadersStatus'
export const CADDY_ADMIN_URL_ENV = 'ANTSEED_GATEWAY_CADDY_ADMIN_URL'
export const DEFAULT_CADDY_ADMIN_URL = 'http://127.0.0.1:2019'
export const MAX_UNDERSCORE_HEADERS = 50
const MAX_HEADER_NAME_LENGTH = 100
const SYNC_INTERVAL_MS = 60_000
const ADMIN_TIMEOUT_MS = 5_000

/** HTTP token characters, at least one underscore, no dot, and `*` only as a trailing prefix wildcard. */
const HEADER_NAME = /^[a-z0-9!#$%&'+^`|~_-]+\*?$/

export function underscoreHeaderNames(store: GatewayStore): string[] | null {
  const names = store.getSetting<unknown>(UNDERSCORE_HEADERS_SETTING)
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : null
}

export function underscoreHeadersStatus(store: GatewayStore): UnderscoreHeadersStatus {
  return store.getSetting<UnderscoreHeadersStatus>(UNDERSCORE_HEADERS_STATUS_SETTING)
    ?? { state: 'off', reason: null, server: null, since: null }
}

/**
 * Lower-cased, de-duplicated header names, or an error naming the first bad
 * one. Each must contain an underscore: Caddy keeps every other name anyway.
 */
export function normalizeUnderscoreHeaderNames(names: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of names) {
    const name = raw.trim().toLowerCase()
    if (!name) continue
    if (name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME.test(name)) {
      throw new Error(`"${raw.trim()}" is not a header name (letters, digits and - _ only, an optional trailing *)`)
    }
    if (!name.replace(/\*$/, '').includes('_')) {
      throw new Error(`"${raw.trim()}" has no underscore; Caddy already passes it through`)
    }
    if (!out.includes(name)) out.push(name)
  }
  if (out.length > MAX_UNDERSCORE_HEADERS) throw new Error(`at most ${MAX_UNDERSCORE_HEADERS} header names`)
  return out
}

/** The hyphenated name Caddy drops once `name` is kept (`x_name` → `x-name`). */
export function hyphenTwin(name: string): string {
  return name.replace(/_/g, '-')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a Caddy upstream `dial` address is this machine on `port`. */
function dialsLocalPort(dial: unknown, port: number): boolean {
  if (typeof dial !== 'string') return false
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d+)$/.exec(dial.trim().toLowerCase())
  return match !== null && Number(match[1]) === port
}

/** Whether a route list, at any depth of subroutes, reverse-proxies to this machine on `port`. */
function routesProxyTo(routes: unknown, port: number): boolean {
  if (!Array.isArray(routes)) return false
  return routes.some((route) => isObject(route) && Array.isArray(route['handle']) && route['handle'].some((handler) => {
    if (!isObject(handler)) return false
    if (handler['handler'] === 'reverse_proxy') {
      const upstreams = handler['upstreams']
      return Array.isArray(upstreams) && upstreams.some((upstream) => isObject(upstream) && dialsLocalPort(upstream['dial'], port))
    }
    return handler['handler'] === 'subroute' && routesProxyTo(handler['routes'], port)
  }))
}

/** The name of the Caddy server whose routes forward to the gateway's `port`, from Caddy's `apps/http/servers` config. */
export function findGatewayServer(servers: unknown, port: number): string | null {
  if (!isObject(servers)) return null
  for (const [name, server] of Object.entries(servers)) {
    if (isObject(server) && routesProxyTo(server['routes'], port)) return name
  }
  return null
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map((name) => name.toLowerCase()))
  const right = new Set(b.map((name) => name.toLowerCase()))
  return left.size === right.size && [...left].every((name) => right.has(name))
}

class AdminError extends Error {
  constructor(message: string, readonly unreachable = false) {
    super(message)
  }
}

export interface CaddyUnderscoreHeadersOptions {
  /** The port the gateway listens on; Caddy's site for the gateway forwards to it. */
  port: number
  /** The names to keep, or null when the owner never set any: the gateway then leaves Caddy's list alone. An empty list removes it. */
  names: () => string[] | null
  adminUrl?: string
  fetch?: typeof fetch
  now?: () => number
  log?: (message: string) => void
  /** Called when the state, reason or server changes. */
  onChange?: (status: UnderscoreHeadersStatus) => void
}

/** Keeps Caddy's `expected_underscore_headers` for the gateway's site equal to the gateway's setting. */
export class CaddyUnderscoreHeaders {
  private readonly _adminUrl: string
  private readonly _fetch: typeof fetch
  private readonly _now: () => number
  private _timer: NodeJS.Timeout | null = null
  private _running: Promise<UnderscoreHeadersStatus> | null = null
  private _status: UnderscoreHeadersStatus = { state: 'off', reason: null, server: null, since: null }

  constructor(private readonly _options: CaddyUnderscoreHeadersOptions) {
    this._adminUrl = (_options.adminUrl ?? process.env[CADDY_ADMIN_URL_ENV] ?? DEFAULT_CADDY_ADMIN_URL).replace(/\/+$/, '')
    this._fetch = _options.fetch ?? fetch
    this._now = _options.now ?? Date.now
  }

  get status(): UnderscoreHeadersStatus {
    return { ...this._status }
  }

  start(): void {
    if (this._timer) return
    void this.sync()
    this._timer = setInterval(() => { void this.sync() }, SYNC_INTERVAL_MS)
    this._timer.unref()
  }

  stop(): void {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  /** Checks Caddy now and applies the setting; concurrent calls share one run. */
  sync(): Promise<UnderscoreHeadersStatus> {
    this._running ??= this._sync().finally(() => { this._running = null })
    return this._running
  }

  private async _sync(): Promise<UnderscoreHeadersStatus> {
    const names = this._options.names()
    if (names === null) return this._set('off', null, null)
    const previous = this._status.state
    try {
      const server = findGatewayServer(await this._request('GET', '/config/apps/http/servers'), this._options.port)
      if (!server) {
        return this._set('unavailable', `no Caddy site forwards to port ${this._options.port}`, null)
      }
      const path = `/config/apps/http/servers/${encodeURIComponent(server)}/expected_underscore_headers`
      const current = await this._request('GET', path)
      const kept = Array.isArray(current) ? current.filter((name): name is string => typeof name === 'string') : null
      if (names.length === 0) {
        if (kept !== null) await this._request('DELETE', path)
        return this._set('off', null, server)
      }
      if (kept === null || !sameNames(kept, names)) {
        // PUT creates the key; PATCH replaces an existing one (POST would append to it).
        await this._request(kept === null ? 'PUT' : 'PATCH', path, names)
        this._options.log?.(`[gateway] Caddy keeps underscore headers: ${names.join(', ')}`)
      }
      return this._set('applied', null, server)
    } catch (error) {
      const unreachable = error instanceof AdminError && error.unreachable
      const reason = unreachable
        ? `Caddy's admin API is not reachable at ${this._adminUrl}`
        : `Caddy refused the change: ${error instanceof Error ? error.message : String(error)}`
      if (previous !== (unreachable ? 'unavailable' : 'error')) this._options.log?.(`[gateway] underscore headers not applied: ${reason}`)
      return this._set(unreachable ? 'unavailable' : 'error', reason, null)
    }
  }

  private _set(state: UnderscoreHeadersStatus['state'], reason: string | null, server: string | null): UnderscoreHeadersStatus {
    const before = this._status
    if (before.since === null || before.state !== state || before.reason !== reason || before.server !== server) {
      this._status = { state, reason, server, since: this._now() }
      this._options.onChange?.(this.status)
    }
    return this.status
  }

  private async _request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this._fetch(`${this._adminUrl}${path}`, {
        method,
        // fetch sends Sec-Fetch-Mode like a browser, and Caddy then requires an
        // allowed Origin; its admin endpoint's own origin is allowed by default.
        headers: { origin: new URL(this._adminUrl).origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      })
    } catch {
      throw new AdminError('unreachable', true)
    }
    const text = await response.text()
    if (!response.ok) {
      let message = text.trim()
      try {
        const parsed = JSON.parse(text) as unknown
        if (isObject(parsed) && typeof parsed['error'] === 'string') message = parsed['error']
      } catch { /* not JSON */ }
      throw new AdminError(`HTTP ${response.status}${message ? `: ${message.slice(0, 200)}` : ''}`)
    }
    if (!text.trim()) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  }
}
