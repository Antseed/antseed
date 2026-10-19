/**
 * Referrals and the builders program for the gateway's wallets. Each
 * workspace wallet is its own buyer: it can hand out invites (signed
 * off-chain with its key), redeem one while it is a new buyer, and earn
 * referral and invite-bonus ANTS. The gateway as a whole credits its usage
 * to one ERC-8004 client agent (`buyer.clientAgentId`).
 *
 * Counts, allowances and payable amounts come from Antscan via the shared
 * @antseed/ants services; invite checks are one `previewInvite` view. Claims
 * are not made here: they are permissionless, so the console sends them
 * from the browser and the contracts pick the recipient.
 */
import {
  builders as readBuilderAgents,
  createInvite,
  formatAntsExact,
  InviteQuotaError,
  referral,
  referredBuyers,
  refereeBonus,
  referralScope,
  type AntsChainConfig,
  type AntsContext,
} from '@antseed/ants'
import { checkInvite, clearReferralInvite, DEFAULT_BUYER_IDENTITY, inviteExpiryEpoch, decodeInvite, readReferralState, saveReferralInvite, type ReferralState } from '@antseed/node'
import { isError } from 'ethers'
import { buyerIdentityDir } from '../../buyer-identities/store.js'
import { loadConfig, parseClientAgentId } from '../../config/loader.js'
import { ConsoleError } from '../console-api/router.js'
import type { BuilderAgent, Builders, CreatedInvite, Referee, Referrals } from '../console-api/types.js'
import { errorMessage } from '../errors.js'
import { recordAudit, type Actor, type ServiceContext } from './context.js'
import { patchConfigFile, requestBuyerRestart, type SettingsContext } from './settings.js'
import { optionalBuyerJson, type BuyerClient } from '../console-api/handlers/network-buyer.js'
import { resolveClientAgentId, type ClientAgentAttribution } from '../../cli/referral-state.js'

/** Where a buyer identity's referral.json lives: the data dir for the default wallet, else the identity's directory. */
export function referralStateDir(dataDir: string, buyerIdentity: string): string {
  return buyerIdentity === DEFAULT_BUYER_IDENTITY ? dataDir : buyerIdentityDir(dataDir, buyerIdentity)
}

const HIDDEN_REFEREE: Referee = {
  state: 'none', referrer: null, pendingInvite: null, inviteExpiresEpoch: null,
  boundEpoch: null, windowEnd: null, weeksLeft: null, payableAnts: '0', claimableEpochs: [], canRedeem: null,
}

const UNINDEXED_REFERRAL: Awaited<ReturnType<typeof referral>> = { available: false, indexed: false, payable: '0', claimableEpochs: [], referredCount: 0, invites: null }

function ants(baseUnits: string): string {
  return formatAntsExact(baseUnits || '0')
}

/** The wallet's local referral state for `ctx`'s Referrals deployment; null without one. */
async function readLocalReferral(ctx: AntsContext, stateDir: string): Promise<ReferralState | null> {
  const scope = referralScope(ctx, ctx.buyerAddress)
  return scope ? readReferralState(stateDir, scope) : null
}

/** The referee side: the local state file (what the buyer carries) joined with Antscan's binding. */
async function readReferee(ctx: AntsContext, stateDir: string): Promise<Referee> {
  const [state, bonus] = await Promise.all([readLocalReferral(ctx, stateDir), refereeBonus(ctx)])
  const bound = bonus.referrer !== null || state?.state === 'bound'
  const pending = !bound && state?.state === 'invited' && state.invite ? state.invite : null
  let inviteExpiresEpoch: number | null = null
  if (pending) {
    try {
      inviteExpiresEpoch = inviteExpiryEpoch(decodeInvite(pending))
    } catch {
      inviteExpiresEpoch = null
    }
  }
  if (!bonus.available && !state) return HIDDEN_REFEREE
  return {
    state: bound ? 'bound' : pending ? 'invited' : 'none',
    referrer: bonus.referrer ?? state?.referrer ?? null,
    pendingInvite: pending,
    inviteExpiresEpoch,
    boundEpoch: bonus.boundEpoch,
    windowEnd: bonus.windowEnd,
    weeksLeft: bonus.weeksLeft,
    payableAnts: ants(bonus.payable),
    claimableEpochs: bonus.claimableEpochs,
    canRedeem: bound ? false : bonus.canBind ?? null,
  }
}

