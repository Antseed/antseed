import { referralBindingFromExplorer } from '@antseed/ants'
import { clientIdFromAgentId, pendingInvite, referralStateMtimeMs, syncReferralState, type ReferralInvite, type ReferralLookup, type ReferralState } from '@antseed/node'

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

type AttributionTarget = { dir: string; address: string; mtime: number | null; carrying: boolean }

/**
 * Keeps each buyer wallet's signed attribution in step with its referral.json
 * (the node's own wallet in the data dir, each buyer identity in its own
 * directory). `antseed referral redeem`, Desktop or the gateway console write
 * the file, possibly after the daemon started; once Antscan shows the invite
 * bound it is dropped. A file's mtime short-circuits the poll only while no
 * invite is carried: binding happens on-chain without touching the file, and
 * every settlement that still carries a bound invite costs the seller a
 * reverting bindReferral call inside AntseedStatsV2.
 */
export class BuyerAttributionSync {
  private readonly _targets = new Map<string, AttributionTarget>()

  constructor(private readonly _options: ClientAgentOptions & {
    lookup: ReferralLookup | null
    /** `identity` is undefined for the node's own wallet. */
    apply: (attribution: { clientId?: string; invite?: ReferralInvite }, identity: string | undefined) => void
    log?: (message: string) => void
  }) {}

  /** Start tracking a wallet whose referral.json lives in `dir`, applying its attribution now. */
  async track(identity: string | undefined, dir: string, address: string): Promise<void> {
    const key = identity ?? ''
    this._targets.set(key, { dir, address, mtime: null, carrying: false })
    await this._refresh(key, true)
  }

  async refreshAll(force = false): Promise<void> {
    for (const key of [...this._targets.keys()]) {
      await this._refresh(key, force).catch(() => {})
    }
  }

  private async _refresh(key: string, force: boolean): Promise<void> {
    const target = this._targets.get(key)
    if (!target) return
    if (!force && !target.carrying && (await referralStateMtimeMs(target.dir)) === target.mtime) return
    const referralState = await syncReferralState(target.dir, target.address, this._options.lookup)
    target.mtime = await referralStateMtimeMs(target.dir)
    const attribution = resolveBuyerAttribution({ referralState, ...this._options })
    const who = key ? `${key}: ` : ''
    if (attribution.invite && (force || !target.carrying)) {
      this._options.log?.(`Referral: ${who}carrying the invite from ${referralState?.referrer?.slice(0, 10) ?? 'your inviter'}… until a settlement binds it on-chain.`)
    } else if (!attribution.invite && target.carrying && referralState?.state === 'bound') {
      this._options.log?.(`Referral: ${who}invite is bound on-chain; no longer carried in signed metadata.`)
    }
    target.carrying = !!attribution.invite
    this._options.apply(attribution, key || undefined)
  }
}
