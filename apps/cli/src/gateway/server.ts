import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { SPEND_ATTRIBUTION_HEADER } from '../proxy/spend-attribution.js'
import { BUYER_IDENTITY_HEADER } from '../proxy/request-utils.js'
import { newRequestTag, type GatewayAccounting } from './accounting.js'
import { parseBearerToken } from './keys.js'
import { hasSpendLimits, LIMIT_PERIODS, type LimitBreach } from './limits.js'
import { formatUsdc, optionalUsdcToDecimalString, parseUsdToUsdc, usdcToDecimalString } from './money.js'
import type { SpendFeedState } from './spend-feed.js'
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
  buildPaymentRequirements,
  checkPaymentPayload,
  decodeHeaderJson,
  encodeHeaderJson,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type X402Asset,
  type X402Facilitator,
} from './x402.js'
import type { ApiKeyRecord, GatewayStore } from './store.js'

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
const TOPUP_PATH = '/v1/key/topup'

/**
 * `paid` routes reach a seller; the others are answered by the buyer for
 * free, or (`local`) by the gateway itself.
 */
const ALLOWED_ROUTES: ReadonlyArray<{ method: string; prefix: string; paid: boolean; local?: boolean }> = [
  { method: 'GET', prefix: KEY_INFO_PATH, paid: false, local: true },
  { method: 'POST', prefix: TOPUP_PATH, paid: false, local: true },
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
  buyerPort: number
  /** Wallet address of a buyer identity, for key holders' usage view. */
  identityAddress: (buyerIdentity: string) => Promise<string | null>
  spendFeedState: () => SpendFeedState
  refreshSpendFeed: () => Promise<void>
  /** x402 top-ups into a key's buyer wallet; null disables `POST /v1/key/topup`. */
  topup?: GatewayTopupOptions | null
  listenPort?: number
  listenHost?: string
  onLog?: (message: string) => void
}

export interface GatewayTopupOptions {
  asset: () => Promise<X402Asset>
  facilitator: X402Facilitator
  minUsdc: number
  maxUsdc: number
}

