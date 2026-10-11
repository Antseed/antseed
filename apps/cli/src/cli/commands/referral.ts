import type { Command } from 'commander'
import chalk from 'chalk'
import {
  AntsContext,
  InviteQuotaError,
  formatAnts,
  issueInvite,
  refereeBonusFromExplorer,
  referral,
  type AntsChainConfig,
  type CreatedInviteView,
  type RefereeView,
  type ReferralView,
} from '@antseed/ants'
import {
  checkInvite,
  inviteExpiryEpoch,
  readReferralState,
  saveReferralInvite,
  syncReferralState,
  type InviteCheck,
  type ReferralState,
  type ReferralsClient,
} from '@antseed/node'
import { getGlobalOptions } from './types.js'
import { loadConfig } from '../../config/loader.js'
import { loadCryptoContext, requireCryptoConfig } from '../payment-utils.js'
import { referralLookup, shortWallet } from '../referral-state.js'
import { printJson } from './ants/shared.js'

/**
 * `antseed referral`: invite-only, two-sided referrals (AntseedReferrals).
 *   invite  sign a single-use invite with this wallet
 *   redeem  check an invite for this wallet and save it for the buyer daemon
 *   status  your inviter, your invite bonus, and the people you invited
 */

export type ReferralCommandContext = {
  ctx: AntsContext
  chain: AntsChainConfig
  dataDir: string
}

const NOT_AVAILABLE = 'Referrals are not available on this network.'

/** Without an RPC probe: invite and redeem make at most a few single view calls, status none. */
async function loadReferralContext(command: Command): Promise<ReferralCommandContext> {
  const { config: configPath, dataDir } = getGlobalOptions(command)
  const chain = requireCryptoConfig(await loadConfig(configPath)) as unknown as AntsChainConfig
  const { wallet } = await loadCryptoContext(dataDir)
  return { ctx: new AntsContext({ chain, address: wallet.address, signer: wallet }), chain, dataDir }
}

function requireReferrals(context: ReferralCommandContext): ReferralsClient {
  const client = context.ctx.referrals()
  if (!client || !context.chain.referralsAddress) throw new Error(NOT_AVAILABLE)
  return client
}

// ─── invite ─────────────────────────────────────────────────────────

export async function createReferralInvite(context: ReferralCommandContext): Promise<CreatedInviteView> {
  const client = requireReferrals(context)
  return issueInvite({
    client,
    indexer: context.ctx.indexer(),
    signer: context.ctx.requireSigner(),
    chainId: context.chain.evmChainId,
    referralsAddress: context.chain.referralsAddress!,
    dataDir: context.dataDir,
  })
}

export function formatInviteCreated(created: CreatedInviteView): string[] {
  return [
    chalk.green('Invite created. Share the link; it works once and expires within 4 weeks.'),
    '',
    `  ${created.link}`,
    '',
    chalk.dim(`Invite: ${created.invite}`),
    `${created.left} of ${created.quota} invites left this week.`,
  ]
}

// ─── redeem ─────────────────────────────────────────────────────────

/**
 * Decode `value` (invite or link), run `previewInvite` for `buyer`, and save
 * a valid invite as pending so the buyer daemon carries it.
 */
export async function redeemReferralInvite(options: {
  client: Pick<ReferralsClient, 'previewInvite'>
  dataDir: string
  buyer: string
  value: string
}): Promise<InviteCheck & { state?: ReferralState }> {
  const check = await checkInvite(options.client, options.buyer, options.value)
  if (!check.ok) return check
  const state = await saveReferralInvite(options.dataDir, check.encoded, check.referrer)
  return { ...check, state }
}

export function formatRedeemResult(result: Awaited<ReturnType<typeof redeemReferralInvite>>): string[] {
  if (!result.ok) return [chalk.red(`Can't use this invite: ${result.reason}`)]
  return [
    chalk.green(`Invite from ${shortWallet(result.referrer)} saved.`),
    `Binds with your first paid or free request through \`antseed buyer start\` (before week ${inviteExpiryEpoch(result.invite)}).`,
    'Then you earn bonus $ANTS on your usage for 12 weeks.',
  ]
}

// ─── status ─────────────────────────────────────────────────────────

export type ReferralStatus = {
  configured: boolean
  state: ReferralState | null
  referee: RefereeView
  invites: ReferralView
}

export async function referralStatus(context: ReferralCommandContext): Promise<ReferralStatus> {
  const { ctx, chain, dataDir } = context
  const configured = !!chain.referralsAddress
  const lookup = referralLookup(chain)
  const [state, referee, invites] = await Promise.all([
    syncReferralState(dataDir, ctx.address, lookup).catch(() => readReferralState(dataDir)),
    configured ? refereeBonusFromExplorer(chain.explorerApiUrl, ctx.address) : null,
    configured ? referral(ctx, dataDir).catch(() => null) : null,
  ])
  return {
    configured,
    state,
    referee: referee ?? { available: false, referrer: null, boundEpoch: null, windowEnd: null, weeksLeft: null, payable: '0', claimableEpochs: [] },
    invites: invites ?? { available: false, payable: '0', claimableEpochs: [], referredCount: 0, invites: null },
  }
}

