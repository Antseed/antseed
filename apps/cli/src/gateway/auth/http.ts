import type * as http from 'node:http'
import { isIP } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { respond, type ConsoleResponse } from '../console-api/router.js'

export const SESSION_COOKIE = 'antseed_console'
export const OIDC_STATE_COOKIE = 'antseed_console_oidc'

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '::1' || normalized.startsWith('127.')
}

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '')
  return bare === 'localhost' || isLoopbackAddress(bare)
}

/**
 * Client address for rate limiting, session records and the audit log.
 * Forwarding headers are trusted only from a loopback peer (Caddy /
 * cloudflared on the same host); from anyone else they are
 * client-controlled. `CF-Connecting-IP` additionally needs `trustCloudflare`
 * (the gateway runs behind its own Cloudflare tunnel, which overwrites it):
 * behind Caddy or ngrok a client could set it to anything.
 */
export function clientIp(req: http.IncomingMessage, options: { trustCloudflare?: boolean } = {}): string {
  const peer = req.socket?.remoteAddress ?? 'unknown'
  if (!isLoopbackAddress(peer)) return peer
  if (options.trustCloudflare) {
    const cf = headerValue(req, 'cf-connecting-ip')
    if (cf && isIP(cf)) return cf
  }
  const forwarded = headerValue(req, 'x-forwarded-for')
  if (forwarded) {
    // The local proxy appends the address it saw, so the last entry is the one we can trust.
    const last = forwarded.split(',').map((part) => part.trim()).filter(Boolean).pop()
    if (last && isIP(last)) return last
  }
  return peer
}

export function headerValue(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** Where the browser thinks it is: from publicUrl when set, else the request's Host (loopback peers only). */
export function requestOrigin(req: http.IncomingMessage, publicUrl: string | null): { origin: string; hostname: string; host: string } | null {
  if (publicUrl) {
    const url = new URL(publicUrl)
    return { origin: url.origin, hostname: url.hostname, host: url.host }
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) return null
  const host = headerValue(req, 'host')
  if (!host) return null
  let url: URL
  try {
    url = new URL(`${isEncrypted(req) || forwardedHttps(req) ? 'https' : 'http'}://${host}`)
  } catch {
    return null
  }
  return { origin: url.origin, hostname: url.hostname, host: url.host }
}

function isEncrypted(req: http.IncomingMessage): boolean {
  return Boolean((req.socket as TLSSocket).encrypted)
}

function forwardedHttps(req: http.IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && headerValue(req, 'x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
}

/** Cookies drop `Secure` only for plain http straight to a loopback address (`antseed gateway` on a laptop). */
function isPlainLoopbackHttp(req: http.IncomingMessage): boolean {
  if (isEncrypted(req) || forwardedHttps(req)) return false
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = headerValue(req, 'host')
  if (!host) return true
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

export function readCookie(req: http.IncomingMessage, name: string): string | null {
  const header = headerValue(req, 'cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim()
      return value.length > 0 ? value : null
    }
  }
  return null
}

export function serializeCookie(req: http.IncomingMessage, name: string, value: string, options: { maxAgeSeconds: number; path: string; sameSite: 'Strict' | 'Lax' }): string {
  const parts = [`${name}=${value}`, 'HttpOnly', `SameSite=${options.sameSite}`, `Path=${options.path}`, `Max-Age=${options.maxAgeSeconds}`]
  if (!isPlainLoopbackHttp(req)) parts.push('Secure')
  return parts.join('; ')
}

export function appendSetCookie(res: http.ServerResponse, cookie: string): void {
  const existing = res.getHeader('set-cookie')
  let list: string[] = []
  if (Array.isArray(existing)) list = existing
  else if (existing !== undefined) list = [String(existing)]
  res.setHeader('set-cookie', [...list, cookie])
}

export function isIpHostname(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
}

interface Window {
  limit: number
  ms: number
}

/**
 * Fixed-window counters per bucket (an IP or an account). In memory: limits
 * reset on restart, which is fine for slowing down guessing.
 */
export class RateLimiter {
  private readonly _hits = new Map<string, { windowStart: number; count: number }>()
  private _lastSweep = 0

  constructor(private readonly _windows: readonly Window[], private readonly _now: () => number) {}

  /** Records a hit; returns seconds to wait when any window is exhausted. */
  hit(bucket: string): number | null {
    const now = this._now()
    this._sweep(now)
    let retryAfterMs = 0
    for (const window of this._windows) {
      const key = `${window.ms}:${bucket}`
      let entry = this._hits.get(key)
      if (!entry || now - entry.windowStart >= window.ms) {
        entry = { windowStart: now, count: 0 }
        this._hits.set(key, entry)
      }
      entry.count += 1
      if (entry.count > window.limit) retryAfterMs = Math.max(retryAfterMs, entry.windowStart + window.ms - now)
    }
    return retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null
  }

  private _sweep(now: number): void {
    if (now - this._lastSweep < 60_000) return
    this._lastSweep = now
    const longest = Math.max(...this._windows.map((window) => window.ms))
    for (const [key, entry] of this._hits) {
      if (now - entry.windowStart >= longest) this._hits.delete(key)
    }
  }
}

export function rateLimited(retryAfterSeconds: number): ConsoleResponse {
  return respond(429, { error: { code: 'rate_limited', message: `Too many attempts. Try again in ${retryAfterSeconds} s.` } }, {
    headers: { 'retry-after': String(retryAfterSeconds) },
  })
}

export function redirect(res: http.ServerResponse, location: string): undefined {
  res.statusCode = 302
  res.setHeader('location', location)
  res.setHeader('cache-control', 'no-store')
  res.end()
  return undefined
}