/**
 * Authenticated front door to a buyer. Each API key names the buyer identity
 * (wallet) that pays for it, carries optional spend caps, and gets its signed
 * spend attributed back through the buyer's spend feed.
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

    if (route.local) {
      if (route.prefix === TOPUP_PATH) await this._topup(req, res, key)
      else sendJson(res, 200, { data: await this._keyInfo(key) })
      return
    }
    const buyerPort = this._options.buyerPort

    // Caps are only as good as the spend that reaches the ledger, so a key
    // with caps fails closed while its buyer is not reporting spend.
    if (route.paid && hasSpendLimits(key.limits) && this._options.spendFeedState() !== 'reporting') {
      await this._options.refreshSpendFeed()
      const state = this._options.spendFeedState()
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
      buyerIdentity: key.buyerIdentity,
      method,
      path: canonicalPath.split('?')[0]!,
      model: sniffModel(body, req.headers['content-type']),
      startedAt: Date.now(),
    })
    this._options.store.touchKey(key.id)
    this._log(`gateway request: key=${key.id} identity=${key.buyerIdentity} ${method} ${path} -> ${canonicalPath}`)

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
      // The key decides who pays and how spend is tagged, never the client.
      if (normalized === 'content-length' || normalized === SPEND_ATTRIBUTION_HEADER || normalized === BUYER_IDENTITY_HEADER) continue
      if (normalized.startsWith('x-forwarded-') || HOP_BY_HOP.has(normalized)) continue
      headers[name] = value
    }
    headers.host = `127.0.0.1:${buyerPort}`
    headers.connection = 'close'
    headers['content-length'] = String(body.length)
    headers['x-antseed-system-proxy-source'] = tunnelRequestSource(req.headers)
    headers[SPEND_ATTRIBUTION_HEADER] = tag
    if (key.buyerIdentity !== DEFAULT_BUYER_IDENTITY) headers[BUYER_IDENTITY_HEADER] = key.buyerIdentity

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

  /**
   * x402 top-up: the key holder pays USDC straight to the key's buyer wallet.
   * The buyer's deposit watcher then sweeps it into that identity's credits.
   * Without a PAYMENT-SIGNATURE the answer is the 402 an x402 client pays.
   */
  private async _topup(req: http.IncomingMessage, res: http.ServerResponse, key: ApiKeyRecord): Promise<void> {
    const topup = this._options.topup
    if (!topup) {
      sendError(res, 501, 'invalid_request_error', 'topup_unavailable', 'This gateway does not accept top-ups')
      return
    }
    if (key.buyerIdentity === DEFAULT_BUYER_IDENTITY) {
      sendError(res, 403, 'invalid_request_error', 'topup_not_available', 'This key is paid from the operator\'s wallet and cannot be topped up')
      return
    }
    const payTo = await this._options.identityAddress(key.buyerIdentity).catch(() => null)
    if (!payTo) {
      sendError(res, 503, 'api_error', 'buyer_wallet_unknown', 'The wallet behind this API key is not available')
      return
    }

    let amountUsdc: number
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { amount_usd?: unknown }
      amountUsdc = parseUsdToUsdc(String(body.amount_usd ?? ''))
    } catch {
      sendError(res, 400, 'invalid_request_error', 'invalid_amount', 'Send {"amount_usd": "<USD amount>"}')
      return
    }
    if (amountUsdc < topup.minUsdc || amountUsdc > topup.maxUsdc) {
      sendError(res, 400, 'invalid_request_error', 'invalid_amount',
        `Top-ups must be between ${formatUsdc(topup.minUsdc)} and ${formatUsdc(topup.maxUsdc)}`)
      return
    }

    const asset = await topup.asset()
    const requirements = buildPaymentRequirements(asset, payTo, amountUsdc)
    const proto = firstHeader(req.headers['x-forwarded-proto']) || 'http'
    const resource = {
      url: `${proto}://${req.headers.host ?? 'localhost'}${TOPUP_PATH}`,
      description: `Add ${formatUsdc(amountUsdc)} of credits to API key ${key.id}`,
      mimeType: 'application/json',
    }
    const paymentRequired = (error: string): void => {
      const body: PaymentRequired = { x402Version: X402_VERSION, error, resource, accepts: [requirements] }
      res.setHeader(PAYMENT_REQUIRED_HEADER, encodeHeaderJson(body))
      sendJson(res, 402, body)
    }

    const signature = firstHeader(req.headers[PAYMENT_SIGNATURE_HEADER])
    if (!signature) {
      paymentRequired('PAYMENT-SIGNATURE header is required')
      return
    }
    const payment = decodeHeaderJson<PaymentPayload>(signature)
    if (!payment) {
      sendError(res, 400, 'invalid_request_error', 'invalid_payload', 'PAYMENT-SIGNATURE is not base64-encoded JSON')
      return
    }
    const localError = checkPaymentPayload(payment, requirements, asset, Math.floor(Date.now() / 1000))
    if (localError) {
      paymentRequired(localError)
      return
    }
    const settled = await this._settleTopup(topup, payment, requirements)
    if (!settled.success) {
      this._log(`gateway top-up failed: key=${key.id} reason=${settled.errorReason ?? 'unknown'}`)
      res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeaderJson(settled))
      paymentRequired(settled.errorReason ?? 'unexpected_settle_error')
      return
    }

    const authorization = payment.payload.authorization
    this._options.store.recordLedgerEntry({
      kind: 'credit',
      keyId: key.id,
      buyerIdentity: key.buyerIdentity,
      amountUsdc,
      externalRef: `x402:${requirements.network}:${authorization.nonce.toLowerCase()}`,
      note: `x402 top-up from ${settled.payer || authorization.from}, tx ${settled.transaction}`,
      createdAt: Date.now(),
    })
    this._log(`gateway top-up: key=${key.id} identity=${key.buyerIdentity} amount=${formatUsdc(amountUsdc)} tx=${settled.transaction}`)
    res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeaderJson(settled))
    sendJson(res, 200, {
      data: {
        topped_up_usd: usdcToDecimalString(amountUsdc),
        buyer_address: requirements.payTo,
        transaction: settled.transaction,
        network: settled.network,
        payer: settled.payer || authorization.from,
        // The buyer sweeps the wallet into its deposits on its next check.
        credits_available: 'within about a minute',
      },
    })
  }

  private async _settleTopup(topup: GatewayTopupOptions, payment: PaymentPayload, requirements: PaymentRequirements) {
    const failure = (errorReason: string) => ({
      success: false, errorReason, transaction: '', network: requirements.network, payer: payment.payload.authorization.from,
    })
    try {
      const verified = await topup.facilitator.verify(payment, requirements)
      if (!verified.isValid) return failure(verified.invalidReason ?? 'unexpected_verify_error')
      return await topup.facilitator.settle(payment, requirements)
    } catch (error) {
      this._log(`gateway facilitator error: ${error instanceof Error ? error.message : String(error)}`)
      return failure('unexpected_settle_error')
    }
  }

  private async _keyInfo(key: ApiKeyRecord) {
    const spent = this._options.store.periodSpend(key.id)
    const usage = this._options.store.usageStats(key.id)
    const buyerAddress = await this._options.identityAddress(key.buyerIdentity).catch(() => null)
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
      buyer_address: buyerAddress,
      usage: {
        requests: usage.requests,
        spent_usd: usdcToDecimalString(usage.spentUsdc),
        topped_up_usd: usdcToDecimalString(usage.creditedUsdc),
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

function canonicalizeRoute(method: string, path: string): { path: string; prefix: string; paid: boolean; local: boolean } | null {
  const queryIndex = path.indexOf('?')
  const pathname = (queryIndex === -1 ? path : path.slice(0, queryIndex)).toLowerCase()
  const query = queryIndex === -1 ? '' : path.slice(queryIndex)
  const candidates = new Set([pathname])

  if (!pathname.startsWith('/v1/')) candidates.add(`/v1${pathname}`)
  if (pathname.startsWith('/v1/v1/')) candidates.add(pathname.slice(3))

  const route = ALLOWED_ROUTES.find((allowed) =>
    allowed.method === method && candidates.has(allowed.prefix),
  )
  return route ? { path: `${route.prefix}${query}`, prefix: route.prefix, paid: route.paid, local: route.local ?? false } : null
}