/** A workspace wallet's referrals: its invites and referred buyers, and its own invite bonus. */
export async function readReferrals(ctx: AntsContext, stateDir: string): Promise<Referrals> {
  // Antscan's statistics are optional: without it the allowance comes from
  // the contract, counts and rewards are unknown, and invites (RPC and the
  // local state) keep working. The console claims the epochs listed here, so
  // rewards count as available only when Antscan reported them.
  const [view, referred, referee] = await Promise.all([
    referral(ctx, stateDir).catch(() => UNINDEXED_REFERRAL),
    referredBuyers(ctx).catch(() => ({ available: false, buyers: [] })),
    readReferee(ctx, stateDir),
  ])
  return {
    available: view.indexed,
    invitesAvailable: Boolean(ctx.chain.referralsAddress),
    address: ctx.address,
    invites: view.invites,
    referredCount: view.referredCount,
    payableAnts: ants(view.payable),
    claimableEpochs: view.claimableEpochs,
    buyers: referred.buyers.map((buyer) => ({ ...buyer, ants: ants(buyer.ants) })),
    referee,
  }
}

/** Sign an invite with the workspace wallet (`ctx` carries its signer); the index is remembered in its referral.json. */
export async function createWorkspaceInvite(ctx: AntsContext, stateDir: string, actor: Actor, service: ServiceContext, workspace: { id: string; name: string }): Promise<CreatedInvite> {
  if (!ctx.chain.referralsAddress) throw new ConsoleError(409, 'referrals_unavailable', 'Referrals are not available on this network.')
  let created: CreatedInvite
  try {
    created = await createInvite(ctx, stateDir)
  } catch (err) {
    if (err instanceof InviteQuotaError) throw new ConsoleError(409, 'no_invites_left', err.message, { quota: err.quota })
    throw new ConsoleError(502, 'invite_failed', `The invite could not be created: ${errorMessage(err)}`)
  }
  recordAudit(service, actor, 'referral.invite', { kind: 'workspace', id: workspace.id, label: workspace.name }, { epoch: created.epoch, index: created.index })
  return created
}

/**
 * Save an invite for the workspace wallet to carry in the metadata it signs;
 * the buyer picks it up within a minute and the first settlement binds it.
 * The contract's own preview decides whether it would bind (new buyer,
 * not self-referral, active, unused).
 */
export async function redeemWorkspaceInvite(ctx: AntsContext, stateDir: string, value: unknown, actor: Actor, service: ServiceContext, workspace: { id: string; name: string }): Promise<void> {
  const client = ctx.referrals()
  const scope = referralScope(ctx, ctx.buyerAddress)
  if (!client || !scope) throw new ConsoleError(409, 'referrals_unavailable', 'Referrals are not available on this network.')
  if (typeof value !== 'string' || value.trim() === '') throw new ConsoleError(400, 'invalid_invite', 'invite must be an invite code or link.')
  const current = await readReferralState(stateDir, scope)
  if (current?.state === 'bound') throw new ConsoleError(409, 'already_bound', 'This wallet is already bound to a referrer.')
  const check = await checkInvite(client, ctx.buyerAddress, value.trim()).catch((err: unknown) => {
    throw new ConsoleError(502, 'invite_check_failed', `The invite could not be checked: ${errorMessage(err)}`)
  })
  if (!check.ok) throw new ConsoleError(400, 'invalid_invite', check.reason, check.failure ? { failure: check.failure } : undefined)
  await saveReferralInvite(stateDir, scope, check.encoded, check.referrer)
  recordAudit(service, actor, 'referral.redeem', { kind: 'workspace', id: workspace.id, label: workspace.name }, { referrer: check.referrer })
}

