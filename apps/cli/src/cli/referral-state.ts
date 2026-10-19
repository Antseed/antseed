import { referralBindingFromExplorer } from '@antseed/ants'
import {
  clientIdFromAgentId,
  pendingInvite,
  referrerOfLookup,
  type ReferralInvite,
  type ReferralLookups,
  type ReferralScope,
  type ReferralState,
  type ReferralsClient,
} from '@antseed/node'

/**
 * CLI side of the referral flow. The state file and its transitions live in
 * @antseed/node (shared with Desktop); this resolves the attribution the
 * buyer daemon appends to the metadata it signs.
 */

type ClientAgentOptions = {
  clientAgentId?: number | undefined
  /** First-party client agent ids from chain config. */
  clientAgentIds?: { cli?: number; desktop?: number } | undefined
}

/** `wallet` on the configured referrals deployment, or null when referrals are not deployed. */
export function referralScope(chain: { evmChainId: number; referralsAddress?: string | undefined }, wallet: string): ReferralScope | null {
  return chain.referralsAddress ? { wallet, chainId: chain.evmChainId, referralsAddress: chain.referralsAddress } : null
}

/**
 * How the buyer's binding is learned (see `syncReferralState`): Antscan is
 * the RPC-free trigger, and only once it reports a binding is `referrerOf`
 * read, once, on the configured contract (`client`) before the invite is
 * dropped. Nothing is looked up without a referrals client.
 */
export function referralLookups(options: { explorerApiUrl?: string | undefined; client: Pick<ReferralsClient, 'referrerOf'> | null }): ReferralLookups {
  const { explorerApiUrl, client } = options
  if (!client) return {}
  return {
    explorer: explorerApiUrl ? (buyer) => referralBindingFromExplorer(explorerApiUrl, buyer) : null,
    chain: referrerOfLookup(client),
  }
}

export function shortWallet(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * Resolve the attribution the buyer appends to signed settlement metadata:
 * the redeemed invite until it is bound, and the client.
 *
 * The client is an ERC-8004 agent id: ANTSEED_CLIENT_AGENT_ID (third-party
 * clients), then `buyer.clientAgentId`, then the chain-config id for this
 * client kind (ANTSEED_CLIENT_KIND, set to "desktop" by Desktop; "cli"
 * otherwise). Without any of those the metadata carries no client word.
 */
export function resolveBuyerAttribution(options: ClientAgentOptions & {
  referralState: ReferralState | null
  env?: NodeJS.ProcessEnv
}): { clientId?: string; invite?: ReferralInvite } {
  const invite = pendingInvite(options.referralState)
  const agentId = resolveClientAgentId(options, options.env ?? process.env)
  return {
    ...(agentId ? { clientId: clientIdFromAgentId(agentId) } : {}),
    ...(invite ? { invite } : {}),
  }
}

function resolveClientAgentId(options: ClientAgentOptions, env: NodeJS.ProcessEnv): number | undefined {
  const fromEnv = Number.parseInt(env['ANTSEED_CLIENT_AGENT_ID'] ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  if (options.clientAgentId && options.clientAgentId > 0) return options.clientAgentId
  const fromChain = options.clientAgentIds?.[env['ANTSEED_CLIENT_KIND'] === 'desktop' ? 'desktop' : 'cli']
  return fromChain && fromChain > 0 ? fromChain : undefined
}
