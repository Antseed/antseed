import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SPEND_ATTRIBUTION_HEADER } from '../proxy/spend-attribution.js'
import { newRequestTag, type GatewayAccounting } from './accounting.js'
import { parseBearerToken } from './keys.js'
import { hasSpendLimits, LIMIT_PERIODS, type LimitBreach } from './limits.js'
import { formatUsdc, optionalUsdcToDecimalString, usdcToDecimalString } from './money.js'
import type { SpendFeedState } from './spend-feed.js'
import type { ApiKeyRecord, GatewayIdentity, GatewayStore } from './store.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/** Bodies are buffered to read the model for metrics; the buyer buffers them too. */
const MAX_MODEL_SNIFF_BYTES = 4 * 1024 * 1024
const KEY_INFO_PATH = '/v1/key'

/** `paid` routes reach a seller; the others are answered by the buyer for free. */
const ALLOWED_ROUTES: ReadonlyArray<{ method: string; prefix: string; paid: boolean }> = [
  { method: 'GET', prefix: KEY_INFO_PATH, paid: false },
  { method: 'GET', prefix: '/v1/models', paid: false },
  { method: 'POST', prefix: '/v1/messages', paid: true },
  { method: 'POST', prefix: '/v1/messages/count_tokens', paid: false },
  { method: 'POST', prefix: '/v1/chat/completions', paid: true },
  { method: 'POST', prefix: '/v1/responses', paid: true },
  { method: 'POST', prefix: '/v1/images/generations', paid: true },
  { method: 'POST', prefix: '/v1/images/edits', paid: true },
]

export interface GatewayServerOptions {
  store: GatewayStore
  accounting: GatewayAccounting
  /** Port of the buyer proxy for an identity, or null when it has none running. */
  resolveBuyerPort: (identity: GatewayIdentity) => number | null
  spendFeedState: (identityId: string) => SpendFeedState
  refreshSpendFeed: () => Promise<void>
  listenPort?: number
  listenHost?: string
  onLog?: (message: string) => void
}

/**
 * Authenticated front door for one or more buyer identities. Each API key
 * maps to an identity's buyer proxy, carries optional spend caps, and gets
 * its signed spend attributed back through the buyer's spend feed.
 */
export class GatewayServer {
  private _server: http.Server | null = null
  private _port = 0

  constructor(private readonly _options: GatewayServerOptions) {}

  get port(): number {
    return this._port
  }

