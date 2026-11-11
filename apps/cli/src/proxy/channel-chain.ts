/**
 * The chain's view of the buyer's stored payment channels, reported by
 * `GET /_antseed/channels?all=1` so every host (desktop, gateway console,
 * `antseed buyer activity`) renders the same answer instead of joining the
 * store with the chain itself.
 *
 * The store's status is a hint: the buyer retires a row when it gives up on a
 * session, which leaves the channel open with its reserve locked, and a
 * seller's settle or close is not always observed. The chain decides.
 */
import { multicallRead } from '@antseed/node/payments'
import { Interface, ZeroAddress, type AbstractProvider } from 'ethers'
import { ChainReadCache } from './chain-read-cache.js'

/** A channel's on-chain record (AntseedChannels `channels(id)`); status 0 = no record, 1 active, 2 settled, 3 timed out. */
export interface ChannelChainState {
  status: number
  deposit: bigint
  settled: bigint
  closeRequestedAt: bigint
}

const CHANNELS_READ_IFACE = new Interface([
  'function channels(bytes32 channelId) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
])
const SELLER_FACADE_IFACE = new Interface(['function channelsAddress() view returns (address)'])
const DEPOSITS_READ_IFACE = new Interface([
  'function getBuyerBalance(address buyer) view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
])

async function readChannelsAt(provider: AbstractProvider, address: string, channelIds: string[], states: Map<string, ChannelChainState>): Promise<void> {
  const results = await multicallRead(provider, channelIds.map((channelId) => ({
    target: address,
    iface: CHANNELS_READ_IFACE,
    method: 'channels',
    args: [channelId],
  })))
  results.forEach((result, index) => {
    if (!result) return
    states.set(channelIds[index]!, { deposit: result[2] as bigint, settled: result[3] as bigint, closeRequestedAt: result[7] as bigint, status: Number(result[8]) })
  })
}

/**
 * On-chain records for `channelIds` in one Multicall3 read; ids it could not
 * read are left out. A seller facade forwards `reserve()` to the channels
 * contract the registry names, so a channel normally has its record on
 * `canonical`. One with no record there is looked up on the contract its
 * seller's facade names (`sellers`: channel id → seller address), which
 * differs only when the configured address is not the one the facade uses.
 * When that cannot be checked, the id is left out rather than reported as
 * missing.
 */
