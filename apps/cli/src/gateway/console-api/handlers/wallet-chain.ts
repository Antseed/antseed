/**
 * Chain reads the gateway makes itself (buyer rewards, operator reads)
 * through the process's one rate-aware provider per chain, instead of a new
 * provider (and an endpoint-probing burst) per request. Balances are not
 * read here: they come from the buyer's cached `GET /_antseed/balances`.
 */
import { AntsContext, rewards, type AntsChainConfig, type RewardsView } from '@antseed/ants'
import { ZeroAddress, type AbstractProvider } from 'ethers'
import { readChannelStatesAt, type ChannelChainState } from '../../../proxy/channel-chain.js'
import { sharedChainProvider, type ChainRpcProvider } from '../../../proxy/chain-rpc.js'

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

/**
 * On-chain records for `channelIds`, for a buyer that does not report them
 * itself (see `readChannelStatesAt`); ids that could not be read are left out.
 */
export async function readChannelStates(
  chain: AntsChainConfig,
  channelIds: string[],
  sellers: ReadonlyMap<string, string> = new Map(),
  provider: AbstractProvider = gatewayChainProvider(chain),
): Promise<Map<string, ChannelChainState>> {
  return readChannelStatesAt(provider, chain.channelsContractAddress ?? '', channelIds, sellers)
}
