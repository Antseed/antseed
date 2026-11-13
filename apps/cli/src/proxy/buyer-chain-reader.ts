/**
 * Cached, batched chain reads for the buyer's wallets: what
 * `GET /_antseed/balances` and the deposit watchers need. All reads go
 * through one shared provider, so the four reads behind a balance refresh
 * leave as a single Multicall3 `eth_call`, and the watchers' per-tick USDC
 * balance reads for every wallet leave as one more.
 */
import { Contract, type AbstractProvider } from 'ethers'
import { ChainReadCache } from './chain-read-cache.js'
import type { DepositWatcherRelayReader } from './deposit-watcher.js'

/** Seconds-scale balances; operator and credit limit change only by an owner's transaction. */
export const BALANCE_TTL_MS = 15_000
export const ACCOUNT_SETTINGS_TTL_MS = 5 * 60_000

const DEPOSITS_ABI = [
  'function getBuyerBalance(address buyer) view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) view returns (uint256)',
  'function getOperator(address buyer) view returns (address)',
]
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)']

export interface BuyerChainReaderOptions {
  provider: AbstractProvider
  depositsAddress: string
  usdcAddress: string
  cache?: ChainReadCache
}

/** The uncached reads, against the shared provider (each is one `eth_call`, batched with its neighbours). */
export class BuyerChainReads {
  private readonly deposits: Contract
  private readonly usdc: Contract

  constructor(options: Omit<BuyerChainReaderOptions, 'cache'>) {
    this.deposits = new Contract(options.depositsAddress, DEPOSITS_ABI, options.provider)
    this.usdc = new Contract(options.usdcAddress, ERC20_ABI, options.provider)
  }

  async getBuyerBalance(address: string): Promise<{ available: bigint; reserved: bigint }> {
    const [available, reserved] = await this.deposits.getFunction('getBuyerBalance').staticCall(address) as [bigint, bigint]
    return { available, reserved }
  }

  async getBuyerCreditLimit(address: string): Promise<bigint> {
    return await this.deposits.getFunction('getBuyerCreditLimit').staticCall(address) as bigint
  }

  async getOperator(address: string): Promise<string> {
    return await this.deposits.getFunction('getOperator').staticCall(address) as string
  }

  async getUSDCBalance(address: string): Promise<bigint> {
    return await this.usdc.getFunction('balanceOf').staticCall(address) as bigint
  }

  /** USDC wallet balances of many addresses; the calls go out together, so one Multicall3 request. */
  async getUSDCBalances(addresses: string[]): Promise<Map<string, bigint>> {
    const values = await Promise.all(addresses.map((address) => this.getUSDCBalance(address)))
    return new Map(addresses.map((address, index) => [address.toLowerCase(), values[index]!]))
  }
}

/**
 * `BuyerBalanceReader` over a TTL cache: balances for 15 s, operator and
 * credit limit for 5 min. Failed refreshes serve the last value (see
 * `ChainReadCache`); `isStale(address)` reports whether that happened.
 */
export class CachedBuyerChainReader {
  readonly reads: BuyerChainReads
  readonly cache: ChainReadCache
  private readonly staleAddresses = new Set<string>()

  constructor(options: BuyerChainReaderOptions) {
    this.reads = new BuyerChainReads(options)
    this.cache = options.cache ?? new ChainReadCache()
  }

  getBuyerBalance(address: string): Promise<{ available: bigint; reserved: bigint }> {
    return this.read(`balance:${key(address)}`, BALANCE_TTL_MS, address, () => this.reads.getBuyerBalance(address))
  }

  getUSDCBalance(address: string): Promise<bigint> {
    return this.read(`usdc:${key(address)}`, BALANCE_TTL_MS, address, () => this.reads.getUSDCBalance(address))
  }

  getBuyerCreditLimit(address: string): Promise<bigint> {
    return this.read(`creditLimit:${key(address)}`, ACCOUNT_SETTINGS_TTL_MS, address, () => this.reads.getBuyerCreditLimit(address))
  }

  getOperator(address: string): Promise<string> {
    return this.read(`operator:${key(address)}`, ACCOUNT_SETTINGS_TTL_MS, address, () => this.reads.getOperator(address))
  }

  /**
   * USDC balances for the deposit watchers' tick: wallets read within
   * `maxAgeMs` (by a balance request a moment ago) are answered from the
   * cache, the rest in one batched read whose results are cached in turn.
   */
  async usdcBalancesForWatch(addresses: string[], maxAgeMs: number): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>()
    const missing: string[] = []
    for (const address of addresses) {
      const age = this.cache.age(`usdc:${key(address)}`)
      const cached = this.cache.peek<bigint>(`usdc:${key(address)}`)
      if (cached && age !== null && age < maxAgeMs) result.set(key(address), cached.value)
      else missing.push(address)
    }
    if (missing.length > 0) {
      const read = await this.reads.getUSDCBalances(missing)
      this.noteUsdcBalances(read)
      for (const [address, balance] of read) result.set(address, balance)
    }
    return result
  }

  /** Records USDC balances the deposit watchers just read, so balance requests reuse them. */
  noteUsdcBalances(balances: Map<string, bigint>): void {
    for (const [address, balance] of balances) this.cache.set(`usdc:${key(address)}`, balance)
  }

  /** Forget everything about an address (after a sweep, or when a caller asks for fresh data). */
  invalidate(address: string): void {
    for (const prefix of ['balance', 'usdc', 'creditLimit', 'operator']) this.cache.invalidate(`${prefix}:${key(address)}`)
  }

  /** Whether the last read for the address had to fall back to cached data. */
  isStale(address: string): boolean {
    return this.staleAddresses.has(key(address))
  }

  private async read<T>(cacheKey: string, ttlMs: number, address: string, load: () => Promise<T>): Promise<T> {
    const result = await this.cache.read(cacheKey, { ttlMs }, load)
    if (result.stale) this.staleAddresses.add(key(address))
    else if (cacheKey.startsWith('balance:')) this.staleAddresses.delete(key(address))
    return result.value
  }
}

/** Relay reads that never change for a deployed contract: its fee and the USDC domain check. */
export function constantRelayReads<T extends DepositWatcherRelayReader>(relay: T): T {
  let fee: Promise<bigint> | null = null
  const domains = new Map<string, Promise<boolean>>()
  return new Proxy(relay, {
    get(target, property, receiver) {
      if (property === 'fee') {
        return () => {
          fee ??= target.fee().catch((error: unknown) => { fee = null; throw error })
          return fee
        }
      }
      if (property === 'verifyUsdcDomain') {
        return (usdc: string, domain: Parameters<DepositWatcherRelayReader['verifyUsdcDomain']>[1]) => {
          const cacheKey = `${usdc.toLowerCase()}|${JSON.stringify(domain)}`
          let verified = domains.get(cacheKey)
          if (!verified) {
            verified = target.verifyUsdcDomain(usdc, domain)
            domains.set(cacheKey, verified)
            // Only a confirmed match is remembered; a failure or mismatch is re-checked next time.
            verified.then((ok) => { if (!ok) domains.delete(cacheKey) }, () => domains.delete(cacheKey))
          }
          return verified
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

function key(address: string): string {
  return address.toLowerCase()
}
