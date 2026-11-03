import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { appendSetCookie, readCookie, serializeCookie } from '../gateway/auth/http.js'
import type { ConsoleDeps } from '../gateway/console-api/deps.js'
import { ConsoleError, respond, type ConsoleAuth, type ConsoleRouter, type Principal } from '../gateway/console-api/router.js'
import { createConsoleApi } from '../gateway/console-api/server.js'
import type { MeResponse } from '../gateway/console-api/types.js'
import type { GatewayStore } from '../gateway/store.js'
import { sellerRouteRegistrar, type SellerRouteOptions } from './routes.js'
import { createSellerUpdates } from './updates.js'
import { registerUpdateRoutes } from '../gateway/console-api/handlers/update.js'
import type { GatewayUpdates } from '../gateway/updates.js'
import type { NetworkLoad } from './network.js'
import type { VerificationChecks } from './promote.js'
import type { SellerRestartOption } from './service.js'

const SESSION_COOKIE = 'antseed_seller_dashboard'
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600
/** The only principal this server hands out: the seller's operator, like an admin management token. */
const SELLER_PRINCIPAL: Principal = { kind: 'token', tokenId: 'seller-dashboard', scope: 'admin' }

export interface SellerDashboardOptions {
  dataDir: string
  /** The seller's config file, edited from the Settings and Alerts panels. */
  configPath: string
  env?: NodeJS.ProcessEnv
  /** Outbound fetch for alert tests and the Telegram chat finder (tests point it at a stub). */
  fetch?: typeof fetch
  /** Test and demo hooks; the defaults read the live network and chain. */
  network?: () => Promise<NetworkLoad>
  standing?: SellerRouteOptions['standing']
  explorerUrl?: SellerRouteOptions['explorerUrl']
  verificationChecks?: VerificationChecks
  /** Update checks (tests pass their own). */
  updates?: GatewayUpdates
  /** The link token to keep (48 hex characters), so sessions and the link survive a restart; a fresh one otherwise. */
  token?: string
  /** Restart from the dashboard (the one `seller start` serves). */
  restart?: SellerRestartOption
  version: string
  host?: string
  port?: number
  /** Built console web app; defaults to the @antseed/gateway-console package's dist. */
  distDir?: string
  log?: (message: string) => void
}

