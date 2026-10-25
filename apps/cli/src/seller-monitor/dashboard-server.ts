import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { appendSetCookie, readCookie, serializeCookie } from '../gateway/auth/http.js'
import type { ConsoleDeps } from '../gateway/console-api/deps.js'
import { ConsoleError, respond, type ConsoleAuth, type ConsoleRouter, type Principal } from '../gateway/console-api/router.js'
import { createConsoleApi } from '../gateway/console-api/server.js'
import type { MeResponse } from '../gateway/console-api/types.js'
import type { GatewayStore } from '../gateway/store.js'
import { sellerRouteRegistrar, type SellerRouteOptions } from './routes.js'
import type { NetworkLoad } from './network.js'
import type { VerificationChecks } from './promote.js'

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
  version: string
  host?: string
  port?: number
  /** Built console web app; defaults to the @antseed/gateway-console package's dist. */
  distDir?: string
  log?: (message: string) => void
}

export interface SellerDashboardServer {
  /** Opens the dashboard: exchanges the session token for a cookie, then shows the Seller page. */
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
 * mode. The URL the CLI prints carries a one-time-per-run token; opening it
 * sets an HttpOnly session cookie, and every API call needs that cookie (or
 * `Authorization: Bearer <token>`). Only the `/seller/*` routes are mounted:
 * status and history, plus the seller's own settings and alerts. Browser
 * writes carry the console's CSRF header like every console write.
 */
export async function startSellerDashboard(options: SellerDashboardOptions): Promise<SellerDashboardServer> {
  const host = options.host ?? '127.0.0.1'
  const log = options.log ?? (() => {})
  const token = randomBytes(24).toString('hex')
  const sessions = new Set<string>()
  const me: MeResponse = { kind: 'seller', me: { dataDir: options.dataDir, version: options.version } }

  const auth: ConsoleAuth = {
    async authenticate(req) {
      const header = req.headers.authorization ?? ''
      if (header.startsWith('Bearer ') && sameSecret(header.slice(7), token)) return SELLER_PRINCIPAL
      const cookie = readCookie(req, SESSION_COOKIE)
      return cookie && sessions.has(cookie) ? SELLER_PRINCIPAL : null
    },
    registerRoutes(router: ConsoleRouter) {
      router.add('GET', '/auth/seller', async ({ query, raw, res }) => {
        if (!sameSecret(query.get('token') ?? '', token)) return respond(401, { error: { code: 'unauthorized', message: 'This dashboard link is not valid. Use the URL `antseed seller dashboard` printed.' } })
        const session = randomBytes(24).toString('hex')
        sessions.add(session)
        appendSetCookie(res, serializeCookie(raw, SESSION_COOKIE, session, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS, path: '/console', sameSite: 'Strict' }))
        return respond(302, undefined, { headers: { location: '/console/seller' } })
      }, { public: true })
      // Public so a browser without a session learns why (the console shows "open the dashboard link").
      router.add('GET', '/auth/me', async ({ principal }) => {
        if (!principal) throw new ConsoleError(401, 'seller_link_required', 'Open the link `antseed seller dashboard` printed')
        return me
      }, { public: true })
      router.add('POST', '/auth/logout', async ({ raw }) => {
        const cookie = readCookie(raw, SESSION_COOKIE)
        if (cookie) sessions.delete(cookie)
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
  }
  const api = createConsoleApi(deps, auth, [sellerRouteRegistrar({
    ...(options.network ? { network: () => options.network } : {}),
    ...(options.standing ? { standing: options.standing } : {}),
    ...(options.explorerUrl ? { explorerUrl: options.explorerUrl } : {}),
    ...(options.verificationChecks ? { verificationChecks: options.verificationChecks } : {}),
    dataDir: () => options.dataDir,
    configPath: () => options.configPath,
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })], options.distDir ? { distDir: options.distDir } : {})

  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://seller.local').pathname
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
    url: `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}/console/api/auth/seller?token=${token}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
