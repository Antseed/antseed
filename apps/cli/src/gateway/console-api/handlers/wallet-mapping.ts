/** Pure mapping from buyer-daemon and chain responses to the console's wallet shapes. */
import type { AntsChainConfig, RewardsView } from '@antseed/ants'
import { formatAntsExact } from '@antseed/ants'
import { getChainConfig } from '@antseed/node'
import { CHANNEL_CLOSE_GRACE_MS, type Channel, type ChainInfo, type DepositWatch, type Rewards, type Usdc, type Wallet } from '../types.js'

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
  // The buyer's channel figures, from the chain records it keeps; absent from a buyer that predates them.
  const channels = raw['channels'] && typeof raw['channels'] === 'object' ? record(raw['channels']) : null
  return {
    address: typeof raw['address'] === 'string' ? raw['address'] : '',
    available: decimalUsdc(raw['available']),
    reserved: decimalUsdc(raw['reserved']),
    walletUsdc: decimalUsdc(raw['walletUsdc']),
    creditLimit: creditLimit === null || creditLimit === undefined ? null : decimalUsdc(creditLimit),
    operator: optionalAddress(raw['operator']),
    ...(channels ? {
      pending: decimalUsdc(channels['pending']),
      heldInChannels: decimalUsdc(channels['held']),
      unaccounted: channels['unaccountedReserved'] === null || channels['unaccountedReserved'] === undefined ? null : decimalUsdc(channels['unaccountedReserved']),
      channelsStale: channels['stale'] === true,
    } : {}),
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
    return { mode: 'off', status: reason ?? 'unavailable', lastTxHash: null, event: null }
  }
  const watched = text(status['address'])
  if (!walletAddress || !watched || watched.toLowerCase() !== walletAddress.toLowerCase()) {
    return { mode: 'off', status: 'not-watched', lastTxHash: null, event: null }
  }
  const mode = status['mode'] === 'active' ? 'active' : status['mode'] === 'background' || status['mode'] === 'idle' ? 'background' : 'off'
  const lastEvent = status['lastEvent'] ? record(status['lastEvent']) : null
  const phase = lastEvent ? text(lastEvent['phase']) : null
  const label = status['sweepInFlight'] === true ? 'sweeping' : phase ?? (mode === 'off' ? 'stopped' : 'watching')
  return { mode, status: label, lastTxHash: lastEvent ? text(lastEvent['txHash']) : null, event: lastEvent ? mapDepositEvent(lastEvent) : null }
}

const DEPOSIT_PHASES = new Set(['received', 'sweeping', 'credited', 'deferred', 'error'])

function mapDepositEvent(raw: Record<string, unknown>): DepositWatch['event'] {
  const phase = text(raw['phase'])
  if (!phase || !DEPOSIT_PHASES.has(phase)) return null
  const amount = text(raw['amountBaseUnits'])
  return {
    seq: count(raw['seq']) ?? 0,
    phase: phase as NonNullable<DepositWatch['event']>['phase'],
    amount: amount === null ? null : baseUnitsToUsdc(amount),
    txHash: text(raw['txHash']),
    error: text(raw['error']),
    at: count(raw['at']) ?? 0,
  }
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
    // Only the live session can be closed by the seller; a buyer that predates `live` omits it.
    canCooperativeClose: raw['cooperativeCloseSupported'] === true && raw['live'] !== false && (status === 'active' || status === 'open'),
    closeRequestedAt: null,
    settled: null,
    held: null,
    unsettled: null,
  }
}

/**
 * A row's chain record as the buyer reports it (`onChain` on each
 * `GET /_antseed/channels` row): AntseedChannels' own record, which the buyer
 * keeps in its channel store, with what the channel holds and what of that
 * the seller can still settle, worked out by the buyer. Amounts are base units.
 */
export interface ReportedChannelRecord {
  /** 0 no record, 1 active, 2 settled, 3 timed out. */
  status: number
  deposit: bigint
  settled: bigint
  /** Unix seconds of the requestClose; 0 when none. */
  closeRequestedAt: bigint
  held: bigint
  unsettled: bigint
}

const OPEN_LOCAL_STATUSES = new Set(['active', 'open'])

/**
 * A channel as the chain has it. The store's status only says whether the
 * buyer still uses the session: a session it gave up on can still be an open
 * channel holding a reserve, and a seller's settle or close is not always
 * observed. Its `reserveCeiling` also falls back to the configured maximum.
 * Where the buyer reports the chain's record, the record decides; a row with
 * none keeps what the store says. Status 0 (no record on chain, e.g. a reserve
 * still landing) keeps the local row until its reserve deadline passes: the
 * reserve can no longer land then, so a row the buyer still calls open is
 * 'expired' and holds nothing.
 */