export interface SellerDashboardServer {
  /** Opens the dashboard: the console swaps the token in its fragment for a session cookie. */
  url: string
  close(): Promise<void>
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * `antseed seller dashboard`: the gateway console's web app in seller-only
 * mode. The URL the CLI prints carries a per-run token in its fragment; the
 * console posts it once for an HttpOnly session cookie, and every API call needs that cookie (or
 * `Authorization: Bearer <token>`). Only the `/seller/*` routes are mounted:
 * status and history, plus the seller's own settings and alerts. Browser
 * writes carry the console's CSRF header like every console write.
 */
export async function startSellerDashboard(options: SellerDashboardOptions): Promise<SellerDashboardServer> {
  const host = options.host ?? '127.0.0.1'
  const log = options.log ?? (() => {})
  const token = options.token && /^[0-9a-f]{48}$/.test(options.token) ? options.token : randomBytes(24).toString('hex')
  // A session is `<expiry>.<nonce>.<mac>`, signed with the link token: it outlives a restart that keeps the token
  // (a restart from the dashboard), and a copied cookie stops working when the browser's would.
  const signSession = (expiresAt: number, nonce: string) => createHmac('sha256', token).update(`seller-session:${expiresAt}:${nonce}`).digest('hex')
  // Sessions signed out, by nonce, with when they would have expired: kept in the data dir, since sessions outlive a restart.
  const signedOutPath = join(options.dataDir, 'seller-dashboard-signed-out.json')
  const signedOut = readSignedOut(signedOutPath)
  const validSession = (cookie: string | undefined): boolean => {
    const [expiry, nonce, mac] = (cookie ?? '').split('.')
    const expiresAt = Number(expiry)
    if (!nonce || !mac || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || signedOut.has(nonce)) return false
    return sameSecret(mac, signSession(expiresAt, nonce))
  }
  // Cookies are scoped by host and path, not port: each dashboard (one per data dir) gets its own name, so two open side by side keep their sessions.
  // Named by data dir and link token: a restart keeps both (and the cookie), while another dashboard on the same data dir has its own.
  const sessionCookie = `${SESSION_COOKIE}_${createHash('sha256').update(`${options.dataDir}\n${token}`).digest('hex').slice(0, 12)}`
  const me: MeResponse = { kind: 'seller', me: { dataDir: options.dataDir, version: options.version } }

  const auth: ConsoleAuth = {
    async authenticate(req) {
      const header = req.headers.authorization ?? ''
      if (header.startsWith('Bearer ') && sameSecret(header.slice(7), token)) return SELLER_PRINCIPAL
      return validSession(readCookie(req, sessionCookie) ?? undefined) ? SELLER_PRINCIPAL : null
    },
    registerRoutes(router: ConsoleRouter) {
      // The console posts the token from the link's fragment, so it never sits in a query string, a request log or browser history.
      router.add('POST', '/auth/seller', async ({ body, raw, res }) => {
        const offered = body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string' ? (body as { token: string }).token : ''
        if (!sameSecret(offered, token)) return respond(401, { error: { code: 'unauthorized', message: 'This dashboard link is not valid. Use the URL `antseed seller dashboard` printed.' } })
        const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000
        const nonce = randomBytes(12).toString('hex')
        const session = `${expiresAt}.${nonce}.${signSession(expiresAt, nonce)}`
        appendSetCookie(res, serializeCookie(raw, sessionCookie, session, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS, path: '/console', sameSite: 'Strict' }))
        return respond(204)
      }, { public: true })
      // Public so a browser without a session learns why (the console shows "open the dashboard link").
      router.add('GET', '/auth/me', async ({ principal }) => {
        if (!principal) throw new ConsoleError(401, 'seller_link_required', 'Open the link `antseed seller dashboard` printed')
        return me
      }, { public: true })
      router.add('POST', '/auth/logout', async ({ raw, res }) => {
        appendSetCookie(res, serializeCookie(raw, sessionCookie, '', { maxAgeSeconds: 0, path: '/console', sameSite: 'Strict' }))
        // Until this dashboard stops; a signed-out cookie is also cleared in the browser.
        const nonce = readCookie(raw, sessionCookie)?.split('.')[1]
        const expiresAt = Number(readCookie(raw, sessionCookie)?.split('.')[0])
        if (nonce && Number.isSafeInteger(expiresAt)) {
          signedOut.set(nonce, expiresAt)
          for (const [id, until] of signedOut) if (until <= Date.now()) signedOut.delete(id)
          writeSignedOut(signedOutPath, signedOut)
        }
        return respond(204)
      }, { allow: ['token'] })
    },
    revokeMemberSessions() {},
    revokeKeySessions() {},
    async me() { return me },
  }

  const deps: ConsoleDeps = {
    // Seller-only mode mounts no route that reads the gateway store.
    store: null as unknown as GatewayStore,
    dataDir: options.dataDir,
    configPath: '',
    buyerPort: 0,
    controlSecret: '',
    publicUrl: null,
    version: options.version,
    now: () => Date.now(),
    log,
    // The gateway's update check and routes, shown but never installed from here (see sellerUpdates).
    // No log: `seller start` already announces new versions.
    updates: options.updates ?? createSellerUpdates({ dataDir: options.dataDir, current: options.version }),
  }
  const api = createConsoleApi(deps, auth, [registerUpdateRoutes, sellerRouteRegistrar({
    ...(options.network ? { network: () => options.network } : {}),
    ...(options.standing ? { standing: options.standing } : {}),
    ...(options.explorerUrl ? { explorerUrl: options.explorerUrl } : {}),
    ...(options.verificationChecks ? { verificationChecks: options.verificationChecks } : {}),
    ...(options.restart ? { restart: options.restart } : {}),
    dataDir: () => options.dataDir,
    configPath: () => options.configPath,
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })], options.distDir ? { distDir: options.distDir } : {})

  const server = http.createServer((req, res) => {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://seller.local').pathname
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad request')
      return
    }
    if (path === '/' || path === '/console' || path === '/console/') {
      res.writeHead(302, { location: '/console/seller' })
      res.end()
      return
    }
    void api.handle(req, res).then((handled) => {
      if (handled) return
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
    }).catch((error: unknown) => {
      log(`seller dashboard: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const { port } = server.address() as AddressInfo
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    url: `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}/console/seller#seller-token=${token}`,
    close: () => {
      // Stop listening and drop open connections, so a stalled request never holds up the caller (a stopping seller).
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      deps.updates?.stop()
      return closed
    },
  }
}

function readSignedOut(path: string): Map<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return new Map(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > Date.now()))
  } catch {
    return new Map()
  }
}

function writeSignedOut(path: string, signedOut: Map<string, number>): void {
  try {
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(Object.fromEntries(signedOut)), { mode: 0o600 })
    renameSync(temp, path)
  } catch {
    // A data dir that cannot be written keeps the sign-out until this dashboard stops.
  }
}