export async function readChannelStatesAt(
  provider: AbstractProvider,
  canonical: string,
  channelIds: string[],
  sellers: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, ChannelChainState>> {
  const states = new Map<string, ChannelChainState>()
  if (!canonical || channelIds.length === 0) return states
  await readChannelsAt(provider, canonical, channelIds, states)
  const bySeller = new Map<string, string[]>()
  for (const channelId of channelIds) {
    const seller = sellers.get(channelId)?.toLowerCase()
    if (states.get(channelId)?.status !== 0 || !seller || !/^0x[0-9a-f]{40}$/.test(seller)) continue
    bySeller.set(seller, [...(bySeller.get(seller) ?? []), channelId])
  }
  if (bySeller.size === 0) return states
  const facadeSellers = [...bySeller.keys()]
  try {
    // A seller that is not a facade reverts or returns nothing: null here.
    const probes = await multicallRead(provider, facadeSellers.map((seller) => ({ target: seller, iface: SELLER_FACADE_IFACE, method: 'channelsAddress' })))
    for (const [index, seller] of facadeSellers.entries()) {
      const underlying = probes[index]?.[0]
      if (typeof underlying !== 'string' || underlying === ZeroAddress || underlying.toLowerCase() === canonical.toLowerCase()) continue
      // The canonical miss says nothing for a facade's channel: only its own contract's answer counts.
      const facadeChannelIds = bySeller.get(seller)!
      for (const channelId of facadeChannelIds) states.delete(channelId)
      await readChannelsAt(provider, underlying, facadeChannelIds, states)
    }
  } catch {
    for (const channelIds of bySeller.values()) for (const channelId of channelIds) states.delete(channelId)
  }
  return states
}

/** What the view needs from a stored channel row (`BuyerChannelSummary`). */
export interface ChannelChainRow {
  channelId: string
  seller: string
  /** The store's status; `active` is the only one that is not retired. */
  status: string
  /** Last local write to the row, in ms: for a retired row, its retirement or later. */
  updatedAt: number
  /** Deadline (unix seconds) of the latest ReserveAuth signed for it; 0 when unknown. */
  deadline: number
}

/** One channel's on-chain record as the route reports it. Amounts are USDC base units. */
export interface ChannelOnChain {
  /** 0 = no record, 1 = active, 2 = settled, 3 = timed out. */
  status: number
  deposit: string
  settled: string
  /** Unix seconds of the buyer's `requestClose()`; 0 when none. */
  closeRequestedAt: number
  /** When the read that produced this started, in ms. */
  readAt: number
}

/** The buyer's reserve against what its stored channels explain. Amounts are USDC base units. */
export interface ChannelsOnChainSummary {
  /** When the latest chain read started, in ms; null when the chain has not been read. */
  readAt: number | null
  /** `AntseedDeposits` reserved for the buyer; null when it could not be read. */
  reserved: string | null
  /** Sum of deposit − settled over the stored channels the chain shows open. */
  heldByChannels: string
  /**
   * Reserve no stored channel accounts for: `reserved − heldByChannels`,
   * confirmed by two reads in a row. Null when it cannot be judged (the
   * reserve or a channel is unread).
   */
  unaccountedReserved: string | null
}

export interface ChannelsOnChainView {
  channels: Map<string, ChannelOnChain>
  summary: ChannelsOnChainSummary
}

export interface ChannelChainRead {
  reserved: bigint | null
  channels: Map<string, ChannelChainState>
}

/** One pass over the chain: the buyer's reserve and the given channels, read together. */
export type ChannelChainReader = (buyer: string, rows: ReadonlyArray<Pick<ChannelChainRow, 'channelId' | 'seller'>>) => Promise<ChannelChainRead>

/** The reader `buyer start` uses: one batched channel read plus the buyer's reserve, on the shared provider. */
export function createChannelChainReader(options: { provider: AbstractProvider; channelsAddress: string; depositsAddress: string }): ChannelChainReader {
  return async (buyer, rows) => {
    const sellers = new Map(rows.map((row) => [row.channelId, row.seller]))
    const [channels, balance] = await Promise.all([
      readChannelStatesAt(options.provider, options.channelsAddress, rows.map((row) => row.channelId), sellers),
      multicallRead(options.provider, [{ target: options.depositsAddress, iface: DEPOSITS_READ_IFACE, method: 'getBuyerBalance', args: [buyer] }])
        .catch(() => [null]),
    ])
    const reserved = balance[0]?.[1]
    return { reserved: typeof reserved === 'bigint' ? reserved : null, channels }
  }
}

const VIEW_TTL_MS = 20_000
/** `fresh` re-reads the chain at most this often per buyer. */
const VIEW_FRESH_FLOOR_MS = 5_000
/**
 * The store retires a row both when its channel closed and when the buyer gave
 * up on the session, which leaves the channel open. Only a read started this
 * long after the retirement shows such a row open: an earlier one may predate
 * the close, or lag it.
 */
export const RETIRED_ROW_READ_DELAY_MS = 30_000
/** Same margin as the buyer's reconcile: a clock running ahead must not rule out a reserve that can still land. */
const RESERVE_LANDING_GRACE_SECS = 60 * 60

function held(state: Pick<ChannelChainState, 'deposit' | 'settled'>): bigint {
  return state.deposit > state.settled ? state.deposit - state.settled : 0n
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

interface Pass {
  readAt: number
  /** The candidate ids this pass read, joined: a different set is a different question. */
  ids: string
  reserved: bigint | null
  /** Reserve beyond what the stored channels hold; null when it could not be judged. */
  unaccounted: bigint | null
}

export class BuyerChannelChainView {
  private readonly read: ChannelChainReader
  private readonly now: () => number
  private readonly cache: ChainReadCache
  /** Last record the chain gave for each channel, and when that read started. */
  private readonly known = new Map<string, { state: ChannelChainState; readAt: number }>()

  constructor(options: { read: ChannelChainReader; now?: () => number; cache?: ChainReadCache }) {
    this.read = options.read
    this.now = options.now ?? Date.now
    this.cache = options.cache ?? new ChainReadCache({ now: this.now })
  }

  /**
   * The chain's record of each of `rows`, and the buyer's reserve against
   * them. Read at most every 20 s (`fresh`: every 5 s); a failed read serves
   * the last records. A channel the chain showed settled or timed out is
   * final and never read again, like one with no record once no reserve the
   * buyer signed can still land.
   */
  async describe(buyer: string, rows: readonly ChannelChainRow[], options: { fresh?: boolean; /** Answer from earlier reads when this one takes longer; it finishes in the background. */ maxWaitMs?: number } = {}): Promise<ChannelsOnChainView> {
    const address = buyer.toLowerCase()
    const candidates = rows.filter((row) => !this.isFinal(row)).sort((a, b) => a.channelId.localeCompare(b.channelId))
    const ids = candidates.map((row) => row.channelId).join(',')
    const key = `channels:${address}`
    const cached = this.cache.peek<Pass>(key)
    const force = !cached || cached.value.ids !== ids
      || (options.fresh === true && this.now() - cached.fetchedAt >= VIEW_FRESH_FLOOR_MS)
    // Unreadable or slow chain: report what earlier reads showed.
    const reading = this.cache.read<Pass>(key, { ttlMs: VIEW_TTL_MS, force }, () => this.pass(address, rows, candidates, ids))
      .then((result) => result.value, () => null)
    const pass = options.maxWaitMs === undefined ? await reading : await withTimeout(reading, options.maxWaitMs)

    const channels = new Map<string, ChannelOnChain>()
    let heldByChannels = 0n
    for (const row of rows) {
      const record = this.known.get(row.channelId)
      if (!record) continue
      if (record.state.status === 1) heldByChannels += held(record.state)
      if (record.state.status === 1 && row.status !== 'active' && record.readAt < row.updatedAt + RETIRED_ROW_READ_DELAY_MS) continue
      channels.set(row.channelId, {
        status: record.state.status,
        deposit: record.state.deposit.toString(),
        settled: record.state.settled.toString(),
        closeRequestedAt: Number(record.state.closeRequestedAt),
        readAt: record.readAt,
      })
    }
    // A pass over another set of channels says nothing about this set's reserve.
    const judged = pass && pass.ids === ids ? pass : null
    return {
      channels,
      summary: {
        readAt: pass?.readAt ?? null,
        reserved: judged?.reserved != null ? judged.reserved.toString() : null,
        heldByChannels: heldByChannels.toString(),
        unaccountedReserved: judged?.unaccounted != null ? judged.unaccounted.toString() : null,
      },
    }
  }

  /** Drop the cached pass for a buyer, e.g. after one of its channels closed. */
  invalidate(buyer: string): void {
    this.cache.invalidate(`channels:${buyer.toLowerCase()}`)
  }

  private async pass(address: string, rows: readonly ChannelChainRow[], candidates: readonly ChannelChainRow[], ids: string): Promise<Pass> {
    const once = async (): Promise<Omit<Pass, 'ids'>> => {
      const readAt = this.now()
      const result = await this.read(address, candidates)
      for (const [channelId, state] of result.channels) this.remember(channelId, state, readAt)
      return { readAt, reserved: result.reserved, unaccounted: this.unaccounted(rows, candidates, result) }
    }
    let pass = await once()
    if (pass.unaccounted !== null && pass.unaccounted > 0n) {
      // The reserve and the channels are separate reads, so a top-up or a
      // close landing between them shows a difference once. A second pass
      // tells that from a reserve no stored channel holds.
      const first = pass.unaccounted
      const again = await once().catch(() => null)
      if (!again) pass = { ...pass, unaccounted: null }
      else pass = again.unaccounted !== null && again.unaccounted > first ? { ...again, unaccounted: first } : again
    }
    return { ...pass, ids }
  }

  private isFinal(row: ChannelChainRow): boolean {
    const record = this.known.get(row.channelId)
    if (!record) return false
    if (record.state.status === 2 || record.state.status === 3) return true
    return record.state.status === 0 && row.deadline > 0
      && record.readAt > (row.deadline + RESERVE_LANDING_GRACE_SECS) * 1000
  }

  private remember(channelId: string, state: ChannelChainState, readAt: number): void {
    // No record is ambiguous next to an earlier one: a lagging endpoint answers
    // that way for a channel that exists. The earlier record stands.
    if (state.status === 0 && (this.known.get(channelId)?.state.status ?? 0) !== 0) return
    this.known.set(channelId, { state, readAt })
  }

  /**
   * What the reserve holds beyond the stored channels. Judged only when the
   * reserve and every channel that was asked for were read.
   */
  private unaccounted(rows: readonly ChannelChainRow[], candidates: readonly ChannelChainRow[], read: ChannelChainRead): bigint | null {
    if (read.reserved === null || !candidates.every((row) => read.channels.has(row.channelId))) return null
    let explained = 0n
    for (const row of rows) {
      const record = this.known.get(row.channelId)
      if (record?.state.status === 1) explained += held(record.state)
    }
    return read.reserved > explained ? read.reserved - explained : 0n
  }
}
