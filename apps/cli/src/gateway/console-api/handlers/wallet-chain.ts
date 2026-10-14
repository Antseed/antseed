/**
 * Chain reads the gateway makes itself (buyer rewards, operator reads)
 * through the process's one rate-aware provider per chain, instead of a new
 * provider (and an endpoint-probing burst) per request. Balances are not
 * read here: they come from the buyer's cached `GET /_antseed/balances`.
 */
import { AntsContext, rewards, type AntsChainConfig, type RewardsView } from '@antseed/ants'
import { multicallRead } from '@antseed/node/payments'
import { Interface, ZeroAddress } from 'ethers'
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

/** On-chain records for `channelIds` in one Multicall3 read; ids it could not read are left out. */
export async function readChannelStates(chain: AntsChainConfig, channelIds: string[]): Promise<Map<string, ChannelChainState>> {
  const states = new Map<string, ChannelChainState>()
  if (!chain.channelsContractAddress || channelIds.length === 0) return states
  const results = await multicallRead(gatewayChainProvider(chain), channelIds.map((channelId) => ({
    target: chain.channelsContractAddress!,
    iface: CHANNELS_READ_IFACE,
    method: 'channels',
    args: [channelId],
  })))
  results.forEach((result, index) => {
    if (!result) return
    states.set(channelIds[index]!, { deposit: result[2] as bigint, settled: result[3] as bigint, closeRequestedAt: result[7] as bigint, status: Number(result[8]) })
  })
  return states
}
