/**
 * The JSON-RPC client every chain read in the buyer and gateway processes
 * goes through: one provider per chain per process (`sharedChainProvider`),
 * so public endpoints (mainnet.base.org and friends) that throttle per IP
 * see as few requests as possible.
 *
 * - Identical reads in flight at once share one request.
 * - `eth_call`s issued together (a `Promise.all` of contract reads, one
 *   tick of the deposit watcher for N wallets) are folded into a single
 *   Multicall3 `aggregate3` call.
 * - Chain constants (`eth_chainId`, deployed contract code) are remembered.
 * - An endpoint that answers 429 / JSON-RPC -32005 / 5xx / a network error
 *   is skipped for an exponentially growing, jittered period and the call
 *   moves to the next endpoint. When every endpoint is backing off the call
 *   fails at once with `RpcUnavailableError` without touching the network,
 *   so callers serve cached data instead of hammering.
 * - Requests are paced per endpoint so a burst never exceeds a few per second.
 */
import { FetchRequest, Interface, JsonRpcProvider, Network, type JsonRpcPayload, type JsonRpcResult } from 'ethers'

export interface RpcTransportResponse {
  status: number
  /** Parsed JSON body, or null when the body is not JSON. */
  body: unknown
  /** From a `Retry-After` header, when the endpoint sent one. */
  retryAfterMs?: number | null
}
export type RpcTransport = (url: string, body: string) => Promise<RpcTransportResponse>

export interface ChainRpcOptions {
  transport?: RpcTransport
  now?: () => number
  random?: () => number
  /** How long concurrent `eth_call`s are collected into one Multicall3 call; null disables batching. */
  batchWindowMs?: number | null
  /** Calls per Multicall3 batch. */
  maxBatchSize?: number
  /** First back-off after an endpoint throttles or fails; doubles per consecutive failure. */
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** Sustained requests per second per endpoint (bursts of the same size are allowed). */
  requestsPerSecond?: number
  multicallAddress?: string
}

export interface ChainRpcStats {
  /** HTTP requests sent to RPC endpoints. */
  requests: number
  /** JSON-RPC calls asked of the provider, by method (before coalescing, batching and caching). */
  calls: Record<string, number>
  coalesced: number
  /** `eth_call`s that went out inside a Multicall3 batch. */
  batchedCalls: number
  cacheHits: number
  rateLimited: number
  /** Calls refused locally because every endpoint was backing off. */
  shortCircuited: number
}

/** Every endpoint is backing off (or just failed); serve cached data and retry after `retryAt`. */
export class RpcUnavailableError extends Error {
  readonly code = 'RPC_UNAVAILABLE'
  constructor(message: string, readonly retryAt: number) {
    super(message)
    this.name = 'RpcUnavailableError'
  }
}

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
const REQUEST_TIMEOUT_MS = 10_000
const RATE_LIMIT_CODE = -32005
const CODE_CACHE_MS = 60 * 60_000
const EMPTY_CODE_CACHE_MS = 10 * 60_000
const COALESCED_METHODS = new Set(['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_blockNumber', 'eth_getTransactionReceipt', 'eth_chainId', 'eth_getTransactionCount'])
const MULTICALL = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
])

interface Endpoint {
  url: string
  failures: number
  openUntil: number
  tokens: number
  refilledAt: number
}

interface QueuedCall {
  payload: JsonRpcPayload
  tx: { to: string; data: string }
  resolve: (result: JsonRpcResult) => void
  reject: (error: unknown) => void
}

let nextInternalId = 1_000_000_000

