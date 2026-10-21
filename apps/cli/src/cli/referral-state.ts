import { referralBindingFromExplorer } from '@antseed/ants'
import {
  clientIdFromAgentId,
  pendingInvite,
  readReferralState,
  referralStateMtimeMs,
  syncReferralState,
  type InviteDomain,
  type ReferralInvite,
  type ReferralLookup,
  type ReferralScope,
  type ReferralState,
  type ReferralsClient,
} from '@antseed/node'
import { parseClientAgentId } from '../config/loader.js'

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

/** Where the client agent the buyer signs comes from. */
export type ClientAgentSource = 'env' | 'config' | 'default' | 'none'

/** The client agent a buyer signs, where it came from, and the client kind whose default applies. */
export interface ClientAgentAttribution {
  agentId: number | null
  source: ClientAgentSource
  client: 'cli' | 'desktop'
}

/**
 * The client agent a buyer signs into settlement metadata: an ERC-8004 agent
 * id from ANTSEED_CLIENT_AGENT_ID (third-party clients), then
 * `buyer.clientAgentId`, then the chain-config id for this client kind
 * (ANTSEED_CLIENT_KIND, set to "desktop" by Desktop; "cli" otherwise).
 * Without any of those the metadata carries no client word.
 */
export function resolveClientAgentId(options: ClientAgentOptions, env: NodeJS.ProcessEnv = process.env): ClientAgentAttribution {
  const client = env['ANTSEED_CLIENT_KIND'] === 'desktop' ? 'desktop' : 'cli'
  const fromEnv = parseClientAgentId(env['ANTSEED_CLIENT_AGENT_ID'])
  if (fromEnv) return { agentId: fromEnv, source: 'env', client }
  if (options.clientAgentId && options.clientAgentId > 0) return { agentId: options.clientAgentId, source: 'config', client }
  const fromChain = options.clientAgentIds?.[client]
  return fromChain && fromChain > 0 ? { agentId: fromChain, source: 'default', client } : { agentId: null, source: 'none', client }
}

/**
 * Resolve the attribution the buyer appends to signed settlement metadata:
 * the redeemed invite until it is bound, and the client (`resolveClientAgentId`).
 */
export function resolveBuyerAttribution(options: ClientAgentOptions & {
  referralState: ReferralState | null
  env?: NodeJS.ProcessEnv
}): { clientId?: string; invite?: ReferralInvite } {
  const invite = pendingInvite(options.referralState)
  const { agentId } = resolveClientAgentId(options, options.env ?? process.env)
  return {
    ...(agentId ? { clientId: clientIdFromAgentId(agentId) } : {}),
    ...(invite ? { invite } : {}),
  }
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
    /** The Referrals deployment whose state each wallet reads; null without referrals (client attribution only). */
    deployment: InviteDomain | null
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
    const scope = this._scope(target)
    const referralState = scope ? await readReferralState(dir, scope).catch(() => null) : null
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
    // Taken before the state is read: a write landing during the sync then
    // differs from the cached time and is picked up by the next poll.
    const mtime = await referralStateMtimeMs(target.dir)
    if (!force && !target.carrying && mtime === target.mtime) return
    const { lookup, verify } = this._options
    const scope = this._scope(target)
    const referralState = scope ? await syncReferralState(target.dir, scope, lookup, verify ?? null) : null
    target.mtime = mtime
    // Tracking may have been replaced while the lookups ran.
    if (this._targets.get(key) !== target) return
    this._apply(key, target, referralState, force)
  }

  /** The wallet's own state on the deployment: a data dir reused by another wallet never hands it this one's. */
  private _scope(target: AttributionTarget): ReferralScope | null {
    const { deployment } = this._options
    return deployment ? { ...deployment, wallet: target.address } : null
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