function antsAmount(baseUnits: string): string {
  return `${formatAnts(baseUnits, 4)} ANTS`
}

export function formatReferralStatus(status: ReferralStatus): string[] {
  if (!status.configured) return [NOT_AVAILABLE]
  const { state, referee, invites } = status
  const lines: string[] = []

  const boundTo = referee.referrer ?? (state?.state === 'bound' ? state.referrer : undefined)
  if (boundTo) {
    lines.push(`Invited by ${shortWallet(boundTo)}${referee.boundEpoch !== null ? ` (week ${referee.boundEpoch})` : ''}.`)
    if (referee.available) {
      const window = referee.weeksLeft === null
        ? (referee.windowEnd !== null ? `through week ${referee.windowEnd}` : 'active')
        : referee.weeksLeft > 0 ? `${referee.weeksLeft} ${referee.weeksLeft === 1 ? 'week' : 'weeks'} left` : 'ended'
      lines.push(`Invite bonus: ${window} · ${antsAmount(referee.payable)} payable. Paid to your authorized wallet.`)
    }
  } else if (state?.state === 'invited') {
    lines.push(`Invite from ${shortWallet(state.referrer ?? '')} pending. Binds with your first paid or free request.`)
  } else {
    lines.push('No inviter. Redeem an invite with: antseed referral redeem <invite>')
  }

  if (invites.available) {
    const parts = [`${invites.referredCount} invited`, `${antsAmount(invites.payable)} payable`]
    if (invites.invites) parts.push(invites.invites.quota === 0 ? 'no invites this week' : `${invites.invites.left} of ${invites.invites.quota} invites left this week`)
    lines.push(`Your invites: ${parts.join(' · ')}.`)
    if (invites.invites?.quota === 0) lines.push(chalk.dim('Invites unlock after at least 1 USDC of usage or sales in the previous week.'))
  } else {
    lines.push(chalk.dim('Invite stats unavailable (no Antscan explorer configured).'))
  }
  return lines
}

// ─── registration ───────────────────────────────────────────────────

async function run(command: Command, work: (context: ReferralCommandContext) => Promise<void>): Promise<void> {
  try {
    await work(await loadReferralContext(command))
  } catch (error) {
    const message = error instanceof InviteQuotaError && error.quota === 0
      ? `No invites this week. ${error.message}`
      : error instanceof Error ? error.message : String(error)
    console.error(chalk.red(message))
    process.exitCode = 1
  }
}

export function registerReferralCommands(program: Command): void {
  const referralCmd = program
    .command('referral')
    .description('Invite-only referrals: you and the new users you invite both earn bonus $ANTS from their usage for 12 weeks')
    .addHelpText('after', `
How it works:
  Invites are earned by activity: at least 1 USDC of usage or sales in the
  previous week gives 3 invites this week, plus one per 10 USDC, up to 20.
  Each invite works once, only for a new wallet that is not yours, and stops
  working 4 weeks after the week it was created (counting that week).
  For 12 weeks after the invite binds, you and the new user split their usage
  share 50/50; after that the inviter keeps earning alone.
  Claim on the ANTS dashboard (antseed ants). Rewards go to the authorized
  wallet (an inviter without one is paid directly).`)

  referralCmd
    .command('invite')
    .description('Create a single-use invite link from this week\'s quota (valid 4 weeks, new wallets only)')
    .option('--json', 'output as JSON', false)
    .action(async (options: { json?: boolean }, command: Command) => run(command, async (context) => {
      const created = await createReferralInvite(context)
      if (options.json) return printJson(created)
      for (const line of formatInviteCreated(created)) console.log(line)
    }))

  referralCmd
    .command('redeem <invite>')
    .description('Use an invite (code or link) for 12 weeks of bonus $ANTS; binds with your first paid or free request (new wallets only)')
    .option('--json', 'output as JSON', false)
    .action(async (value: string, options: { json?: boolean }, command: Command) => run(command, async (context) => {
      const result = await redeemReferralInvite({ client: requireReferrals(context), dataDir: context.dataDir, buyer: context.ctx.address, value })
      if (!result.ok) process.exitCode = 1
      if (options.json) return printJson(result)
      for (const line of formatRedeemResult(result)) console.log(line)
    }))

  referralCmd
    .command('status')
    .description('Show who invited you and your bonus, plus your invites left this week and the people you invited (via Antscan)')
    .option('--json', 'output as JSON', false)
    .action(async (options: { json?: boolean }, command: Command) => run(command, async (context) => {
      const status = await referralStatus(context)
      if (options.json) return printJson(status)
      for (const line of formatReferralStatus(status)) console.log(line)
    }))
}