export class ChainRpcProvider extends JsonRpcProvider {
  private readonly endpoints: Endpoint[]
  private readonly transport: RpcTransport
  private readonly now: () => number
  private readonly random: () => number
  private readonly batchWindowMs: number | null
  private readonly maxBatchSize: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly rps: number
  private readonly multicallAddress: string
  private readonly inflight = new Map<string, Promise<JsonRpcResult>>()
  private readonly constants = new Map<string, { result: unknown; until: number }>()
  private queue: QueuedCall[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private multicall: Promise<boolean> | null = null
  private readonly counters: ChainRpcStats = { requests: 0, calls: {}, coalesced: 0, batchedCalls: 0, cacheHits: 0, rateLimited: 0, shortCircuited: 0 }

  constructor(urls: string[], evmChainId?: number, options: ChainRpcOptions = {}) {
    const unique = [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
    if (unique.length === 0) throw new Error('At least one RPC endpoint is required.')
    super(unique[0], evmChainId ? Network.from(evmChainId) : undefined, { staticNetwork: !!evmChainId, batchMaxCount: 1 })
    this.now = options.now ?? Date.now
    this.rps = options.requestsPerSecond ?? 8
    this.endpoints = unique.map((url) => ({ url, failures: 0, openUntil: 0, tokens: this.rps, refilledAt: this.now() }))
    this.transport = options.transport ?? fetchTransport
    this.random = options.random ?? Math.random
    this.batchWindowMs = options.batchWindowMs === undefined ? 5 : options.batchWindowMs
    this.maxBatchSize = options.maxBatchSize ?? 50
    this.backoffBaseMs = options.backoffBaseMs ?? 2_000
    this.backoffMaxMs = options.backoffMaxMs ?? 5 * 60_000
    this.multicallAddress = options.multicallAddress ?? MULTICALL3_ADDRESS
  }

  get urls(): string[] {
    return this.endpoints.map((endpoint) => endpoint.url)
  }

  stats(): ChainRpcStats {
    return { ...this.counters, calls: { ...this.counters.calls } }
  }

  /** When the next request could go out; 0 while some endpoint is usable. */
  get unavailableUntil(): number {
    const now = this.now()
    if (this.endpoints.some((endpoint) => endpoint.openUntil <= now)) return 0
    return Math.min(...this.endpoints.map((endpoint) => endpoint.openUntil))
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    if (Array.isArray(payload)) return Promise.all(payload.map((entry) => this.one(entry)))
    return [await this.one(payload)]
  }

  private async one(payload: JsonRpcPayload): Promise<JsonRpcResult> {
    this.counters.calls[payload.method] = (this.counters.calls[payload.method] ?? 0) + 1
    const key = JSON.stringify([payload.method, payload.params])
    const constant = this.constants.get(key)
    if (constant && constant.until > this.now()) {
      this.counters.cacheHits++
      return { id: payload.id, result: constant.result } as JsonRpcResult
    }
    const coalesce = COALESCED_METHODS.has(payload.method)
    const pending = coalesce ? this.inflight.get(key) : undefined
    if (pending) {
      this.counters.coalesced++
      return { ...await pending, id: payload.id }
    }
    const task = this.batchable(payload) ? this.enqueue(payload) : this.request(payload)
    if (coalesce) this.inflight.set(key, task)
    try {
      const result = await task
      this.remember(key, payload, result)
      return { ...result, id: payload.id }
    } finally {
      if (coalesce && this.inflight.get(key) === task) this.inflight.delete(key)
    }
  }

  /** `eth_chainId` forever; contract code for an hour (an empty account for ten minutes). */
  private remember(key: string, payload: JsonRpcPayload, result: JsonRpcResult): void {
    if (!('result' in result)) return
    if (payload.method === 'eth_chainId') {
      this.constants.set(key, { result: result.result, until: Number.POSITIVE_INFINITY })
    } else if (payload.method === 'eth_getCode' && Array.isArray(payload.params) && (payload.params[1] ?? 'latest') === 'latest') {
      const empty = result.result === '0x'
      this.constants.set(key, { result: result.result, until: this.now() + (empty ? EMPTY_CODE_CACHE_MS : CODE_CACHE_MS) })
    }
  }

  private batchable(payload: JsonRpcPayload): boolean {
    if (this.batchWindowMs === null || payload.method !== 'eth_call' || !Array.isArray(payload.params)) return false
    const [tx, block] = payload.params as [Record<string, unknown> | undefined, unknown]
    if (!tx || typeof tx !== 'object' || (block !== undefined && block !== 'latest')) return false
    if (typeof tx['to'] !== 'string' || tx['to'].toLowerCase() === this.multicallAddress.toLowerCase()) return false
    return Object.keys(tx).every((field) => field === 'to' || field === 'data' || field === 'input')
  }

  private enqueue(payload: JsonRpcPayload): Promise<JsonRpcResult> {
    const tx = (payload.params as Array<Record<string, string>>)[0]!
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, tx: { to: tx['to']!, data: tx['data'] ?? tx['input'] ?? '0x' }, resolve, reject })
      if (this.queue.length >= this.maxBatchSize) {
        this.flushSoon(0)
      } else {
        this.flushSoon(this.batchWindowMs ?? 0)
      }
    })
  }

  private flushSoon(delayMs: number): void {
    if (this.flushTimer && delayMs > 0) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      while (this.queue.length > 0) void this.flush(this.queue.splice(0, this.maxBatchSize))
    }, delayMs)
  }

  private async flush(batch: QueuedCall[]): Promise<void> {
    if (batch.length === 1 || !await this.multicallDeployed().catch(() => false)) {
      await Promise.all(batch.map(async (call) => {
        try {
          call.resolve(await this.request(call.payload))
        } catch (error) {
          call.reject(error)
        }
      }))
      return
    }
    const data = MULTICALL.encodeFunctionData('aggregate3', [batch.map((call) => ({ target: call.tx.to, allowFailure: true, callData: call.tx.data }))])
    let response: unknown
    try {
      response = await this.transmit({ jsonrpc: '2.0', id: nextInternalId++, method: 'eth_call', params: [{ to: this.multicallAddress, data }, 'latest'] })
    } catch (error) {
      for (const call of batch) call.reject(error)
      return
    }
    const body = response as { result?: string; error?: unknown } | null
    let decoded: Array<{ success: boolean; returnData: string }> | null = null
    if (body && typeof body.result === 'string') {
      try {
        decoded = MULTICALL.decodeFunctionResult('aggregate3', body.result)[0] as Array<{ success: boolean; returnData: string }>
      } catch {
        decoded = null
      }
    }
    if (!decoded || decoded.length !== batch.length) {
      // The aggregate itself failed (gas cap, a node quirk): fall back to one call each.
      await Promise.all(batch.map(async (call) => {
        try {
          call.resolve(await this.request(call.payload))
        } catch (error) {
          call.reject(error)
        }
      }))
      return
    }
    this.counters.batchedCalls += batch.length
    batch.forEach((call, index) => {
      const entry = decoded![index]!
      call.resolve(entry.success
        ? { id: call.payload.id, result: entry.returnData } as JsonRpcResult
        : { id: call.payload.id, error: { code: 3, message: 'execution reverted', data: entry.returnData } } as unknown as JsonRpcResult)
    })
  }

  /** Multicall3 is probed once per process (its code is then cached like any other). */
  private multicallDeployed(): Promise<boolean> {
    this.multicall ??= this.one({ jsonrpc: '2.0', id: nextInternalId++, method: 'eth_getCode', params: [this.multicallAddress, 'latest'] } as JsonRpcPayload)
      .then((result) => 'result' in result && typeof result.result === 'string' && result.result !== '0x')
      .catch((error: unknown) => {
        this.multicall = null
        throw error
      })
    return this.multicall
  }

  private async request(payload: JsonRpcPayload): Promise<JsonRpcResult> {
    const body = await this.transmit(payload)
    const entry = Array.isArray(body) ? body[0] : body
    if (!entry || typeof entry !== 'object') throw new Error('The RPC endpoint returned an empty response.')
    return { ...(entry as JsonRpcResult), id: payload.id }
  }

  /** Sends one payload to the first endpoint not backing off, moving on when one throttles or fails. */
  private async transmit(payload: object): Promise<unknown> {
    const body = JSON.stringify(payload)
    let lastError: Error | null = null
    let attempted = false
    for (const endpoint of this.endpoints) {
      if (endpoint.openUntil > this.now()) continue
      attempted = true
      await this.pace(endpoint)
      this.counters.requests++
      let response: RpcTransportResponse
      try {
        response = await this.transport(endpoint.url, body)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.trip(endpoint, null)
        continue
      }
      if (response.status === 429 || isRateLimited(response.body)) {
        this.counters.rateLimited++
        this.trip(endpoint, response.retryAfterMs ?? null)
        lastError = new RpcUnavailableError(`${redact(endpoint.url)} is rate limiting requests`, endpoint.openUntil)
        continue
      }
      if (response.status >= 500 || response.status === 401 || response.status === 403) {
        this.trip(endpoint, response.retryAfterMs ?? null)
        lastError = new RpcUnavailableError(`${redact(endpoint.url)} responded with HTTP ${response.status}`, endpoint.openUntil)
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${redact(endpoint.url)} responded with HTTP ${response.status}`)
      }
      endpoint.failures = 0
      return response.body
    }
    if (!attempted) {
      this.counters.shortCircuited++
      const retryAt = this.unavailableUntil
      throw new RpcUnavailableError(`Every RPC endpoint is backing off after errors or rate limits; retrying in ${Math.max(1, Math.ceil((retryAt - this.now()) / 1000))} s.`, retryAt)
    }
    if (lastError instanceof RpcUnavailableError) throw lastError
    throw new RpcUnavailableError(lastError?.message ?? 'The RPC endpoints did not answer.', this.unavailableUntil || this.now())
  }

  /** Exponential back-off with "equal jitter": half the delay fixed, half random. */
  private trip(endpoint: Endpoint, retryAfterMs: number | null): void {
    endpoint.failures++
    const exponential = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(endpoint.failures - 1, 20))
    const delay = exponential / 2 + this.random() * exponential / 2
    endpoint.openUntil = this.now() + Math.max(delay, Math.min(retryAfterMs ?? 0, this.backoffMaxMs))
  }

  private async pace(endpoint: Endpoint): Promise<void> {
    for (;;) {
      const now = this.now()
      endpoint.tokens = Math.min(this.rps, endpoint.tokens + (now - endpoint.refilledAt) * this.rps / 1000)
      endpoint.refilledAt = now
      if (endpoint.tokens >= 1) {
        endpoint.tokens -= 1
        return
      }
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((1 - endpoint.tokens) * 1000 / this.rps)))
    }
  }

  override destroy(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const call of this.queue.splice(0)) call.reject(new Error('provider destroyed'))
    super.destroy()
  }
}

function isRateLimited(body: unknown): boolean {
  const entries = Array.isArray(body) ? body : [body]
  return entries.some((entry) => {
    const error = (entry as { error?: { code?: number; message?: string } } | null)?.error
    return !!error && (error.code === RATE_LIMIT_CODE || /rate.?limit|too many requests|exceeded .*capacity/i.test(String(error.message ?? '')))
  })
}

/** An RPC URL without its path or query, which is where providers put API keys. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.length > 1 || parsed.search ? '/…' : ''}`
  } catch {
    return 'RPC endpoint'
  }
}

function retryAfter(value: string | null | undefined): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

async function fetchTransport(url: string, body: string): Promise<RpcTransportResponse> {
  const request = new FetchRequest(url)
  request.timeout = REQUEST_TIMEOUT_MS
  request.retryFunc = async () => false
  request.setThrottleParams({ maxAttempts: 1 })
  request.setHeader('content-type', 'application/json')
  request.body = body
  const response = await request.send()
  let parsed: unknown = null
  try {
    parsed = response.bodyJson
  } catch {
    parsed = null
  }
  return { status: response.statusCode, body: parsed, retryAfterMs: retryAfter(response.getHeader('retry-after')) }
}

export interface ChainRpcTarget {
  evmChainId: number
  rpcUrl: string
  fallbackRpcUrls?: string[]
}

const shared = new Map<string, ChainRpcProvider>()

/** The process's provider for a chain and endpoint list; built once, reused by every reader. */
export function sharedChainProvider(chain: ChainRpcTarget, options?: ChainRpcOptions): ChainRpcProvider {
  const urls = [chain.rpcUrl, ...(chain.fallbackRpcUrls ?? [])]
  const key = `${chain.evmChainId}|${urls.join('|')}`
  let provider = shared.get(key)
  if (!provider) {
    provider = new ChainRpcProvider(urls, chain.evmChainId, options)
    shared.set(key, provider)
  }
  return provider
}

/** For tests. */
export function resetSharedChainProviders(): void {
  for (const provider of shared.values()) provider.destroy()
  shared.clear()
}
