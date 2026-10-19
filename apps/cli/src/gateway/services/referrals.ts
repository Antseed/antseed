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
import { loadConfig } from '../../config/loader.js'
import { ConsoleError } from '../console-api/router.js'
import type { BuilderAgent, Builders, CreatedInvite, Referee, Referrals } from '../console-api/types.js'
import { errorMessage } from '../errors.js'
import { recordAudit, type Actor, type ServiceContext } from './context.js'
import { patchConfigFile, requestBuyerRestart, type SettingsContext } from './settings.js'
import type { BuyerClient } from '../console-api/handlers/network-buyer.js'

/** Where a buyer identity's referral.json lives: the data dir for the default wallet, else the identity's directory. */
export function referralStateDir(dataDir: string, buyerIdentity: string): string {
  return buyerIdentity === DEFAULT_BUYER_IDENTITY ? dataDir : buyerIdentityDir(dataDir, buyerIdentity)
}

const HIDDEN_REFEREE: Referee = {
  state: 'none', referrer: null, pendingInvite: null, inviteExpiresEpoch: null,
  boundEpoch: null, windowEnd: null, weeksLeft: null, payableAnts: '0', claimableEpochs: [], canRedeem: null,
}

const UNINDEXED_REFERRAL: Awaited<ReturnType<typeof referral>> = { available: false, payable: '0', claimableEpochs: [], referredCount: 0, invites: null }

function ants(baseUnits: string): string {
  return formatAntsExact(baseUnits || '0')
}

/** The wallet's local referral state for `ctx`'s Referrals deployment; null without one. */
async function readLocalReferral(ctx: AntsContext, stateDir: string): Promise<ReferralState | null> {
  const scope = referralScope(ctx)
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
  // Antscan's statistics are optional: when it fails the view degrades to
  // unknown counts, and invites (RPC and the local state) keep working.
  const [view, referred, referee] = await Promise.all([
    referral(ctx, stateDir).catch(() => UNINDEXED_REFERRAL),
    referredBuyers(ctx).catch(() => ({ available: false, buyers: [] })),
    readReferee(ctx, stateDir),
  ])
  return {
    available: view.available,
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
  const scope = referralScope(ctx)
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
  const scope = referralScope(ctx)
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

/** What the buyer signs as its client: the same precedence as `resolveBuyerAttribution`. */
export function effectiveClientAgent(
  configured: number | null,
  chainIds: { cli?: number } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Builders['effective'] {
  const fromEnv = Number.parseInt(env['ANTSEED_CLIENT_AGENT_ID'] ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return { agentId: fromEnv, source: 'env' }
  if (configured) return { agentId: configured, source: 'config' }
  if (chainIds?.cli && chainIds.cli > 0) return { agentId: chainIds.cli, source: 'default' }
  return { agentId: null, source: 'none' }
}

/** The gateway's client agent and what the builders program owes it (Antscan; the owner over RPC). */
/** The configured and effective client agent, without the rewards read (which needs the explorer). */
export async function readBuilderSettings(chain: AntsChainConfig, configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<Builders> {
  const agentId = await configuredClientAgentId(configPath)
  return { available: false, agentId, effective: effectiveClientAgent(agentId, chain.clientAgentIds, env), agent: null }
}

export async function readBuilders(ctx: AntsContext, configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<Builders> {
  const { agentId, effective } = await readBuilderSettings(ctx.chain, configPath, env)
  if (!effective.agentId) return { available: false, agentId, effective, agent: null }
  const view = await readBuilderAgents(ctx, [effective.agentId])
  const found = view.agents.find((agent) => agent.agentId === effective.agentId)
  const agent: BuilderAgent | null = found
    ? { agentId: found.agentId, owner: found.owner, firstParty: found.firstParty, payableAnts: ants(found.payable), claimableEpochs: found.claimableEpochs }
    : null
  return { available: view.available, agentId, effective, agent }
}

function parseAgentId(value: unknown): number | null {
  if (value === null) return null
  const id = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new ConsoleError(400, 'invalid_agent', 'agentId must be a positive integer ERC-8004 agent id, or null to clear it.')
  }
  return id
}

/**
 * Set (or clear) the client agent the gateway's buyer credits its usage to,
 * then restart the buyer so it signs the new client id. An id the identity
 * registry does not know is refused when the chain can answer.
 */
export async function setBuilderAgent(
  settings: SettingsContext,
  actor: Actor,
  body: unknown,
  ctx: AntsContext,
  buyer: BuyerClient,
): Promise<{ restartRequired: boolean }> {
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
  const previous = await configuredClientAgentId(settings.configPath)
  if (previous === agentId) return { restartRequired: false }
  await patchConfigFile(settings.configPath, (config) => {
    const buyerConfig = config['buyer'] && typeof config['buyer'] === 'object' && !Array.isArray(config['buyer'])
      ? config['buyer'] as Record<string, unknown>
      : (config['buyer'] = {}) as Record<string, unknown>
    if (agentId === null) delete buyerConfig['clientAgentId']
    else buyerConfig['clientAgentId'] = agentId
  })
  recordAudit(settings, actor, 'builders.update', { kind: 'settings', id: 'builders', label: 'Builders program' }, { agentId, previous })
  settings.log('console: client agent changed; restarting the buyer')
  return { restartRequired: await requestBuyerRestart(settings, buyer) }
}
