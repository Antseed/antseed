import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { SYSTEM_PROXY_SOURCE_HEADER, SYSTEM_ROUTED_MODEL_HEADER } from '../proxy/request-utils.js'
import type { CertCache } from './cert-cache.js'
import type {
  SystemProxyCorsRule,
  SystemProxyForwardRule,
  SystemProxyRequestTransform,
  SystemProxyResponseTransform,
  SystemProxySource,
} from './types.js'
import { CLIENT_CREDENTIAL_HEADERS } from '../proxy/credential-headers.js'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection',
])

const ROUTED_SENSITIVE_HEADERS = new Set([
  ...CLIENT_CREDENTIAL_HEADERS,
  'x-csrf-token',
])

/** Body sent to connected apps when the buyer rejects a request with 402 —
    the user's balance can't cover the payment channel for this request.
    Plain text, not JSON: apps surface the error body verbatim in their
    "something went wrong" UI, so it must read as a sentence for the person
    in front of the app, not as a machine payload. */
const OUT_OF_CREDITS_MESSAGE =
  'AntSeed is out of credits, so this request was not sent to a provider. '
  + 'Open the AntSeed app and add funds to your balance, then send your message again.'

export interface BuyerForwardRequest {
  path: string
  body: Buffer
  source: SystemProxySource
  response?: SystemProxyResponseTransform
  conversation?: ConversationForwardContext
  /** True when the proxy assigned the body's `model` from its configured
      route (vs forwarding a client-chosen AntSeed route untouched). Marked
      on the forward so the buyer can let a per-chat pin override it. */
  modelRouted?: boolean
}

export interface ConversationForwardContext {
  conversationId: string
  parentMessageId: string
  userMessageId: string
  assistantMessageId: string
  assistantParent?: 'request-parent' | 'user-message'
  assistantCreateTime?: number
  modelSlug?: string
}

export interface SystemProxyConfig {
  port: number
  buyerProxyPort: number
  /** Headers authenticating to a token-protected buyer; read per request. */
  buyerAuthHeaders?: () => Record<string, string>
  certCache: CertCache
  proxiedDomains: Set<string>
  proxiedPathPrefixes: Map<string, Set<string>>
  proxiedSources?: Map<string, Map<string, SystemProxySource>>
  systemProxyForwardRules?: Map<string, SystemProxyForwardRule>
  defaultPeerId: string
  defaultModel?: string
  servedModels?: Set<string>
  upstreamOverrides?: Map<string, { host: string; port: number }>
}

function log(msg: string): void {
  process.stdout.write(`[system-proxy] ${msg}\n`)
}

export class SystemProxyServer {
  private outerServer: http.Server | null = null
  private innerNetServer: net.Server | null = null
  private innerTlsServer: https.Server | null = null
  private readonly sockets = new Set<net.Socket>()
  private innerPort = 0

  constructor(private readonly config: SystemProxyConfig) {}

  async start(): Promise<void> {
    this.innerTlsServer = https.createServer({
      maxHeaderSize: 256 * 1024,
      SNICallback: (hostname, cb) => {
        this.config.certCache.get(hostname)
          .then(({ certPem, privateKeyPem }) => {
            cb(null, tls.createSecureContext({ cert: certPem, key: privateKeyPem }))
          })
          .catch((err: Error) => {
            log(`cert error for ${hostname}: ${err.message}`)
            cb(err)
          })
      },
    }, (req, res) => {
      this.handleDecrypted(req, res)
    })
    this.innerTlsServer.on('tlsClientError', (err) => {
      log(`TLS client error: ${err.message}`)
      if (err.message.includes('certificate unknown')) {
        log('TLS trust failure: restart the client with NODE_EXTRA_CA_CERTS pointing at the AntSeed CA, or install/trust the CA for that client.')
      }
    })

    this.innerNetServer = net.createServer((socket) => {
      this.trackSocket(socket)
      this.innerTlsServer!.emit('connection', socket)
    })
    await new Promise<void>((resolve) => {
      this.innerNetServer!.listen(0, '127.0.0.1', () => resolve())
    })
    this.innerPort = (this.innerNetServer!.address() as net.AddressInfo).port

    this.outerServer = http.createServer({ maxHeaderSize: 64 * 1024 }, (_req, res) => {
      res.writeHead(400).end('AntSeed system-proxy: use HTTPS via CONNECT.')
    })
    this.outerServer.on('connect', (req, socket, head) => {
      this.handleConnect(req, socket as net.Socket, head)
    })
    this.outerServer.on('connection', (socket) => {
      this.trackSocket(socket)
    })
    await new Promise<void>((resolve) => {
      this.outerServer!.listen(this.config.port, '127.0.0.1', () => resolve())
    })

    log(`listening on :${this.port}`)
    log(`proxying: ${[...this.config.proxiedDomains].join(', ')}`)
    log(`routes: ${formatSystemProxyRoutes(this.config.proxiedPathPrefixes)}`)
    log(`peer: ${this.config.defaultPeerId}`)
    if (this.config.defaultModel) {
      log(`default model: ${this.config.defaultModel}`)
    }
    log(`buyer proxy: localhost:${this.config.buyerProxyPort}`)
    log(`env HTTPS_PROXY=${process.env['HTTPS_PROXY'] ?? '(not set)'}`)
    log(`env NODE_EXTRA_CA_CERTS=${process.env['NODE_EXTRA_CA_CERTS'] ?? '(not set)'}`)
  }

