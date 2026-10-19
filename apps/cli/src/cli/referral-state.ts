import { referralBindingFromExplorer } from '@antseed/ants'
import {
  clientIdFromAgentId,
  pendingInvite,
  readReferralState,
  referralStateMtimeMs,
  referrerOfLookup,
  syncReferralState,
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
 * the RPC-free trigger, and `referrerOf` on the configured contract
 * (`client`) confirms a binding before the invite is dropped; without
 * Antscan, or while it reports none, `referrerOf` is read on a backoff
 * instead. Nothing is looked up without a referrals client.
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

export type BuyerAttribution = ReturnType<typeof resolveBuyerAttribution>

export type ReferralAttributionWatch = {
  /** Settles once the first explorer/chain sync has been applied (never rejects). */
  synced: Promise<void>
  stop(): void
}

/**
 * Install the buyer's referral attribution and keep it in step with
 * referral.json. Resolves once the locally saved invite has been applied
 * (a plain file read, no explorer or RPC), so the caller can start serving
 * requests knowing the first signed settlement already carries it. The
 * explorer/chain sync that drops a bound invite runs afterward in the
 * background, then every `intervalMs`.
 *
 * The file's mtime short-circuits the poll only while no invite is carried:
 * binding happens on-chain without touching the file, and every settlement
 * that still carries a bound invite costs the seller a reverting bindReferral
 * call inside AntseedStatsV2.
 */
export async function watchReferralAttribution(options: ClientAgentOptions & {
  dataDir: string
  scope: ReferralScope | null
  lookups: ReferralLookups
  apply: (attribution: BuyerAttribution) => void
  log?: ((message: string) => void) | undefined
  intervalMs?: number | undefined
  env?: NodeJS.ProcessEnv
  /** Overridable for tests. */
  syncState?: typeof syncReferralState
}): Promise<ReferralAttributionWatch> {
  const { dataDir, scope, lookups, apply, log } = options
  const syncState = options.syncState ?? syncReferralState
  const attributionOptions = { clientAgentId: options.clientAgentId, clientAgentIds: options.clientAgentIds, ...(options.env ? { env: options.env } : {}) }
  let carrying = false
  let lastMtime = await referralStateMtimeMs(dataDir)
  // A slow sync must not overwrite the result of a newer read.
  let generation = 0
  const install = (referralState: ReferralState | null, current: number): void => {
    if (current !== generation) return
    const attribution = resolveBuyerAttribution({ referralState, ...attributionOptions })
    if (attribution.invite && !carrying) {
      log?.(`Referral: carrying the invite from ${referralState?.referrer?.slice(0, 10) ?? 'your inviter'}… until a settlement binds it on-chain.`)
    } else if (!attribution.invite && carrying && referralState?.state === 'bound') {
      log?.('Referral: invite is bound on-chain; no longer carried in signed metadata.')
    }
    carrying = !!attribution.invite
    apply(attribution)
  }
  const sync = async (force: boolean): Promise<void> => {
    // Taken before the read, so the state installed is never newer than the
    // mtime remembered for it: a write that lands during the read leaves a
    // newer mtime on the file, and the next poll reads again.
    const mtime = await referralStateMtimeMs(dataDir)
    if (!force && !carrying && mtime === lastMtime) return
    const current = ++generation
    const referralState = scope ? await syncState(dataDir, scope, lookups) : null
    if (current !== generation) return
    lastMtime = mtime
    install(referralState, current)
  }

  install(scope ? await readReferralState(dataDir, scope).catch(() => null) : null, ++generation)
  const synced = sync(true).catch(() => {})
  const timer = setInterval(() => { void sync(false).catch(() => {}) }, options.intervalMs ?? 60_000)
  timer.unref()
  return { synced, stop: () => clearInterval(timer) }
}

function resolveClientAgentId(options: ClientAgentOptions, env: NodeJS.ProcessEnv): number | undefined {
  const fromEnv = Number.parseInt(env['ANTSEED_CLIENT_AGENT_ID'] ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  if (options.clientAgentId && options.clientAgentId > 0) return options.clientAgentId
  const fromChain = options.clientAgentIds?.[env['ANTSEED_CLIENT_KIND'] === 'desktop' ? 'desktop' : 'cli']
  return fromChain && fromChain > 0 ? fromChain : undefined
}
