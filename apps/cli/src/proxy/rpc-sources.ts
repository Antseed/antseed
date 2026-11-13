import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Who asked for a chain RPC call: `withRpcSource('standing', () => …)` tags
 * every call made inside (across awaits), and the shared ChainRpcProvider
 * counts them per source. Calls are counted as asked, before coalescing,
 * Multicall batching and caching; `requests` on the provider's stats are the
 * HTTP requests that actually went out.
 */
const current = new AsyncLocalStorage<string>()
const MINUTE_MS = 60_000
const WINDOW_MINUTES = 10

interface SourceCounter {
  total: number
  /** Calls per minute, keyed by minute start, for the last WINDOW_MINUTES. */
  minutes: Map<number, number>
}

const counters = new Map<string, SourceCounter>()
let logTimer: ReturnType<typeof setInterval> | null = null

export function withRpcSource<T>(source: string, run: () => T): T {
  return current.run(source, run)
}

export function currentRpcSource(): string {
  return current.getStore() ?? 'other'
}

export function recordRpcCall(source = currentRpcSource(), now = Date.now()): void {
  let counter = counters.get(source)
  if (!counter) {
    counter = { total: 0, minutes: new Map() }
    counters.set(source, counter)
  }
  counter.total += 1
  const minute = now - (now % MINUTE_MS)
  counter.minutes.set(minute, (counter.minutes.get(minute) ?? 0) + 1)
  for (const key of counter.minutes.keys()) if (key < minute - WINDOW_MINUTES * MINUTE_MS) counter.minutes.delete(key)
  startDebugLog()
}

export interface RpcSourceUsage {
  total: number
  /** Calls in the last full minute. */
  lastMinute: number
  /** Average calls per minute over the last 10 minutes. */
  perMinute: number
}

/** Calls per source in this process since start, and their recent rate. */
export function rpcUsage(now = Date.now()): Record<string, RpcSourceUsage> {
  const minute = now - (now % MINUTE_MS)
  const usage: Record<string, RpcSourceUsage> = {}
  for (const [source, counter] of counters) {
    let windowCalls = 0
    for (const [key, calls] of counter.minutes) if (key >= minute - WINDOW_MINUTES * MINUTE_MS && key < minute) windowCalls += calls
    usage[source] = { total: counter.total, lastMinute: counter.minutes.get(minute - MINUTE_MS) ?? 0, perMinute: Math.round((windowCalls / WINDOW_MINUTES) * 10) / 10 }
  }
  return usage
}

/** With ANTSEED_DEBUG set, one line a minute: `[rpc] calls/min by source`. */
function startDebugLog(): void {
  if (logTimer || !process.env['ANTSEED_DEBUG']) return
  logTimer = setInterval(() => {
    const usage = rpcUsage()
    const line = Object.entries(usage).map(([source, entry]) => `${source}=${entry.lastMinute}/min (total ${entry.total})`).join(' ')
    if (line) console.error(`[rpc] ${line}`)
  }, MINUTE_MS)
  logTimer.unref?.()
}

/** For tests. */
export function resetRpcUsage(): void {
  counters.clear()
}