  get port(): number {
    return (this.outerServer?.address() as net.AddressInfo | null)?.port ?? 0
  }

  get innerTlsPort(): number {
    return (this.innerNetServer?.address() as net.AddressInfo | null)?.port ?? 0
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy()
    }
    await Promise.all([
      closeServer(this.outerServer),
      closeServer(this.innerNetServer),
      closeServer(this.innerTlsServer),
    ])
    this.outerServer = null
    this.innerNetServer = null
    this.innerTlsServer = null
  }

  private trackSocket(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const target = req.url ?? ''
    const colonIdx = target.lastIndexOf(':')
    const host = colonIdx >= 0 ? target.slice(0, colonIdx) : target
    const port = colonIdx >= 0 ? (parseInt(target.slice(colonIdx + 1), 10) || 443) : 443

    if (this.config.proxiedDomains.has(host)) {
      log(`CONNECT ${host}:${port} → proxy`)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      this.trackSocket(clientSocket)
      const conn = net.connect(this.innerPort, '127.0.0.1', () => {
        this.trackSocket(conn)
        if (head.length > 0) conn.write(head)
        clientSocket.pipe(conn)
        conn.pipe(clientSocket)
      })
      conn.on('close', (hadError) => {
        if (!hadError) {
          log(`CONNECT ${host}:${port} closed before HTTPS request`)
        }
      })
      conn.on('error', (err) => {
        log(`inner conn error for ${host}: ${err.message}`)
        clientSocket.destroy()
      })
      clientSocket.on('error', () => conn.destroy())
    } else {
      log(`CONNECT ${host}:${port} → tunnel (not proxied)`)
      this.trackSocket(clientSocket)
      const conn = net.connect(port, host, () => {
        this.trackSocket(conn)
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) conn.write(head)
        clientSocket.pipe(conn)
        conn.pipe(clientSocket)
      })
      conn.on('error', () => {
        if (!clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          clientSocket.destroy()
        }
      })
      clientSocket.on('error', () => conn.destroy())
    }
  }

  private handleDecrypted(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers['host']?.split(':')[0] ?? 'unknown'
    const isJson = (req.headers['content-type'] ?? '').includes('application/json')
    const hasAuth = Boolean(req.headers['authorization'])
    const forwardRule = getSystemProxyForwardRule(
      host,
      req.url ?? '/',
      this.config.proxiedPathPrefixes,
      this.config.systemProxyForwardRules,
    )

    if (req.method === 'OPTIONS' && forwardRule?.cors) {
      log(`→ OPTIONS ${host}${req.url ?? '/'} | cors preflight | source:${forwardRule.source}`)
      res.writeHead(204, buildCorsHeaders(req, forwardRule.cors, true))
      res.end()
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('error', (err) => {
      log(`request error from ${host}: ${err.message}`)
      if (!res.headersSent) res.writeHead(400).end(err.message)
    })
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)
      const buyerRequest = buildBuyerForwardRequest({
        host,
        path: req.url ?? '/',
        rawBody,
        isJson,
        peerId: this.config.defaultPeerId,
        defaultModel: this.config.defaultModel,
        servedModels: this.config.servedModels,
        prefixesByHost: this.config.proxiedPathPrefixes,
        sourcesByHost: this.config.proxiedSources,
        forwardRulesByHost: this.config.systemProxyForwardRules,
      })
      const body = buyerRequest?.body ?? rawBody

      // Log the request details
      let modelBefore = ''
      let modelAfter = ''
      if (isJson && rawBody.length > 0) {
        try {
          const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
          modelBefore = typeof parsed['model'] === 'string' ? parsed['model'] : ''
        } catch { /* ignore */ }
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
          modelAfter = typeof parsed['model'] === 'string' ? parsed['model'] : ''
        } catch { /* ignore */ }
      }

      if (!buyerRequest) {
        log(`→ ${req.method ?? 'GET'} ${host}${req.url ?? '/'} | pass-through`)
        this.forwardToUpstream(host, req, res, body)
        return
      }

      const authNote = hasAuth ? 'auth:stripped' : 'auth:none'
      const modelNote = modelBefore
        ? (modelBefore !== modelAfter ? `model: ${modelBefore} → ${modelAfter}` : `model: ${modelBefore}`)
        : 'model: -'
      const pathNote = buyerRequest.path === (req.url ?? '/')
        ? req.url ?? '/'
        : `${req.url ?? '/'} → ${buyerRequest.path}`
      log(`→ ${req.method ?? 'GET'} ${host}${pathNote} | ${modelNote} | ${authNote} | source:${buyerRequest.source}`)

      const forwardHeaders: http.OutgoingHttpHeaders = {}
      const strippedHeaders = new Set([
        ...ROUTED_SENSITIVE_HEADERS,
        ...(forwardRule?.stripHeaders ?? []).map((header) => header.toLowerCase()),
      ])
      if (forwardRule?.headers === 'browser-sse') {
        forwardHeaders['accept'] = 'text/event-stream'
        forwardHeaders['content-type'] = 'application/json'
      } else {
        for (const [k, v] of Object.entries(req.headers)) {
          if (strippedHeaders.has(k.toLowerCase())) continue
          if (k === 'host') continue
          if (HOP_BY_HOP.has(k)) continue
          forwardHeaders[k] = v
        }
      }
      forwardHeaders['host'] = `127.0.0.1:${this.config.buyerProxyPort}`
      Object.assign(forwardHeaders, this.config.buyerAuthHeaders?.() ?? {})
      forwardHeaders['connection'] = 'close'
      forwardHeaders[SYSTEM_PROXY_SOURCE_HEADER] = buyerRequest.source
      if (buyerRequest.modelRouted) {
        // The model in this body is ours, not the tool's — let the buyer
        // swap it for the chat's pinned route when one exists.
        forwardHeaders[SYSTEM_ROUTED_MODEL_HEADER] = '1'
      }
      if (body.length > 0) {
        forwardHeaders['content-length'] = String(body.length)
      }

      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: this.config.buyerProxyPort,
          path: buyerRequest.path,
          method: req.method ?? 'GET',
          headers: forwardHeaders,
        },
        (proxyRes) => {
          log(`← ${proxyRes.statusCode ?? '?'} ${host} | source:${buyerRequest.source} | from buyer proxy`)
          if (buyerRequest.response?.kind === 'conversation-sse' && buyerRequest.conversation) {
            this.forwardConversationResponse(proxyRes, res, buyerRequest.conversation)
            return
          }
          if (buyerRequest.response?.kind === 'responses-sse') {
            this.forwardResponsesSse(proxyRes, res, req, buyerRequest.response, forwardRule)
            return
          }
          if (proxyRes.statusCode === 402) {
            this.respondOutOfCredits(proxyRes, res, req, buyerRequest, forwardRule)
            return
          }
          const resHeaders = buildResponseHeaders(proxyRes, req, forwardRule)
          res.writeHead(proxyRes.statusCode ?? 200, resHeaders)
          proxyRes.pipe(res)
        },
      )

      proxyReq.on('error', (err) => {
        log(`← 502 ${host} | source:${buyerRequest.source} | forward error: ${err.message}`)
        if (!res.headersSent) {
          res.writeHead(502).end(`SystemProxy forward error: ${err.message}`)
        }
      })

      if (body.length > 0) {
        proxyReq.end(body)
      } else {
        proxyReq.end()
      }
    })
  }

  /**
   * A 402 from the buyer proxy means the user can't pay for this request.
   * Connected apps surface that JSON error blob raw ("API Error: 402
   * {\"type\":\"api_error\",...}"), which gives the user no idea what
   * happened or what to do — so keep the 402 status but replace the body
   * with a plain-text sentence telling them to top up in the AntSeed app.
   */
  private respondOutOfCredits(
    proxyRes: http.IncomingMessage,
    res: http.ServerResponse,
    req: http.IncomingMessage,
    buyerRequest: BuyerForwardRequest,
    forwardRule: SystemProxyForwardRule | undefined,
  ): void {
    // The buyer's error body is replaced, not forwarded — drain it.
    proxyRes.resume()
    log(`← 402 body rewritten as plain-text out-of-credits notice | source:${buyerRequest.source}`)
    const body = Buffer.from(OUT_OF_CREDITS_MESSAGE, 'utf8')
    const resHeaders: http.OutgoingHttpHeaders = {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(body.length),
      'connection': 'close',
    }
    if (forwardRule?.cors) {
      Object.assign(resHeaders, buildCorsHeaders(req, forwardRule.cors, false))
    }
    res.writeHead(402, resHeaders)
    res.end(body)
  }

  private forwardConversationResponse(
    proxyRes: http.IncomingMessage,
    res: http.ServerResponse,
    context: ConversationForwardContext,
  ): void {
    res.writeHead(proxyRes.statusCode && proxyRes.statusCode >= 400 ? proxyRes.statusCode : 200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'close',
    })

    const adapter = new ConversationSseAdapter(context)
    const contentType = String(proxyRes.headers['content-type'] ?? '').toLowerCase()
    const chunks: Buffer[] = []

    proxyRes.on('data', (chunk: Buffer) => {
      if (contentType.includes('text/event-stream')) {
        for (const out of adapter.feed(chunk, false)) {
          res.write(out)
        }
      } else {
        chunks.push(chunk)
      }
    })

    proxyRes.on('end', () => {
      const out = contentType.includes('text/event-stream')
        ? adapter.feed(Buffer.alloc(0), true)
        : adapter.fromJsonResponse(Buffer.concat(chunks))
      for (const chunk of out) {
        res.write(chunk)
      }
      res.end()
    })

    proxyRes.on('error', (err) => {
      log(`conversation response error: ${err.message}`)
      for (const out of adapter.error(err.message)) {
        res.write(out)
      }
      res.end()
    })
  }

  private forwardResponsesSse(
    proxyRes: http.IncomingMessage,
    res: http.ServerResponse,
    originalReq: http.IncomingMessage,
    transform: Extract<SystemProxyResponseTransform, { kind: 'responses-sse' }>,
    forwardRule?: SystemProxyForwardRule,
  ): void {
    const resHeaders = buildResponseHeaders(proxyRes, originalReq, forwardRule)
    const contentType = String(proxyRes.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.includes('text/event-stream')) {
      res.writeHead(proxyRes.statusCode ?? 200, resHeaders)
      proxyRes.pipe(res)
      return
    }

    resHeaders['content-type'] = 'text/event-stream; charset=utf-8'
    delete resHeaders['content-length']
    res.writeHead(proxyRes.statusCode ?? 200, resHeaders)

    const adapter = new ResponsesSseNormalizer(transform)
    proxyRes.on('data', (chunk: Buffer) => {
      for (const out of adapter.feed(chunk, false)) {
        res.write(out)
      }
    })
    proxyRes.on('end', () => {
      for (const out of adapter.feed(Buffer.alloc(0), true)) {
        res.write(out)
      }
      res.end()
    })
    proxyRes.on('error', (err) => {
      log(`responses sse error: ${err.message}`)
      res.end()
    })
  }

  private forwardToUpstream(host: string, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const forwardHeaders: http.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k)) continue
      forwardHeaders[k] = v
    }
    forwardHeaders['host'] = host
    forwardHeaders['connection'] = 'close'
    if (body.length > 0) {
      forwardHeaders['content-length'] = String(body.length)
    }

    const upstream = this.config.upstreamOverrides?.get(host)
    const upstreamReq = https.request(
      {
        hostname: upstream?.host ?? host,
        port: upstream?.port ?? 443,
        servername: host,
        path: req.url ?? '/',
        method: req.method ?? 'GET',
        headers: forwardHeaders,
      },
      (upstreamRes) => {
        log(`← ${upstreamRes.statusCode ?? '?'} from upstream ${host}`)
        const resHeaders: http.OutgoingHttpHeaders = {}
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(k) && v !== undefined) {
            resHeaders[k] = v as string | string[]
          }
        }
        resHeaders['connection'] = 'close'
        res.writeHead(upstreamRes.statusCode ?? 200, resHeaders)
        upstreamRes.pipe(res)
      },
    )

    upstreamReq.on('error', (err) => {
      log(`upstream error → ${host}: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502).end(`SystemProxy upstream error: ${err.message}`)
      }
    })

    if (body.length > 0) upstreamReq.end(body)
    else upstreamReq.end()
  }

}

function buildResponseHeaders(
  proxyRes: http.IncomingMessage,
  originalReq: http.IncomingMessage,
  forwardRule?: SystemProxyForwardRule,
): http.OutgoingHttpHeaders {
  const resHeaders: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(proxyRes.headers)) {
    if (!HOP_BY_HOP.has(k) && v !== undefined) {
      resHeaders[k] = v as string | string[]
    }
  }
  if (forwardRule?.cors) {
    Object.assign(resHeaders, buildCorsHeaders(originalReq, forwardRule.cors, false))
  }
  resHeaders['connection'] = 'close'
  return resHeaders
}

function getSystemProxyForwardRule(
  host: string,
  path: string,
  prefixesByHost: Map<string, Set<string>>,
  forwardRulesByHost?: Map<string, SystemProxyForwardRule>,
): SystemProxyForwardRule | undefined {
  if (!shouldSystemProxyRequest(host, path, prefixesByHost)) {
    return undefined
  }
  return forwardRulesByHost?.get(host)
}

function buildCorsHeaders(
  req: http.IncomingMessage,
  rule: SystemProxyCorsRule,
  preflight: boolean,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  const origin = resolveCorsOrigin(req.headers['origin'], rule.allowOrigin)
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['vary'] = 'Origin'
  }
  if (rule.allowCredentials) {
    headers['access-control-allow-credentials'] = 'true'
  }
  if (preflight) {
    headers['access-control-allow-methods'] = (rule.allowMethods ?? ['GET', 'POST', 'OPTIONS']).join(', ')
    const requestHeaders = typeof req.headers['access-control-request-headers'] === 'string'
      ? req.headers['access-control-request-headers']
      : ''
    const allowHeaders = rule.allowHeaders === 'request'
      ? requestHeaders
      : (rule.allowHeaders ?? ['content-type', 'authorization']).join(', ')
    if (allowHeaders.length > 0) {
      headers['access-control-allow-headers'] = allowHeaders
    }
    headers['access-control-max-age'] = String(rule.maxAgeSeconds ?? 600)
  }
  if (rule.exposeHeaders && rule.exposeHeaders.length > 0) {
    headers['access-control-expose-headers'] = rule.exposeHeaders.join(', ')
  }
  return headers
}

function resolveCorsOrigin(
  requestOrigin: string | string[] | undefined,
  allowOrigin: SystemProxyCorsRule['allowOrigin'] = 'request',
): string | undefined {
  if (allowOrigin === '*') return '*'
  if (allowOrigin === 'request') {
    return typeof requestOrigin === 'string' && requestOrigin.length > 0 ? requestOrigin : undefined
  }
  return allowOrigin
}

export function buildBuyerForwardRequest(opts: {
  host: string
  path: string
  rawBody: Buffer
  isJson: boolean
  peerId: string
  defaultModel?: string
  servedModels?: Set<string>
  prefixesByHost: Map<string, Set<string>>
  sourcesByHost?: Map<string, Map<string, SystemProxySource>>
  forwardRulesByHost?: Map<string, SystemProxyForwardRule>
}): BuyerForwardRequest | null {
  if (!shouldSystemProxyRequest(opts.host, opts.path, opts.prefixesByHost)) {
    return null
  }
  const forwardRule = opts.forwardRulesByHost?.get(opts.host)
  const source = forwardRule?.source ?? resolveSystemProxySource(opts.host, opts.path, opts.prefixesByHost, opts.sourcesByHost)
  if (forwardRule?.request) {
    if (!opts.isJson) return null
    const body = transformRequestBody(opts.rawBody, opts.peerId, forwardRule.request, {
      defaultModel: opts.defaultModel,
      servedModels: opts.servedModels,
    })
    if (!body) return null
    return {
      path: forwardRule?.targetPath ?? opts.path,
      body,
      source,
      response: forwardRule.response,
      conversation: forwardRule.response?.kind === 'conversation-sse'
        ? extractConversationForwardContext(opts.rawBody, body, forwardRule.response)
        : undefined,
      modelRouted: Boolean(opts.peerId),
    }
  }
  if (forwardRule) {
    const rewritten = opts.isJson
      ? rewriteRequestBody(opts.rawBody, opts.peerId, {
        defaultModel: opts.defaultModel,
        servedModels: opts.servedModels,
      })
      : null
    return {
      path: forwardRule.targetPath ?? opts.path,
      body: rewritten?.body ?? opts.rawBody,
      source,
      response: forwardRule.response,
      modelRouted: rewritten?.modelRouted ?? false,
    }
  }
  const rewritten = opts.isJson
    ? rewriteRequestBody(opts.rawBody, opts.peerId, {
      defaultModel: opts.defaultModel,
      servedModels: opts.servedModels,
    })
    : null
  return {
    path: opts.path,
    body: rewritten?.body ?? opts.rawBody,
    source,
    modelRouted: rewritten?.modelRouted ?? false,
  }
}

function resolveSystemProxySource(
  host: string,
  path: string,
  prefixesByHost: Map<string, Set<string>>,
  sourcesByHost?: Map<string, Map<string, SystemProxySource>>,
): SystemProxySource {
  const sources = sourcesByHost?.get(host)
  if (!sources || sources.size === 0) return 'standard'
  const pathname = normalizeRequestPath(path)
  let best: { prefix: string; source: SystemProxySource } | null = null
  for (const [prefix, source] of sources.entries()) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (!best || prefix.length > best.prefix.length) best = { prefix, source }
  }
  if (best) return best.source

  // A source map should mirror prefixesByHost, but keep a deterministic
  // fallback if a caller constructs the maps by hand in tests or integrations.
  const prefixes = prefixesByHost.get(host)
  if (!prefixes || prefixes.size === 0) return 'standard'
  return 'standard'
}

export function rewriteRequestBody(
  raw: Buffer,
  peerId: string,
  modelDefaults: ModelDefaultOptions = {},
): { body: Buffer; modelRouted: boolean } {
  if (raw.length === 0) return { body: raw, modelRouted: false }
  try {
    const json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    const rawModel = typeof json['model'] === 'string' ? json['model'] : ''
    const model = resolveSystemProxyModel(rawModel, modelDefaults)
    const modelRouted = Boolean(model && peerId)
    if (model && peerId) {
      json['model'] = `${peerId}@${model}`
    }
    return { body: Buffer.from(JSON.stringify(json), 'utf8'), modelRouted }
  } catch {
    return { body: raw, modelRouted: false }
  }
}

export function transformRequestBody(
  raw: Buffer,
  peerId: string,
  transform: SystemProxyRequestTransform,
  modelDefaults: ModelDefaultOptions = {},
): Buffer | null {
  if (raw.length === 0) return null
  try {
    const json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    const messages = extractProfileMessages(getPath(json, transform.messagesPath))
    if (messages.length === 0) {
      return null
    }
    const rawModelValue = transform.modelPath ? getPath(json, transform.modelPath) : undefined
    const rawModel = typeof rawModelValue === 'string' ? rawModelValue : ''

    if (transform.kind === 'chat-completions-from-messages') {
      const resolvedModel = (
        resolveSystemProxyModel(rawModel || transform.missingModel || '', modelDefaults)
        ?? (rawModel.trim() || transform.missingModel || '')
      ).trim()
      if (resolvedModel.length === 0) return null
      return Buffer.from(JSON.stringify({
        model: peerId ? `${peerId}@${resolvedModel}` : resolvedModel,
        messages,
        stream: transform.stream ?? true,
      }), 'utf8')
    }

    const resolvedModel = resolveSystemProxyModel(rawModel, modelDefaults)
    if (!resolvedModel) return null
    return Buffer.from(JSON.stringify({
      model: peerId ? `${peerId}@${resolvedModel}` : resolvedModel,
      input: messages,
      stream: transform.stream ?? true,
    }), 'utf8')
  } catch {
    return null
  }
}

export class ConversationSseAdapter {
  private buffer = ''
  private text = ''
  private done = false
  private readonly createdAt: number

  constructor(private readonly context: ConversationForwardContext) {
    this.createdAt = context.assistantCreateTime ?? Date.now() / 1000
  }

  feed(chunk: Buffer, done: boolean): Buffer[] {
    const out: Buffer[] = []
    if (chunk.length > 0) {
      this.buffer += chunk.toString('utf8')
    }
    const normalized = this.buffer.replace(/\r\n/g, '\n')
    const blocks = normalized.split('\n\n')
    this.buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n')
      if (!data) continue
      if (data === '[DONE]') {
        out.push(this.finish())
        continue
      }
      const parsed = parseJsonObject(data)
      if (!parsed) continue
      const delta = extractChatTextDelta(parsed)
      if (delta.length > 0) {
        this.text += delta
        out.push(this.event('in_progress', false))
      }
      if (chatFinished(parsed)) {
        out.push(this.finish())
      }
    }

    if (done) {
      out.push(this.finish())
    }
    return out.filter((item) => item.length > 0)
  }

  fromJsonResponse(body: Buffer): Buffer[] {
    const parsed = parseJsonObject(body)
    if (!parsed) {
      return this.error('Invalid response from buyer proxy.')
    }
    const error = parsed['error']
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = typeof (error as Record<string, unknown>)['message'] === 'string'
        ? String((error as Record<string, unknown>)['message'])
        : 'Buyer proxy returned an error.'
      return this.error(message)
    }
    const text = extractChatMessageText(parsed)
    if (text.length === 0) {
      return this.error('Buyer proxy returned an empty response.')
    }
    this.text = text
    return [this.event('in_progress', false), this.finish()].filter((item) => item.length > 0)
  }

  error(message: string): Buffer[] {
    if (this.done) return []
    this.done = true
    const payload = { message: null, conversation_id: this.context.conversationId, error: message }
    return [Buffer.from(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, 'utf8')]
  }

  private finish(): Buffer {
    if (this.done) return Buffer.alloc(0)
    this.done = true
    return Buffer.from(`${this.encodeEvent('finished_successfully', true)}data: [DONE]\n\n`, 'utf8')
  }

  private event(status: 'in_progress' | 'finished_successfully', endTurn: boolean): Buffer {
    if (this.done) return Buffer.alloc(0)
    return Buffer.from(this.encodeEvent(status, endTurn), 'utf8')
  }

  private encodeEvent(status: 'in_progress' | 'finished_successfully', endTurn: boolean): string {
    const metadata: Record<string, unknown> = {
      message_type: 'next',
      parent_id: this.context.assistantParent === 'user-message'
        ? this.context.userMessageId
        : this.context.parentMessageId,
    }
    if (this.context.modelSlug) {
      metadata['model_slug'] = this.context.modelSlug
      metadata['default_model_slug'] = this.context.modelSlug
    }
    if (endTurn) {
      metadata['finish_details'] = { type: 'stop' }
      metadata['is_complete'] = true
    }

    const payload = {
      message: {
        id: this.context.assistantMessageId,
        author: { role: 'assistant', name: null, metadata: {} },
        create_time: this.createdAt,
        update_time: null,
        content: { content_type: 'text', parts: [this.text] },
        status,
        end_turn: endTurn,
        weight: 1,
        metadata,
        recipient: 'all',
        channel: null,
      },
      conversation_id: this.context.conversationId,
      error: null,
      content_references: [],
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }
}

export class ResponsesSseNormalizer {
  private buffer = ''
  private responseId: string | null = null
  private messageItemId: string | null = null

  constructor(
    private readonly options: Extract<SystemProxyResponseTransform, { kind: 'responses-sse' }>,
  ) {}

  feed(chunk: Buffer, done: boolean): Buffer[] {
    const out: Buffer[] = []
    if (chunk.length > 0) {
      this.buffer += chunk.toString('utf8')
    }

    const normalized = this.buffer.replace(/\r\n/g, '\n')
    const blocks = normalized.split('\n\n')
    this.buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      out.push(Buffer.from(this.normalizeBlock(block), 'utf8'))
    }

    if (done && this.buffer.trim().length > 0) {
      out.push(Buffer.from(this.normalizeBlock(this.buffer), 'utf8'))
      this.buffer = ''
    }

    return out
  }

  private normalizeBlock(block: string): string {
    const lines = block.split('\n')
    const event = lines
      .find((line) => line.startsWith('event: '))
      ?.slice('event: '.length)
      .trim()
    const dataLines = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))

    if (!event || dataLines.length === 0) {
      return `${block}\n\n`
    }

    const data = dataLines.join('\n')
    if (data === '[DONE]') {
      return `data: [DONE]\n\n`
    }

    const parsed = parseJsonObject(data)
    if (!parsed) {
      return `${block}\n\n`
    }

    const response = parsed['response']
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      const id = (response as Record<string, unknown>)['id']
      if (typeof id === 'string' && id.length > 0) {
        this.responseId = id
      }
    }
    if (this.options.injectResponseId && this.responseId && shouldAttachResponseId(event, parsed)) {
      parsed['response_id'] = this.responseId
    }
    if (this.options.stripDataType) {
      delete parsed['type']
    }
    this.normalizeMessageItem(event, parsed)
    if (this.options.emptyContentPartDoneText && event === 'response.content_part.done') {
      const part = parsed['part']
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        parsed['part'] = { ...(part as Record<string, unknown>), text: '' }
      }
    }
    if (this.options.emptyOutputItemDoneContent && event === 'response.output_item.done') {
      const item = parsed['item']
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        parsed['item'] = { ...(item as Record<string, unknown>), content: [] }
      }
    }

    return `event: ${event}\ndata: ${JSON.stringify(parsed)}\n\n`
  }

  private normalizeMessageItem(event: string, parsed: Record<string, unknown>): void {
    if (event === 'response.output_item.added' || event === 'response.output_item.done') {
      const item = parsed['item']
      if (!item || typeof item !== 'object' || Array.isArray(item)) return
      const itemObject = item as Record<string, unknown>
      if (itemObject['type'] !== 'message') return
      const id = typeof itemObject['id'] === 'string' && itemObject['id'].length > 0
        ? itemObject['id']
        : null
      if (id && !this.messageItemId) {
        this.messageItemId = id
      }
      if (this.options.messageOutputIndex !== undefined) {
        parsed['output_index'] = this.options.messageOutputIndex
      }
      if (this.options.messageItemId) {
        itemObject['id'] = this.options.messageItemId
      }
      if (this.options.stripItemPhase) {
        delete itemObject['phase']
      }
      parsed['item'] = itemObject
      return
    }

    const itemId = typeof parsed['item_id'] === 'string' ? parsed['item_id'] : ''
    if (!this.messageItemId || itemId !== this.messageItemId) return
    if (this.options.messageOutputIndex !== undefined) {
      parsed['output_index'] = this.options.messageOutputIndex
    }
    if (this.options.messageItemId) {
      parsed['item_id'] = this.options.messageItemId
    }
  }
}

type ModelDefaultOptions = {
  defaultModel?: string
  servedModels?: Set<string>
}

function resolveSystemProxyModel(rawModel: string, opts: ModelDefaultOptions): string | null {
  const fallback = opts.defaultModel?.trim()
  if (fallback) return fallback

  const requested = rawModel.trim()
  return requested.length > 0 ? requested : null
}

function extractConversationForwardContext(
  raw: Buffer,
  routedBody?: Buffer,
  responseTransform?: Extract<SystemProxyResponseTransform, { kind: 'conversation-sse' }>,
): ConversationForwardContext {
  const parsed = parseJsonObject(raw)
  const routed = routedBody ? parseJsonObject(routedBody) : null
  const conversationId = typeof parsed?.['conversation_id'] === 'string' && parsed['conversation_id'].length > 0
    ? parsed['conversation_id']
    : randomUUID()
  const parentMessageId = typeof parsed?.['parent_message_id'] === 'string' && parsed['parent_message_id'].length > 0
    ? parsed['parent_message_id']
    : 'client-created-root'
  const messages = Array.isArray(parsed?.['messages']) ? parsed['messages'] : []
  const firstMessage = messages[0] && typeof messages[0] === 'object' && !Array.isArray(messages[0])
    ? messages[0] as Record<string, unknown>
    : null
  const userMessageId = typeof firstMessage?.['id'] === 'string' && firstMessage['id'].length > 0
    ? firstMessage['id']
    : randomUUID()
  const userCreateTime = typeof firstMessage?.['create_time'] === 'number'
    ? firstMessage['create_time']
    : null
  const now = Date.now() / 1000
  return {
    conversationId,
    parentMessageId,
    userMessageId,
    assistantMessageId: randomUUID(),
    assistantParent: responseTransform?.assistantParent,
    assistantCreateTime: userCreateTime ? Math.max(now, userCreateTime + 0.001) : now,
    modelSlug: extractRoutedModelSlug(routed?.['model']),
  }
}

function shouldAttachResponseId(event: string, parsed: Record<string, unknown>): boolean {
  if (parsed['response_id'] !== undefined) return false
  if (event === 'response.created' || event === 'response.in_progress' || event === 'response.completed') {
    return false
  }
  return event.startsWith('response.')
}

function extractRoutedModelSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const model = value.trim()
  if (model.length === 0) return undefined
  const at = model.indexOf('@')
  return at >= 0 ? model.slice(at + 1) || undefined : model
}

function parseJsonObject(value: string | Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : value.toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function extractChatTextDelta(parsed: Record<string, unknown>): string {
  const choices = Array.isArray(parsed['choices']) ? parsed['choices'] : []
  const choice = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
    ? choices[0] as Record<string, unknown>
    : null
  const delta = choice?.['delta'] && typeof choice['delta'] === 'object' && !Array.isArray(choice['delta'])
    ? choice['delta'] as Record<string, unknown>
    : null
  return typeof delta?.['content'] === 'string' ? delta['content'] : ''
}

function extractChatMessageText(parsed: Record<string, unknown>): string {
  const choices = Array.isArray(parsed['choices']) ? parsed['choices'] : []
  const choice = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
    ? choices[0] as Record<string, unknown>
    : null
  const message = choice?.['message'] && typeof choice['message'] === 'object' && !Array.isArray(choice['message'])
    ? choice['message'] as Record<string, unknown>
    : null
  return typeof message?.['content'] === 'string' ? message['content'] : ''
}

function chatFinished(parsed: Record<string, unknown>): boolean {
  const choices = Array.isArray(parsed['choices']) ? parsed['choices'] : []
  const choice = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
    ? choices[0] as Record<string, unknown>
    : null
  return typeof choice?.['finish_reason'] === 'string' && choice['finish_reason'].length > 0
}

function extractProfileMessages(messagesRaw: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(messagesRaw)) return []
  const messages: Array<{ role: string; content: string }> = []
  for (const entry of messagesRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const object = entry as Record<string, unknown>
    const author = object['author']
    const role = author && typeof author === 'object' && !Array.isArray(author)
      && typeof (author as Record<string, unknown>)['role'] === 'string'
      ? String((author as Record<string, unknown>)['role'])
      : typeof object['role'] === 'string'
        ? object['role']
        : 'user'
    const content = extractProfileMessageContent(object['content'])
    if (content.length === 0) continue
    messages.push({ role: normalizeConversationRole(role), content })
  }
  return messages
}

function extractProfileMessageContent(contentRaw: unknown): string {
  if (typeof contentRaw === 'string') return contentRaw.trim()
  if (Array.isArray(contentRaw)) {
    return contentRaw
      .map((part) => {
        if (typeof part === 'string') return part.trim()
        if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
        const object = part as Record<string, unknown>
        return typeof object['text'] === 'string' ? object['text'].trim() : ''
      })
      .filter((part) => part.length > 0)
      .join('\n')
  }
  if (!contentRaw || typeof contentRaw !== 'object' || Array.isArray(contentRaw)) return ''
  const content = contentRaw as Record<string, unknown>
  const parts = content['parts']
  if (Array.isArray(parts)) {
    return parts
      .filter((part): part is string => typeof part === 'string')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n')
  }
  if (typeof content['text'] === 'string') {
    return content['text'].trim()
  }
  return ''
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function normalizeConversationRole(role: string): string {
  const normalized = role.trim().toLowerCase()
  if (normalized === 'assistant' || normalized === 'system' || normalized === 'developer') {
    return normalized
  }
  return 'user'
}

export function shouldSystemProxyRequest(host: string, path: string, prefixesByHost: Map<string, Set<string>>): boolean {
  const prefixes = prefixesByHost.get(host)
  if (!prefixes || prefixes.size === 0) return false
  const pathname = normalizeRequestPath(path)
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true
    }
  }
  return false
}

function normalizeRequestPath(path: string): string {
  try {
    return new URL(path, 'https://local.invalid').pathname
  } catch {
    return path.split('?')[0] || '/'
  }
}

function formatSystemProxyRoutes(prefixesByHost: Map<string, Set<string>>): string {
  const parts: string[] = []
  for (const [host, prefixes] of prefixesByHost.entries()) {
    parts.push(`${host}(${[...prefixes].join(',')})`)
  }
  return parts.join('; ') || '(none)'
}

function closeServer(server: http.Server | https.Server | net.Server | null): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server) { resolve(); return }
    server.close(() => resolve())
  })
}
