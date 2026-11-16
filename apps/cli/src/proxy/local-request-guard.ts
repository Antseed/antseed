import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'

/**
 * Keeps the buyer proxy reachable only by what runs on this machine.
 *
 * Binding to 127.0.0.1 stops remote hosts, but a web page in the user's
 * browser can still send requests to loopback: directly (a cross-site
 * `fetch`/form POST, which needs no CORS preflight for a simple request) or
 * through DNS rebinding (a page whose own hostname now resolves to
 * 127.0.0.1). The proxy spends from the buyer's deposit and changes saved
 * routing state, so neither may reach it.
 *
 * - Host must be a loopback name or an IP literal. A rebound page sends its
 *   own hostname; an IP literal cannot be rebound (WSL relays reach the
 *   proxy through the host's gateway IP).
 * - A browser request must come from a local page: an Origin header, when
 *   present, must be loopback or file://, and `Sec-Fetch-Site: cross-site`
 *   without such an Origin (no-cors GETs carry no Origin) is refused.
 *
 * Non-browser clients (CLI tools, SDKs) send a loopback Host and no Origin,
 * so they are unaffected. Local front doors that forward other clients' requests
 * (API-key gateway, system proxy) drop the browser headers first: they decide
 * on their own who may call them.
 */
export function nonLocalRequestReason(headers: IncomingHttpHeaders): string | null {
  const host = headers.host
  if (host !== undefined && !isLoopbackHost(host) && !isIpLiteralHost(host)) return 'Host is neither a loopback name nor an IP address'

  const origin = headers.origin
  if (origin !== undefined) {
    return isLocalOrigin(origin) ? null : 'Origin is not a local page'
  }
  const fetchSite = headers['sec-fetch-site']
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return 'cross-site browser request'
  return null
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 or `[::1]`, with or without a port. */
export function isLoopbackHost(value: string): boolean {
  const hostname = hostnameOf(value.trim().toLowerCase())
  if (hostname === null) return false
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '::1') return true
  return /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/** An IP address (any), with or without a port: no DNS name to rebind. */
export function isIpLiteralHost(value: string): boolean {
  const hostname = hostnameOf(value.trim().toLowerCase())
  return hostname !== null && isIP(hostname) !== 0
}

/** Headers a browser adds about the page making the request; front doors drop them before forwarding. */
export function isBrowserContextHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'origin' || lower === 'referer' || lower.startsWith('sec-fetch-')
}

/** A loopback http(s) page, or a local file. `null` (sandboxed frames, opaque origins) is not local. */
export function isLocalOrigin(origin: string): boolean {
  const value = origin.trim().toLowerCase()
  if (value === 'file://') return true
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.host)
}

/** Host header to bare hostname (`[::1]:8377` → `::1`); null when malformed. */
function hostnameOf(host: string): string | null {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end < 0) return null
    const rest = host.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return null
    return host.slice(1, end)
  }
  const parts = host.split(':')
  if (parts.length > 2) return null
  if (parts.length === 2 && !/^\d+$/.test(parts[1]!)) return null
  return parts[0] || null
}