/** Drop an invite the wallet carries but that is not bound yet. */
export async function clearWorkspaceInvite(ctx: AntsContext, stateDir: string, actor: Actor, service: ServiceContext, workspace: { id: string; name: string }): Promise<void> {
  const scope = referralScope(ctx, ctx.buyerAddress)
  if (!scope) return
  const current = await readReferralState(stateDir, scope)
  if (current?.state === 'bound') throw new ConsoleError(409, 'already_bound', 'A bound referral is permanent.')
  if (current?.state !== 'invited') return
  await clearReferralInvite(stateDir, scope)
  recordAudit(service, actor, 'referral.clear', { kind: 'workspace', id: workspace.id, label: workspace.name }, {})
}

// ── Builders ────────────────────────────────────────────────────────────

/** The configured client agent (`buyer.clientAgentId`), or null. */
export async function configuredClientAgentId(configPath: string): Promise<number | null> {
  const config = await loadConfig(configPath)
  const id = config.buyer.clientAgentId
  return typeof id === 'number' && id > 0 ? id : null
}

/** A client-agent attribution a buyer reported, or null when the value is not one. */
function parseAttribution(value: unknown): ClientAgentAttribution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const source = raw['source']
  if (source !== 'env' && source !== 'config' && source !== 'default' && source !== 'none') return null
  const agentId = raw['agentId'] === null ? null : parseClientAgentId(raw['agentId']) ?? undefined
  if (agentId === undefined || (agentId === null) !== (source === 'none')) return null
  return { agentId, source, client: raw['client'] === 'desktop' ? 'desktop' : 'cli' }
}

/**
 * The client agent the running buyer reports it signs (`GET /_antseed/status`).
 * Null when there is no buyer to ask, it does not answer, or it predates the
 * report. The buyer may run with a different environment than this process
 * (`gateway start --no-buyer`), so only its own answer is authoritative.
 */
export async function runtimeClientAgent(buyer: BuyerClient | null): Promise<ClientAgentAttribution | null> {
  if (!buyer) return null
  const status = await optionalBuyerJson(buyer, '/_antseed/status', { timeoutMs: 2_000 })
  return parseAttribution(status?.['attribution'])
}

/** This process's estimate of what a buyer started with `env` and the configured agent would sign. */
function estimatedClientAgent(configured: number | null, chain: AntsChainConfig, env: NodeJS.ProcessEnv): Builders['effective'] {
  return { ...resolveClientAgentId({ clientAgentId: configured ?? undefined, clientAgentIds: chain.clientAgentIds }, env), runtime: false }
}

/**
 * The configured and effective client agent, without the rewards read (which
 * needs the explorer). The effective agent is the running buyer's own report;
 * without one it is estimated from this process's environment and the config
 * (`runtime: false`).
 */
export async function readBuilderSettings(chain: AntsChainConfig, configPath: string, buyer: BuyerClient | null, env: NodeJS.ProcessEnv = process.env): Promise<Builders> {
  const [agentId, runtime] = await Promise.all([configuredClientAgentId(configPath), runtimeClientAgent(buyer)])
  const effective = runtime ? { ...runtime, runtime: true } : estimatedClientAgent(agentId, chain, env)
  return { available: false, agentId, effective, agent: null }
}

/** What the builders program owes a client agent (Antscan; the owner over RPC). */
export async function readBuilderAgent(ctx: AntsContext, agentId: number | null): Promise<Pick<Builders, 'available' | 'agent'>> {
  // The console claims the epochs listed here, so the rewards need Antscan: without it, skip the ownerOf reads too.
  if (!agentId || !ctx.indexer()) return { available: false, agent: null }
  const view = await readBuilderAgents(ctx, [agentId])
  const found = view.indexed ? view.agents.find((agent) => agent.agentId === agentId) : undefined
  const agent: BuilderAgent | null = found
    ? { agentId: found.agentId, owner: found.owner, firstParty: found.firstParty, payableAnts: ants(found.payable), claimableEpochs: found.claimableEpochs }
    : null
  return { available: view.indexed, agent }
}