  async start(): Promise<number> {
    if (this._server) return this._port
    this._server = http.createServer((req, res) => {
      this._handle(req, res).catch((error: unknown) => {
        this._log(`gateway error: ${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) sendError(res, 500, 'api_error', 'internal_error', 'Gateway error')
        else res.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this._server!.once('error', reject)
      this._server!.listen(this._options.listenPort ?? 0, this._options.listenHost ?? '127.0.0.1', () => resolve())
    })
    this._port = (this._server.address() as AddressInfo).port
    return this._port
  }

  async stop(): Promise<void> {
    const server = this._server
    this._server = null
    this._port = 0
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private _log(message: string): void {
    this._options.onLog?.(message)
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    const route = canonicalizeRoute(method, path)

    if (!route) {
      this._log(`gateway rejected route: ${method} ${path}`)
      sendError(res, 404, 'invalid_request_error', 'not_found', 'Not found')
      return
    }
    const canonicalPath = route.path

    const secret = parseBearerToken(req.headers.authorization)
    const key = secret ? this._options.store.findKeyBySecret(secret) : null
    if (!key || key.status !== 'active') {
      this._log(`gateway rejected authentication: ${method} ${path}`)
      res.setHeader('www-authenticate', 'Bearer')
      sendError(res, 401, 'authentication_error', key ? 'key_revoked' : 'invalid_api_key', key ? 'API key has been revoked' : 'Invalid API key')
      return
    }
    if (key.expiresAt !== null && key.expiresAt <= Date.now()) {
      res.setHeader('www-authenticate', 'Bearer')
      sendError(res, 401, 'authentication_error', 'key_expired', 'API key has expired')
      return
    }

    if (canonicalPath.startsWith(KEY_INFO_PATH)) {
      sendJson(res, 200, { data: this._keyInfo(key) })
      return
    }

    const identity = this._options.store.getIdentity(key.identityId)
    const buyerPort = identity ? this._options.resolveBuyerPort(identity) : null
    if (!identity || buyerPort === null) {
      sendError(res, 503, 'api_error', 'buyer_unavailable', 'The buyer for this API key is not running')
      return
    }

    // Caps are only as good as the spend that reaches the ledger, so a key
    // with caps fails closed while its buyer is not reporting spend.
    if (route.paid && hasSpendLimits(key.limits) && this._options.spendFeedState(identity.id) !== 'reporting') {
      await this._options.refreshSpendFeed()
      const state = this._options.spendFeedState(identity.id)
      if (state !== 'reporting') {
        sendError(res, 503, 'api_error', 'spend_tracking_unavailable', state === 'unsupported'
          ? 'The buyer for this API key does not report spend; upgrade it to enforce spend limits'
          : 'The buyer for this API key is not reachable')
        return
      }
    }

    const body = await readBody(req)
    let tag: string
    if (route.paid) {
      const admission = this._options.accounting.admit(key)
      if (!admission.ok) {
        this._log(`gateway spend limit reached: key=${key.id} period=${admission.breach.period}`)
        sendJson(res, 402, { error: spendLimitError(admission.breach) })
        return
      }
      tag = admission.tag
    } else {
      tag = newRequestTag()
    }

    this._options.store.startRequest({
      tag,
      keyId: key.id,
      identityId: identity.id,
      method,
      path: canonicalPath.split('?')[0]!,
      model: sniffModel(body, req.headers['content-type']),
      startedAt: Date.now(),
    })
    this._options.store.touchKey(key.id)
    this._log(`gateway request: key=${key.id} identity=${identity.id} ${method} ${path} -> ${canonicalPath}`)

    let finished = false
    const finish = (status: number, buyerRequestId: string | null): void => {
      if (finished) return
      finished = true
      this._options.store.finishRequest(tag, { status, buyerRequestId })
      this._options.accounting.finish(tag)
    }

    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const normalized = name.toLowerCase()
      if (normalized === 'host' || normalized === 'authorization' || normalized === 'cookie') continue
      if (normalized === 'content-length' || normalized === SPEND_ATTRIBUTION_HEADER) continue
      if (normalized.startsWith('x-forwarded-') || HOP_BY_HOP.has(normalized)) continue
      headers[name] = value
    }
    headers.host = `127.0.0.1:${buyerPort}`
    headers.connection = 'close'
    headers['content-length'] = String(body.length)
    headers['x-antseed-system-proxy-source'] = tunnelRequestSource(req.headers)
    headers[SPEND_ATTRIBUTION_HEADER] = tag

    const upstream = http.request({
      hostname: '127.0.0.1',
      port: buyerPort,
      method,
      path: canonicalPath,
      headers,
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502
      const buyerRequestId = firstHeader(upstreamRes.headers['x-antseed-request-id']) || null
      const responseHeaders: http.OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) responseHeaders[name] = value
      }
      responseHeaders.connection = 'close'
      res.writeHead(status, responseHeaders)
      upstreamRes.pipe(res)
      upstreamRes.once('end', () => finish(status, buyerRequestId))
      upstreamRes.once('error', () => finish(status, buyerRequestId))
      res.once('close', () => finish(status, buyerRequestId))
    })

    upstream.on('error', (error) => {
      this._log(`gateway upstream error: ${error.message}`)
      finish(502, null)
      if (!res.headersSent) {
        sendError(res, 502, 'api_error', 'buyer_unavailable', 'Antseed buyer proxy is unavailable')
      } else {
        res.destroy()
      }
    })
    // A client that disconnects mid-stream should stop the paid request too.
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    upstream.end(body)
  }

  private _keyInfo(key: ApiKeyRecord) {
    const spent = this._options.store.periodSpend(key.id)
    const usage = this._options.store.usageStats(key.id)
    const identity = this._options.store.getIdentity(key.identityId)
    const limits = Object.fromEntries(LIMIT_PERIODS.map((period) => {
      const limit = key.limits[period]
      return [period, {
        limit_usd: optionalUsdcToDecimalString(limit),
        spent_usd: usdcToDecimalString(spent[period]),
        remaining_usd: optionalUsdcToDecimalString(limit === null ? null : Math.max(0, limit - spent[period])),
      }]
    }))
    return {
      id: key.id,
      label: key.label,
      created_at: new Date(key.createdAt).toISOString(),
      expires_at: key.expiresAt === null ? null : new Date(key.expiresAt).toISOString(),
      // The wallet that pays sellers for this key's requests.
      buyer_address: identity?.address ?? null,
      usage: {
        requests: usage.requests,
        spent_usd: usdcToDecimalString(usage.spentUsdc),
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens,
      },
      limits,
    }
  }
}

/**
 * 402 is the status a client-facing payment flow will answer with, so a key
 * that hits its cap already gets the shape a top-up offer can extend.
 */
function spendLimitError(breach: LimitBreach) {
  const label = breach.period === 'total' ? 'lifetime' : breach.period
  return {
    type: 'insufficient_quota',
    code: 'spend_limit_reached',
    message: `This API key reached its ${label} spend limit of ${formatUsdc(breach.limitUsdc)}.`,
    limit: {
      period: breach.period,
      limit_usd: usdcToDecimalString(breach.limitUsdc),
      spent_usd: usdcToDecimalString(breach.spentUsdc),
      resets_at: breach.resetsAt === null ? null : new Date(breach.resetsAt).toISOString(),
    },
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sendError(res: http.ServerResponse, status: number, type: string, code: string, message: string): void {
  sendJson(res, status, { error: { message, type, code } })
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function sniffModel(body: Buffer, contentType: string | undefined): string | null {
  if (body.length === 0 || body.length > MAX_MODEL_SNIFF_BYTES) return null
  if (contentType && !contentType.includes('json')) return null
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model.slice(0, 200) : null
  } catch {
    return null
  }
}

function tunnelRequestSource(headers: http.IncomingHttpHeaders): string {
  const originator = normalizeSource(firstHeader(headers.originator))
  if (originator) return originator.startsWith('cursor') ? 'cursor' : originator

  if (Object.keys(headers).some((name) => name.toLowerCase().startsWith('x-cursor-'))) {
    return 'cursor'
  }

  const userAgent = firstHeader(headers['user-agent']).trim()
  const product = normalizeSource(userAgent.split(/[/\s]/, 1)[0] ?? '')
  return product.startsWith('cursor') ? 'cursor' : 'public-tunnel'
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function normalizeSource(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function canonicalizeRoute(method: string, path: string): { path: string; paid: boolean } | null {
  const queryIndex = path.indexOf('?')
  const pathname = (queryIndex === -1 ? path : path.slice(0, queryIndex)).toLowerCase()
  const query = queryIndex === -1 ? '' : path.slice(queryIndex)
  const candidates = new Set([pathname])

  if (!pathname.startsWith('/v1/')) candidates.add(`/v1${pathname}`)
  if (pathname.startsWith('/v1/v1/')) candidates.add(pathname.slice(3))

  const route = ALLOWED_ROUTES.find((allowed) =>
    allowed.method === method && candidates.has(allowed.prefix),
  )
  return route ? { path: `${route.prefix}${query}`, paid: route.paid } : null
}
