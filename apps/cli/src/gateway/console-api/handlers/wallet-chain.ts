/**
 * Chain reads the gateway makes itself (buyer rewards, operator reads)
 * through the process's one rate-aware provider per chain, instead of a new
 * provider (and an endpoint-probing burst) per request. Balances are not
 * read here: they come from the buyer's cached `GET /_antseed/balances`.
 */
import { AntsContext, rewards, type AntsChainConfig, type AntsContextOptions, type RewardsView } from '@antseed/ants'
import { multicallRead } from '@antseed/node/payments'
import { Interface, ZeroAddress, type AbstractProvider } from 'ethers'
import { sharedChainProvider, type ChainRpcProvider } from '../../../proxy/chain-rpc.js'
import type { ChannelChainState } from './wallet-mapping.js'

/** Rewards move once per epoch; five minutes keeps a page refresh from re-reading them. */
export const REWARDS_TTL_MS = 5 * 60_000

/** The gateway process's provider for a chain (`ANTSEED_BASE_RPC_URL` is already applied by `resolveAntsChain`). */
export function gatewayChainProvider(chain: Pick<AntsChainConfig, 'evmChainId' | 'rpcUrl' | 'fallbackRpcUrls'>): ChainRpcProvider {
  return sharedChainProvider({ evmChainId: chain.evmChainId, rpcUrl: chain.rpcUrl, ...(chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.fallbackRpcUrls } : {}) })
}

/**
 * An ANTS read context on the shared provider. It skips `selectRpc`'s
 * probing burst (eight `eth_call`s per endpoint): the shared provider already
 * moves off an endpoint that throttles.
 */
class SharedAntsContext extends AntsContext {
  override selectRpc(): Promise<void> {
    return Promise.resolve()
  }

  override provider(): ReturnType<AntsContext['provider']> {
    return gatewayChainProvider(this.chain) as unknown as ReturnType<AntsContext['provider']>
  }
}

/** An ANTS context on the gateway's shared provider, for one wallet (with its signer for off-chain signatures). */
export function gatewayAntsContext(options: AntsContextOptions): AntsContext {
  return new SharedAntsContext(options)
}

/**
 * Buyer rewards for one address, read-only (no signer, the zero address as
 * the connected wallet). One context per chain is kept, so the protocol
 * stack (registry pointers, epoch config) is resolved once per TTL rather
 * than per request; reads run one at a time because the context carries the
 * buyer address.
 */
export function createRewardsReader(): (chain: AntsChainConfig, address: string) => Promise<RewardsView & { legacyEpochs: number[] }> {
  const contexts = new Map<string, SharedAntsContext>()
  let queue: Promise<unknown> = Promise.resolve()
  return (chain, address) => {
    const key = `${chain.evmChainId}|${chain.rpcUrl}|${chain.registryContractAddress ?? ''}`
    let context = contexts.get(key)
    if (!context) {
      context = new SharedAntsContext({ chain, address: ZeroAddress, buyerAddress: address, stackTtlMs: REWARDS_TTL_MS })
      contexts.set(key, context)
    }
    const ctx = context
    const run = queue.then(async () => {
      ctx.buyerAddress = address
      const view = await rewards(ctx)
      // The epochs a legacy buyer claim may name (finalized, before the current program took over).
      const legacyEpochs = BigInt(view.legacy.buyer || '0') > 0n ? (await ctx.claimableEpochs()).legacy : []
      return { ...view, legacyEpochs }
    })
    queue = run.catch(() => {})
    return run
  }
}

const CHANNELS_READ_IFACE = new Interface([
  'function channels(bytes32 channelId) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
])

const SELLER_FACADE_IFACE = new Interface(['function channelsAddress() view returns (address)'])

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
 * read are left out. A channel with no record on the configured contract may
 * live behind its seller's facade (`sellers`: channel id → seller address),
 * on the contract the facade names, as the desktop resolves it. When that
 * cannot be checked, the id is left out rather than reported as missing.
 */
export async function readChannelStates(
  chain: AntsChainConfig,
  channelIds: string[],
  sellers: ReadonlyMap<string, string> = new Map(),
  provider: AbstractProvider = gatewayChainProvider(chain),
): Promise<Map<string, ChannelChainState>> {
  const states = new Map<string, ChannelChainState>()
  const canonical = chain.channelsContractAddress
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