export function applyChannelChainState(channel: Channel, state: ReportedChannelRecord | undefined, nowSeconds: number, deadline: number | null = null): Channel {
  if (!state) return channel
  if (state.status === 0) {
    return OPEN_LOCAL_STATUSES.has(channel.status) && deadline !== null && deadline > 0 && nowSeconds > deadline
      ? { ...channel, status: 'expired', reserved: '0.000000', canCooperativeClose: false }
      : channel
  }
  const open = state.status === 1
  const settled = baseUnitsToUsdc(state.settled)
  // A retired row the seller settled in full holds nothing: it stays retired,
  // not an open channel with nothing to close.
  if (open && state.held === 0n && !OPEN_LOCAL_STATUSES.has(channel.status)) {
    return { ...channel, reserved: '0.000000', settled, held: '0.000000', unsettled: '0.000000', canCooperativeClose: false }
  }
  // Open on-chain, whatever the store calls it. A retired row is not the live
  // session, so it never offers the seller's close (`canCooperativeClose` is
  // already false for it).
  let status = OPEN_LOCAL_STATUSES.has(channel.status) ? channel.status : 'active'
  if (state.status === 2) status = 'settled'
  else if (state.status === 3) status = 'timedout'
  else if (state.closeRequestedAt > 0n) status = BigInt(nowSeconds) * 1000n < state.closeRequestedAt * 1000n + BigInt(CHANNEL_CLOSE_GRACE_MS) ? 'closing' : 'withdrawable'
  return {
    ...channel,
    status,
    reserved: open ? baseUnitsToUsdc(state.deposit) : '0.000000',
    canCooperativeClose: channel.canCooperativeClose && open && state.closeRequestedAt === 0n,
    closeRequestedAt: open && state.closeRequestedAt > 0n ? Number(state.closeRequestedAt) * 1000 : null,
    settled,
    held: baseUnitsToUsdc(open ? state.held : 0n),
    unsettled: baseUnitsToUsdc(open ? state.unsettled : 0n),
  }
}

/** Each buyer channel row's reserve `deadline` (unix seconds), by channel id. */
export function channelDeadlines(body: unknown): Map<string, number> {
  const rows = record(body)['channels']
  const deadlines = new Map<string, number>()
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = record(row)
    const id = text(raw['channelId']) ?? text(raw['sessionId'])
    const deadline = count(raw['deadline'])
    if (id && deadline !== null) deadlines.set(id, deadline)
  }
  return deadlines
}

/**
 * The record the buyer reports with each row (`onChain`), by channel id. Rows
 * the chain has not been read for yet, and every row from a buyer that
 * predates reporting records, are left out: they keep what the store says.
 */
export function channelChainStates(body: unknown): Map<string, ReportedChannelRecord> {
  const states = new Map<string, ReportedChannelRecord>()
  for (const row of Array.isArray(record(body)['channels']) ? record(body)['channels'] as unknown[] : []) {
    const channel = record(row)
    const id = text(channel['channelId']) ?? text(channel['sessionId'])
    const onChain = record(channel['onChain'])
    const status = onChain['status']
    if (!id || typeof status !== 'number' || !Number.isInteger(status)) continue
    try {
      const deposit = BigInt(text(onChain['deposit']) ?? '0')
      const settled = BigInt(text(onChain['settled']) ?? '0')
      states.set(id, {
        status,
        deposit,
        settled,
        closeRequestedAt: BigInt(count(onChain['closeRequestedAt']) ?? 0),
        held: BigInt(text(onChain['held']) ?? (status === 1 && deposit > settled ? (deposit - settled).toString() : '0')),
        unsettled: BigInt(text(onChain['unsettled']) ?? '0'),
      })
    } catch {
      // A malformed amount: the row keeps what the buyer's store says.
    }
  }
  return states
}

export function mapChannels(body: unknown): Channel[] {
  const rows = record(body)['channels']
  return Array.isArray(rows) ? rows.map(mapChannel).filter((row): row is Channel => row !== null) : []
}

/** Buyer-side rewards only, like the desktop's VPR summary: usage rewards plus legacy buyer emissions, each claimable on its own. */
export function mapRewards(view: RewardsView & { legacyEpochs?: number[] }, address: string): Rewards {
  const legacyBuyer = BigInt(view.legacy.buyer || '0')
  const pending = BigInt(view.buyerUsage.total || '0') + legacyBuyer
  const legacyEpochs = view.legacyEpochs ?? []
  return {
    address,
    pendingAnts: formatAntsExact(pending),
    // Claimed amounts are not readable per epoch (a claimed epoch reads as 0 pending).
    claimedAnts: '0',
    epochs: view.buyerUsage.epochs.map((row) => ({ epoch: row.epoch, pendingAnts: formatAntsExact(row.amount || '0'), claimed: row.claimed === true })),
    legacy: legacyBuyer > 0n && view.legacy.contract && legacyEpochs.length > 0
      ? { pendingAnts: formatAntsExact(legacyBuyer), contract: view.legacy.contract, epochs: legacyEpochs }
      : null,
    operator: view.buyerUsage.operator,
  }
}

const EXPLORERS: Record<number, string> = {
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
}

/**
 * `ChainInfo` for the browser. The RPC URL is the chain's public default,
 * never the operator's configured endpoint, which often embeds an API key
 * or reaches a private node; a chain without a known default gets none.
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
    // Unknown chain id: no public default to offer.
  }
  return {
    chainId: chain.evmChainId,
    name: chain.chainId,
    rpcUrl,
    explorerUrl: EXPLORERS[chain.evmChainId] ?? null,
    contracts,
  }
}
