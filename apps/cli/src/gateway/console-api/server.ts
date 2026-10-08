import type * as http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { consoleDistDir } from '@antseed/gateway-console'
import { errorMessage } from '../errors.js'
import { PolicyProblemError } from '../services/context.js'
import type { ConsoleDeps } from './deps.js'
import { buyerAddressBook } from '../services/wallet-address.js'
import { ConsoleError, ConsoleRouter, type ConsoleAuth, type ConsoleResponse, type Principal, type Route } from './router.js'
import { CONSOLE_API_PATH, CONSOLE_BASE_PATH, CONSOLE_CSRF_HEADER } from './types.js'

/** JSON bodies on the console API are small; anything bigger is refused. */
const MAX_CONSOLE_BODY_BYTES = 1024 * 1024

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Wallet connections (WalletConnect relays, RPCs, Coinbase) need https: and
 * wss: for connect-src, and some wallet SDKs use https: iframes.
 */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
}

export type ConsoleRegistrar = (router: ConsoleRouter, deps: ConsoleDeps) => void

export interface ConsoleApi {
  /** Handles `/console` and `/console/api/*`; false for any other path. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>
  router: ConsoleRouter
}

function setCommonHeaders(res: http.ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('content-security-policy', CONSOLE_CSP)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

function sendApiError(res: http.ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } })
}

function isConsoleResponse(value: unknown): value is ConsoleResponse {
  return Boolean(value && typeof value === 'object' && (value as { __consoleResponse?: unknown }).__consoleResponse === true)
}

function bodyTooLarge(): ConsoleError {
  return new ConsoleError(413, 'request_too_large', `Request bodies are limited to ${MAX_CONSOLE_BODY_BYTES / 1024} KiB`)
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length']) > MAX_CONSOLE_BODY_BYTES) {
    req.resume()
    throw bodyTooLarge()
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_CONSOLE_BODY_BYTES) continue
    chunks.push(chunk as Buffer)
  }
  if (size > MAX_CONSOLE_BODY_BYTES) throw bodyTooLarge()
  if (size === 0) return undefined
  const contentType = req.headers['content-type'] ?? ''
  if (contentType && !contentType.includes('json')) throw new ConsoleError(415, 'unsupported_media_type', 'Send JSON')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ConsoleError(400, 'invalid_json', 'The request body is not valid JSON')
  }
}

function usesBearer(req: http.IncomingMessage): boolean {
  return (req.headers.authorization ?? '').startsWith('Bearer ')
}

/** Refuses a request the route or the principal does not allow. The body is drained first, since no handler reads it. */
function authorize(req: http.IncomingMessage, method: string, route: Route, principal: Principal | null): void {
  const refuse = (status: number, code: string, message: string): never => {
    req.resume()
    throw new ConsoleError(status, code, message)
  }
  if (!route.options.public) {
    if (!principal) return refuse(401, 'unauthorized', 'Sign in to continue')
    const allowed = route.options.allow ?? ['member', 'token']
    if (!allowed.includes(principal.kind)) refuse(403, 'forbidden', 'This route is not available to this session')
  }
  if (principal?.kind === 'token' && principal.scope === 'read' && method !== 'GET' && method !== 'HEAD') {
    refuse(403, 'read_only_token', 'This management token can only read')
  }
}

/** Writes a handler's result: nothing more after it wrote `res` itself, 204 for undefined, JSON or a `ConsoleResponse` otherwise. */
function sendResult(res: http.ServerResponse, result: unknown): void {
  if (result === undefined) {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
    }
    return
  }
  if (!isConsoleResponse(result)) {
    sendJson(res, 200, result)
    return
  }
  if (result.contentType && !result.contentType.includes('json')) {
    res.writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store', ...(result.headers ?? {}) })
    res.end(result.body === undefined ? undefined : String(result.body))
  } else if (result.body === undefined) {
    res.writeHead(result.status, { 'cache-control': 'no-store', ...(result.headers ?? {}) })
    res.end()
  } else {
    sendJson(res, result.status, result.body, result.headers)
  }
}

/**
 * The console's JSON API under `/console/api` and the web app under
 * `/console`. `registrars` mount the feature routes; `auth` mounts
 * `/auth/*` and resolves every request's principal. `sessions` on the deps
 * handed to registrars is filled from `auth` when not set.
 */
