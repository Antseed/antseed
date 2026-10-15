import { referralBindingFromExplorer } from '@antseed/ants'
import { clientIdFromAgentId, pendingInvite, type ReferralInvite, type ReferralLookup, type ReferralState } from '@antseed/node'

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

/** Antscan lookup of the buyer's bound referrer (no RPC), or null without referrals or an explorer. */
export function referralLookup(chain: { referralsAddress?: string | undefined; explorerApiUrl?: string | undefined }): ReferralLookup | null {
  const { referralsAddress, explorerApiUrl } = chain
  return referralsAddress && explorerApiUrl ? (buyer) => referralBindingFromExplorer(explorerApiUrl, buyer) : null
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
