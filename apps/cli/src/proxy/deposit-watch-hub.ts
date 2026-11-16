/**
 * One poll loop for every deposit watcher in the buyer daemon. Each tick
 * reads the USDC balance of all wallets that are due in a single batched
 * request (one Multicall3 `eth_call` through the shared provider) and hands
 * each watcher its balance, instead of a timer and a read per wallet.
 *
 * Wallets due within half their interval ride along with a tick that is
 * going out anyway (the batch costs the same one request), so wallets on
 * the same cadence fall into step and a burst of startups is one read.
 */
import type { DepositWatcher, DepositWatchScheduler } from './deposit-watcher.js'

export interface DepositWatchHubOptions {
  /** USDC balances of the given addresses (lower-cased keys); one request for all of them. */
  readBalances: (addresses: string[]) => Promise<Map<string, bigint>>
  /** Called with every successful batch, e.g. to share it with the balance cache. */
  onBalances?: (balances: Map<string, bigint>) => void
  now?: () => number
  /** Collects `pollNow` requests (startup, a console opening the wallet page) into one tick. */
  debounceMs?: number
  /** Floor between ticks after a failed read, doubling up to `maxErrorBackoffMs`. */
  errorBackoffMs?: number
  maxErrorBackoffMs?: number
}

interface Registration {
  intervalMs: number
  nextAt: number
}

export class DepositWatchHub implements DepositWatchScheduler {
  private readonly registrations = new Map<DepositWatcher, Registration>()
  private readonly options: DepositWatchHubOptions
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = 0
  private ticking: Promise<void> | null = null
  private failures = 0
  private blockedUntil = 0
  private stopped = false
  /** Ticks run and balance reads issued, for tests and diagnostics. */
  ticks = 0

  constructor(options: DepositWatchHubOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.registrations.size
  }

  schedule(watcher: DepositWatcher, intervalMs: number | null, options: { pollNow?: boolean } = {}): void {
    if (this.stopped) return
    if (intervalMs === null) {
      this.registrations.delete(watcher)
    } else {
      const existing = this.registrations.get(watcher)
      const now = this.now()
      const nextAt = options.pollNow
        ? now + (this.options.debounceMs ?? 250)
        : Math.min(existing?.nextAt ?? Number.POSITIVE_INFINITY, now + intervalMs)
      this.registrations.set(watcher, { intervalMs, nextAt })
    }
    this.arm()
  }

  stop(): void {
    this.stopped = true
    this.registrations.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Runs one tick now (tests and diagnostics); resolves when the batch has been applied. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.run().finally(() => {
      this.ticking = null
      this.arm()
    })
    return this.ticking
  }

  private arm(): void {
    if (this.stopped || this.ticking) return
    if (this.registrations.size === 0) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      return
    }
    const due = Math.max(this.blockedUntil, Math.min(...[...this.registrations.values()].map((entry) => entry.nextAt)))
    if (this.timer && this.timerAt <= due) return
    if (this.timer) clearTimeout(this.timer)
    this.timerAt = due
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, Math.max(0, due - this.now()))
    this.timer.unref?.()
  }

  private async run(): Promise<void> {
    const now = this.now()
    const due: Array<[DepositWatcher, Registration]> = []
    for (const entry of this.registrations) {
      const [, registration] = entry
      if (registration.nextAt - registration.intervalMs / 2 <= now) due.push(entry)
    }
    if (due.length === 0) return
    for (const [, registration] of due) registration.nextAt = now + registration.intervalMs
    const addresses = [...new Set(due.map(([watcher]) => watcher.address.toLowerCase()))]
    this.ticks++
    let balances: Map<string, bigint>
    try {
      balances = await this.options.readBalances(addresses)
    } catch {
      // The provider is backing off (or the read failed): wait it out rather than retry each tick.
      this.failures++
      const backoff = Math.min(this.options.maxErrorBackoffMs ?? 5 * 60_000, (this.options.errorBackoffMs ?? 15_000) * 2 ** (this.failures - 1))
      this.blockedUntil = this.now() + backoff
      return
    }
    this.failures = 0
    this.blockedUntil = 0
    this.options.onBalances?.(balances)
    for (const [watcher] of due) {
      if (!this.registrations.has(watcher)) continue
      const balance = balances.get(watcher.address.toLowerCase())
      if (balance !== undefined) watcher.applyBalance(balance)
    }
  }
}