export function createConsoleApi(
  deps: ConsoleDeps,
  auth: ConsoleAuth,
  registrars: ConsoleRegistrar[],
  options: { distDir?: string } = {},
): ConsoleApi {
  const router = new ConsoleRouter()
  const routeDeps: ConsoleDeps = {
    ...deps,
    buyerAddresses: deps.buyerAddresses ?? buyerAddressBook(deps.buyerPort, deps.controlSecret),
    sessions: deps.sessions ?? {
      revokeMemberSessions: (memberId) => auth.revokeMemberSessions(memberId),
      revokeKeySessions: (keyId) => auth.revokeKeySessions(keyId),
    },
  }
  auth.registerRoutes(router)
  for (const register of registrars) register(router, routeDeps)
  const distDir = options.distDir ?? consoleDistDir

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    setCommonHeaders(res)
    const method = (req.method ?? 'GET').toUpperCase()
    const path = url.pathname.slice(CONSOLE_API_PATH.length) || '/'
    try {
      const matched = router.match(method === 'HEAD' ? 'GET' : method, path)
      if (!matched) {
        req.resume()
        throw new ConsoleError(404, 'not_found', 'No such console API route')
      }
      const { route, params } = matched
      const mutating = !SAFE_METHODS.has(method)
      // Browsers cannot set custom headers cross-site without CORS, which
      // this API never grants; bearer tokens are not sent automatically.
      if (mutating && !usesBearer(req) && req.headers[CONSOLE_CSRF_HEADER] !== '1') {
        req.resume()
        throw new ConsoleError(403, 'csrf_required', `Mutating requests need the ${CONSOLE_CSRF_HEADER} header`)
      }
      const principal = await auth.authenticate(req)
      authorize(req, method, route, principal)
      let body: unknown
      if (mutating) body = await readJsonBody(req)
      else req.resume()
      const result = await route.handler({
        method,
        path,
        params,
        query: url.searchParams,
        body,
        headers: req.headers,
        principal,
        raw: req,
        res,
      })
      sendResult(res, result)
    } catch (error) {
      if (error instanceof PolicyProblemError) {
        sendJson(res, error.status, error.body)
        return
      }
      if (error instanceof ConsoleError) {
        sendApiError(res, error.status, error.code, error.message, error.details)
        return
      }
      deps.log(`console api error: ${method} ${path}: ${errorMessage(error)}`)
      sendApiError(res, 500, 'internal_error', 'Console API error')
    }
  }

  function serveFile(res: http.ServerResponse, file: string, method: string, cache: string): void {
    const size = statSync(file).size
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(size),
      'cache-control': cache,
    })
    if (method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  }

  function handleStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    setCommonHeaders(res)
    req.resume()
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      res.end('Method not allowed')
      return
    }
    const index = join(distDir, 'index.html')
    if (!existsSync(index)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('The gateway console is not built. Build it with `pnpm --filter @antseed/gateway-console build`, then reload.')
      return
    }
    let relative: string
    try {
      relative = decodeURIComponent(url.pathname.slice(CONSOLE_BASE_PATH.length)).replace(/^\/+/, '')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad path')
      return
    }
    const root = normalize(distDir.endsWith(sep) ? distDir : `${distDir}${sep}`)
    const target = normalize(join(root, relative))
    if (relative && !relative.includes('\0') && target.startsWith(root) && existsSync(target) && statSync(target).isFile()) {
      // Vite fingerprints everything under assets/, so it can be cached forever.
      const hashed = relative.startsWith('assets/')
      serveFile(res, target, method, hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      return
    }
    if (extname(relative)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('Not found')
      return
    }
    // Client-side routes all load the app shell.
    serveFile(res, index, method, 'no-cache')
  }

  return {
    router,
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://console.local')
      const pathname = url.pathname
      if (pathname === CONSOLE_API_PATH || pathname.startsWith(`${CONSOLE_API_PATH}/`)) {
        await handleApi(req, res, url)
        return true
      }
      if (pathname === CONSOLE_BASE_PATH || pathname.startsWith(`${CONSOLE_BASE_PATH}/`)) {
        handleStatic(req, res, url)
        return true
      }
      return false
    },
  }
}