/** The gateway's client agent, as the running buyer signs it, and what the builders program owes it. */
export async function readBuilders(ctx: AntsContext, configPath: string, buyer: BuyerClient | null, env: NodeJS.ProcessEnv = process.env): Promise<Builders> {
  const settings = await readBuilderSettings(ctx.chain, configPath, buyer, env)
  return { ...settings, ...(await readBuilderAgent(ctx, settings.effective.agentId)) }
}

function parseAgentId(value: unknown): number | null {
  if (value === null) return null
  const id = parseClientAgentId(value)
  if (id === undefined) {
    throw new ConsoleError(400, 'invalid_agent', 'agentId must be a positive integer ERC-8004 agent id, or null to clear it.')
  }
  return id
}

/**
 * Set (or clear) the client agent the gateway's buyer credits its usage to,
 * then restart the buyer so it signs the new client id. An id the identity
 * registry does not know is refused when the chain can answer.
 *
 * Returns the agent the buyer signs from here on: the running buyer's report
 * when it was not restarted, else what the restarted buyer will sign. A
 * restart keeps the buyer's environment, so an ANTSEED_CLIENT_AGENT_ID it
 * runs with still wins over the saved agent (`source: 'env'`).
 */
export async function setBuilderAgent(
  settings: SettingsContext,
  actor: Actor,
  body: unknown,
  ctx: AntsContext,
  buyer: BuyerClient | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ restartRequired: boolean; agentId: number | null; effective: Builders['effective'] }> {
  const input = body && typeof body === 'object' ? (body as Record<string, unknown>)['agentId'] : undefined
  if (input === undefined) throw new ConsoleError(400, 'invalid_agent', 'agentId is required (null clears it).')
  const agentId = parseAgentId(input)
  if (agentId !== null) {
    const identity = ctx.identity()
    if (identity) {
      try {
        await identity.getAgentWallet(agentId)
      } catch (err) {
        if (isError(err, 'CALL_EXCEPTION')) throw new ConsoleError(400, 'agent_not_registered', `Agent ${agentId} is not registered in the ERC-8004 identity registry.`)
        // An unreachable chain does not block saving the id.
      }
    }
  }
  // Asked before the restart: the running buyer says whether its environment overrides the config.
  const [previous, before] = await Promise.all([configuredClientAgentId(settings.configPath), runtimeClientAgent(buyer)])
  const running = (): Builders['effective'] => before ? { ...before, runtime: true } : estimatedClientAgent(agentId, ctx.chain, env)
  if (previous === agentId) return { restartRequired: false, agentId, effective: running() }
  await patchConfigFile(settings.configPath, (config) => {
    const buyerConfig = config['buyer'] && typeof config['buyer'] === 'object' && !Array.isArray(config['buyer'])
      ? config['buyer'] as Record<string, unknown>
      : (config['buyer'] = {}) as Record<string, unknown>
    if (agentId === null) delete buyerConfig['clientAgentId']
    else buyerConfig['clientAgentId'] = agentId
  })
  recordAudit(settings, actor, 'builders.update', { kind: 'settings', id: 'builders', label: 'Builders program' }, { agentId, previous })
  settings.log('console: client agent changed; restarting the buyer')
  const restartRequired = buyer ? await requestBuyerRestart(settings, buyer) : true
  // Not restarted: the running buyer keeps signing what it reported.
  if (restartRequired) return { restartRequired, agentId, effective: running() }
  if (before?.source === 'env') {
    settings.log(`console: ANTSEED_CLIENT_AGENT_ID=${before.agentId} on the buyer overrides the saved client agent`)
    return { restartRequired, agentId, effective: { ...before, runtime: false } }
  }
  // The restarted buyer has not reported yet: what it will sign under the new config, for its client kind.
  const restartedEnv = before ? { ANTSEED_CLIENT_KIND: before.client } : env
  return { restartRequired, agentId, effective: estimatedClientAgent(agentId, ctx.chain, restartedEnv) }
}
