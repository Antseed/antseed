import { referralBindingFromExplorer } from '@antseed/ants'
import {
  clientIdFromAgentId,
  pendingInvite,
  readReferralState,
  referralStateMtimeMs,
  syncReferralState,
  type ReferralInvite,
  type ReferralLookup,
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

/** Antscan lookup of the buyer's bound referrer (no RPC), or null without referrals or an explorer. */
export function referralLookup(chain: { referralsAddress?: string | undefined; explorerApiUrl?: string | undefined }): ReferralLookup | null {
  const { referralsAddress, explorerApiUrl } = chain
  return referralsAddress && explorerApiUrl ? (buyer) => referralBindingFromExplorer(explorerApiUrl, buyer) : null
}

/** The Referrals contract's binding for the buyer (one `referrerOf` view call), or null without referrals. */
export function referralVerifier(client: Pick<ReferralsClient, 'referrerOf'> | null): ReferralLookup | null {
  return client ? (buyer) => client.referrerOf(buyer) : null
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

type AttributionTarget = { dir: string; address: string; mtime: number | null; carrying: boolean; syncing?: Promise<void> }

/**
 * Keeps each buyer wallet's signed attribution in step with its referral.json
 * (the node's own wallet in the data dir, each buyer identity in its own
 * directory). `antseed referral redeem`, Desktop or the gateway console write
 * the file, possibly after the daemon started; once the Referrals contract
 * confirms the binding Antscan reports, the invite is dropped. A file's mtime
 * short-circuits the poll only while no invite is carried: binding happens
 * on-chain without touching the file, and every settlement that still
 * carries a bound invite costs the seller a reverting bindReferral call
 * inside AntseedStatsV2.
 */
export class BuyerAttributionSync {
  private readonly _targets = new Map<string, AttributionTarget>()

  constructor(private readonly _options: ClientAgentOptions & {
    /** The Referrals deployment whose state is read; null without referrals (client attribution only). */
    scope: ReferralScope | null
    lookup: ReferralLookup | null
    /** On-chain confirmation of a binding `lookup` reports (see `syncReferralState`). */
    verify?: ReferralLookup | null
    /** `identity` is undefined for the node's own wallet. */
    apply: (attribution: { clientId?: string; invite?: ReferralInvite }, identity: string | undefined) => void
    log?: (message: string) => void
  }) {}

  /**
   * Start tracking a wallet whose referral.json lives in `dir`. Resolves once
   * its saved attribution is applied, so the wallet's first request already
   * carries a saved invite; the explorer and contract check runs afterwards
   * in the background and never delays or suppresses it.
   */
  async track(identity: string | undefined, dir: string, address: string): Promise<void> {
    const key = identity ?? ''
    const target: AttributionTarget = { dir, address, mtime: await referralStateMtimeMs(dir), carrying: false }
    this._targets.set(key, target)
    const referralState = this._options.scope ? await readReferralState(dir, this._options.scope).catch(() => null) : null
    this._apply(key, target, referralState, true)
    // Only a carried invite has a binding to check; anything else waits for the file to change.
    void this._refresh(key, false).catch(() => {})
  }

  async refreshAll(force = false): Promise<void> {
    for (const key of [...this._targets.keys()]) {
      await this._refresh(key, force).catch(() => {})
    }
  }

  /** One sync per wallet at a time: a poll that finds one running waits for it instead of starting another. */
  private _refresh(key: string, force: boolean): Promise<void> {
    const target = this._targets.get(key)
    if (!target) return Promise.resolve()
    if (target.syncing && !force) return target.syncing
    const run = (target.syncing ?? Promise.resolve()).catch(() => {}).then(() => this._sync(key, target, force))
    const syncing = run.finally(() => {
      if (target.syncing === syncing) delete target.syncing
    })
    target.syncing = syncing
    return syncing
  }

  private async _sync(key: string, target: AttributionTarget, force: boolean): Promise<void> {
    if (!force && !target.carrying && (await referralStateMtimeMs(target.dir)) === target.mtime) return
    const { scope, lookup, verify } = this._options
    const referralState = scope ? await syncReferralState(target.dir, scope, target.address, lookup, verify ?? null) : null
    target.mtime = await referralStateMtimeMs(target.dir)
    // Tracking may have been replaced while the lookups ran.
    if (this._targets.get(key) !== target) return
    this._apply(key, target, referralState, force)
  }

  private _apply(key: string, target: AttributionTarget, referralState: ReferralState | null, force: boolean): void {
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
