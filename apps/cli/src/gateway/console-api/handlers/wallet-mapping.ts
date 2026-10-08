/** Pure mapping from buyer-daemon and chain responses to the console's wallet shapes. */
import type { AntsChainConfig, RewardsView } from '@antseed/ants'
import { formatAntsExact } from '@antseed/ants'
import { getChainConfig } from '@antseed/node'
import type { Channel, ChainInfo, DepositWatch, Rewards, Usdc, Wallet } from '../types.js'

const USDC_DECIMALS = 6
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

function count(value: unknown): number | null {
  let numeric = Number.NaN
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && value !== '') numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

/** USDC base units ("1500000") as a decimal string ("1.500000"); bigint-safe. */
export function baseUnitsToUsdc(value: unknown): Usdc {
  const raw = text(value)
  if (raw === null || !/^-?\d+$/.test(raw)) return '0.000000'
  const amount = BigInt(raw)
  const sign = amount < 0n ? '-' : ''
  const abs = amount < 0n ? -amount : amount
  const scale = 10n ** BigInt(USDC_DECIMALS)
  return `${sign}${abs / scale}.${(abs % scale).toString().padStart(USDC_DECIMALS, '0')}`
}

/** A decimal USDC string from the buyer, normalized to 6 decimals; numbers are accepted too. */
export function decimalUsdc(value: unknown): Usdc {
  const raw = text(value)?.trim() ?? ''
  if (!DECIMAL_RE.test(raw)) return '0.000000'
  const negative = raw.startsWith('-')
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.')
  return `${negative ? '-' : ''}${BigInt(whole!)}.${fraction.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS)}`
}

function optionalAddress(value: unknown): string | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) && !/^0x0{40}$/.test(value) ? value : null
}

/** `GET /_antseed/balances` → the balance half of `Wallet`. */
export function mapBalances(body: unknown): Omit<Wallet, 'buyerIdentity' | 'deposit'> {
  const raw = record(body)
  const creditLimit = raw['creditLimit']
  return {
    address: typeof raw['address'] === 'string' ? raw['address'] : '',
    available: decimalUsdc(raw['available']),
    reserved: decimalUsdc(raw['reserved']),
    walletUsdc: decimalUsdc(raw['walletUsdc']),
    creditLimit: creditLimit === null || creditLimit === undefined ? null : decimalUsdc(creditLimit),
    operator: optionalAddress(raw['operator']),
  }
}

/**
 * `GET /_antseed/deposits/status` → `DepositWatch` for one wallet. The buyer
 * exposes a single watcher (the default identity's); other wallets are
 * auto-swept by watchers it does not expose, so they read as `off` here.
 */
export function mapDepositWatch(body: unknown, walletAddress: string | null): DepositWatch {
  const raw = record(body)
  const status = raw['status'] && typeof raw['status'] === 'object' ? record(raw['status']) : null
  if (raw['watcher'] !== true || !status) {
    const reason = text(raw['reason'])
    return { mode: 'off', status: reason ?? 'unavailable', lastTxHash: null }
  }
  const watched = text(status['address'])
  if (!walletAddress || !watched || watched.toLowerCase() !== walletAddress.toLowerCase()) {
    return { mode: 'off', status: 'not-watched', lastTxHash: null }
  }
  const mode = status['mode'] === 'active' ? 'active' : status['mode'] === 'background' || status['mode'] === 'idle' ? 'background' : 'off'
  const lastEvent = status['lastEvent'] ? record(status['lastEvent']) : null
  const phase = lastEvent ? text(lastEvent['phase']) : null
  const label = status['sweepInFlight'] === true ? 'sweeping' : phase ?? (mode === 'off' ? 'stopped' : 'watching')
  return { mode, status: label, lastTxHash: lastEvent ? text(lastEvent['txHash']) : null }
}

/** One row of `GET /_antseed/channels` → `Channel`; null for a row without an id. */
export function mapChannel(value: unknown): Channel | null {
  const raw = record(value)
  const channelId = text(raw['channelId']) ?? text(raw['sessionId'])
  if (!channelId) return null
  const status = text(raw['status']) || 'unknown'
  const reserved = text(raw['reserveCeiling']) ?? text(raw['onChainDeposit']) ?? '0'
  const spent = text(raw['cumulativeSigned']) ?? text(raw['latestCumulativeAmount']) ?? '0'
  const name = text(raw['sellerDisplayName'])?.trim()
  return {
    channelId,
    peerId: text(raw['peerId']) ?? text(raw['sellerPeerId']) ?? '',
    sellerName: name ? name : null,
    status,
    reserved: baseUnitsToUsdc(reserved),
    spent: baseUnitsToUsdc(spent),
    openedAt: count(raw['reservedAt']),
    canCooperativeClose: raw['cooperativeCloseSupported'] === true && (status === 'active' || status === 'open'),
  }
}

export function mapChannels(body: unknown): Channel[] {
  const rows = record(body)['channels']
  return Array.isArray(rows) ? rows.map(mapChannel).filter((row): row is Channel => row !== null) : []
}

/** Buyer-side rewards only, like the desktop's VPR summary: usage rewards plus legacy buyer emissions. */
export function mapRewards(view: RewardsView, address: string): Rewards {
  const pending = BigInt(view.buyerUsage.total || '0') + BigInt(view.legacy.buyer || '0')
  return {
    address,
    pendingAnts: formatAntsExact(pending),
    // Claimed amounts are not readable per epoch (a claimed epoch reads as 0 pending).
    claimedAnts: '0',
    epochs: view.buyerUsage.epochs.map((row) => ({ epoch: row.epoch, pendingAnts: formatAntsExact(row.amount || '0'), claimed: row.claimed === true })),
    operator: view.buyerUsage.operator,
  }
}

const EXPLORERS: Record<number, string> = {
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
}

/**
 * `ChainInfo` for the browser. The RPC URL is the chain's public default,
 * never the operator's configured endpoint, which often embeds an API key.
 */
export function chainInfo(chain: AntsChainConfig): ChainInfo {
  const contracts: Record<string, string> = {}
  for (const [key, value] of Object.entries(chain as unknown as Record<string, unknown>)) {
    if (!/Address$/.test(key) || typeof value !== 'string' || !ADDRESS_RE.test(value)) continue
    contracts[key.replace(/(Contract)?Address$/, '')] = value
  }
  let rpcUrl: string | null = null
  try {
    const defaults = getChainConfig(chain.chainId)
    if (defaults.evmChainId === chain.evmChainId) rpcUrl = defaults.rpcUrl
  } catch {
    // Unknown chain id: fall through to the configured URLs.
  }
  // Without a known public default, only a configured URL that cannot carry
  // a key (no path, query or credentials, or a loopback node) is passed on.
  rpcUrl ??= [chain.rpcUrl, ...(chain.fallbackRpcUrls ?? [])].find(isKeylessRpcUrl) ?? ''
  return {
    chainId: chain.evmChainId,
    name: chain.chainId,
    rpcUrl,
    explorerUrl: EXPLORERS[chain.evmChainId] ?? null,
    contracts,
  }
}

function isKeylessRpcUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') return true
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && (url.pathname === '/' || url.pathname === '')
  } catch {
    return false
  }
}
