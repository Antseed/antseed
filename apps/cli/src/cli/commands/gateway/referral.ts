import type { Command } from 'commander'
import chalk from 'chalk'
import { resolveAntsChain, type AntsChainConfig } from '@antseed/ants'
import { ZeroAddress } from 'ethers'
import { loadBuyerSigningIdentity } from '../../../buyer-identities/store.js'
import { gatewayAntsContext } from '../../../gateway/console-api/handlers/wallet-chain.js'
import type { Builders, Referrals } from '../../../gateway/console-api/types.js'
import {
  clearWorkspaceInvite,
  createWorkspaceInvite,
  readBuilders,
  readReferrals,
  redeemWorkspaceInvite,
  referralStateDir,
  setBuilderAgent,
} from '../../../gateway/services/referrals.js'
import { sameAddress, walletMismatch } from '../../../gateway/services/wallet-address.js'
import { resolveWorkspaceWallet } from '../../../gateway/services/workspaces.js'
import type { WorkspaceRecord } from '../../../gateway/store.js'
import { addBuyerPortOption, printJson, requireWorkspace, withGateway, type CliGateway } from './shared.js'

/** Seams for tests; production uses the defaults. */
export const referralCliRuntime: { resolveChain: (configPath: string) => Promise<AntsChainConfig> } = {
  resolveChain: (configPath) => resolveAntsChain(configPath),
}

interface Resolved {
  workspace: WorkspaceRecord
  chain: AntsChainConfig
  address: string
  stateDir: string
}

async function resolve(gateway: CliGateway, idOrName: string): Promise<Resolved> {
  const workspace = requireWorkspace(gateway.store, idOrName)
  const resolved = await resolveWorkspaceWallet(gateway.ctx, workspace)
  if (!resolved.address) throw new Error(`Workspace "${workspace.name}" has no wallet address yet.`)
  return {
    workspace,
    chain: await referralCliRuntime.resolveChain(gateway.configPath),
    address: resolved.address,
    stateDir: referralStateDir(gateway.dataDir, workspace.buyerIdentity),
  }
}

function printReferrals(record: WorkspaceRecord, view: Referrals): void {
  console.log(`${chalk.bold(record.name)} ${chalk.dim(record.id)}  wallet ${view.address}`)
  if (!view.invitesAvailable) {
    console.log(chalk.dim('Referrals are not available on this network (no referrals contract).'))
    return
  }
  const invites = view.invites
  console.log(invites
    ? `Invites this epoch (${invites.epoch}): ${invites.left} of ${invites.quota} left`
    : 'Invites this epoch: unknown')
  if (view.available) {
    console.log(`Referred buyers: ${view.referredCount}  ·  payable ${view.payableAnts} ANTS${view.claimableEpochs.length ? ` (epochs ${view.claimableEpochs.join(', ')})` : ''}`)
    const total = view.buyers.reduce((sum, buyer) => sum + BigInt(buyer.points || '0'), 0n)
    for (const buyer of view.buyers) {
      const share = total > 0n ? `${Number((BigInt(buyer.points || '0') * 10_000n) / total) / 100}% of points` : 'no points yet'
      console.log(chalk.dim(`  ${buyer.buyer}  ${share}  ${buyer.ants} ANTS${buyer.pendingPoints !== '0' ? '  (earning this epoch)' : ''}`))
    }
  } else {
    console.log(chalk.dim('Referred buyers and rewards: unknown (the gateway has no explorer that indexes referrals). Invites still work.'))
  }
  const referee = view.referee
  if (referee.state === 'bound') {
    console.log(`Invited by ${referee.referrer ?? 'unknown'}${referee.weeksLeft !== null ? `  ·  ${referee.weeksLeft} bonus week(s) left` : ''}  ·  bonus payable ${referee.payableAnts} ANTS`)
  } else if (referee.state === 'invited') {
    console.log(`Carrying an invite from ${referee.referrer ?? 'unknown'} until a settlement binds it${referee.inviteExpiresEpoch !== null ? ` (before epoch ${referee.inviteExpiresEpoch})` : ''}.`)
  }
  if (view.claimableEpochs.length || referee.claimableEpochs.length) {
    console.log(chalk.dim('Claim from the console\'s Referrals page with the authorized wallet connected (claims are permissionless; ANTS go to the authorized wallet).'))
  }
}

function printBuilders(view: Builders): void {
  const { effective } = view
  const sourceLabel = { env: 'ANTSEED_CLIENT_AGENT_ID', config: 'buyer.clientAgentId', default: 'the Antseed CLI default', none: 'not set' }[effective.source]
  console.log(`Client agent: ${effective.agentId ?? chalk.yellow('none')}  ${chalk.dim(`(${sourceLabel})`)}`)
  if (!view.available || !view.agent) {
    console.log(chalk.dim('Builders program data is not available on this network.'))
    return
  }
  console.log(`Owner (paid): ${view.agent.owner ?? chalk.yellow('not registered')}`)
  console.log(`Payable: ${view.agent.payableAnts} ANTS${view.agent.claimableEpochs.length ? ` (epochs ${view.agent.claimableEpochs.join(', ')})` : ''}`)
  if (effective.source === 'default') console.log(chalk.dim('Usage through this gateway currently credits the Antseed CLI. Set your own agent: antseed gateway builders set <agentId>'))
}

export function registerGatewayReferralCommands(gateway: Command): void {
  const referral = gateway.command('referral')
    .description('Workspace wallets\' invite referrals: invites to hand out, referred buyers, and an invite to redeem')

  referral.command('status')
    .description('Show a workspace wallet\'s invites, referred buyers, payable ANTS and its own invite bonus')
    .argument('<workspace>', 'workspace id or name')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrName: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, async (gateway) => {
      const { workspace, chain, address, stateDir } = await resolve(gateway, idOrName)
      const view = await readReferrals(gatewayAntsContext({ chain, address, buyerAddress: address }), stateDir)
      if (options.json) printJson(view)
      else printReferrals(workspace, view)
    }))

  referral.command('invite')
    .description('Sign a new invite with the workspace wallet (off-chain; no transaction)')
    .argument('<workspace>', 'workspace id or name')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrName: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, async (gateway) => {
      const { workspace, chain, address, stateDir } = await resolve(gateway, idOrName)
      const identity = await loadBuyerSigningIdentity(gateway.dataDir, workspace.buyerIdentity)
      if (!identity) throw new Error(`Buyer identity "${workspace.buyerIdentity}" has no wallet key on this gateway.`)
      if (!sameAddress(identity.wallet.address, address)) throw walletMismatch(workspace.buyerIdentity, identity.wallet.address, address)
      const ctx = gatewayAntsContext({ chain, address, buyerAddress: address, signer: identity.wallet })
      const created = await createWorkspaceInvite(ctx, stateDir, gateway.actor, gateway.ctx, workspace)
      if (options.json) {
        printJson(created)
        return
      }
      console.log(chalk.green('Invite created.'))
      console.log(created.link)
      console.log(chalk.dim(`Works until epoch ${created.expiresEpoch} for a new buyer · ${created.left} of ${created.quota} invites left this epoch.`))
    }))

  referral.command('redeem')
    .description('Have a workspace wallet carry an invite; the first settlement binds it (new buyers only)')
    .argument('<workspace>', 'workspace id or name')
    .argument('<invite>', 'invite code or link')
    .action((idOrName: string, invite: string, _options: unknown, cmd: Command) => withGateway(cmd, async (gateway) => {
      const { workspace, chain, address, stateDir } = await resolve(gateway, idOrName)
      await redeemWorkspaceInvite(gatewayAntsContext({ chain, address, buyerAddress: address }), stateDir, invite, gateway.actor, gateway.ctx, workspace)
      console.log(chalk.green('Invite saved.'))
      console.log(chalk.dim('The running buyer picks it up within a minute; it binds with this wallet\'s next paid or free request.'))
    }))

  referral.command('clear')
    .description('Drop an invite a workspace wallet carries but that is not bound yet')
    .argument('<workspace>', 'workspace id or name')
    .action((idOrName: string, _options: unknown, cmd: Command) => withGateway(cmd, async (gateway) => {
      const { workspace, chain, address, stateDir } = await resolve(gateway, idOrName)
      await clearWorkspaceInvite(gatewayAntsContext({ chain, address, buyerAddress: address }), stateDir, gateway.actor, gateway.ctx, workspace)
      console.log('No invite is carried now.')
    }))

  const builders = gateway.command('builders')
    .description('The builders program: the ERC-8004 client agent this gateway\'s usage credits, and its rewards')

  builders.command('status')
    .description('Show the client agent the buyer signs and what the builders program owes it')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }, cmd: Command) => withGateway(cmd, async (gateway) => {
      const chain = await referralCliRuntime.resolveChain(gateway.configPath)
      const view = await readBuilders(gatewayAntsContext({ chain, address: ZeroAddress }), gateway.configPath)
      if (options.json) printJson(view)
      else printBuilders(view)
    }))

  addBuyerPortOption(builders.command('set')
    .description('Credit this gateway\'s usage to an ERC-8004 client agent ("none" clears it), then restart the buyer')
    .argument('<agentId>', 'agent id, or "none"'))
    .action((value: string, _options: unknown, cmd: Command) => withGateway(cmd, async (gateway) => {
      const chain = await referralCliRuntime.resolveChain(gateway.configPath)
      const agentId = value.trim().toLowerCase() === 'none' ? null : value.trim()
      const settings = { ...gateway.ctx, configPath: gateway.configPath, publicUrl: null, buyerPort: await gateway.buyerPort() }
      const { restartRequired } = await setBuilderAgent(settings, gateway.actor, { agentId }, gatewayAntsContext({ chain, address: ZeroAddress }), await gateway.buyer())
      console.log(agentId === null ? 'Client agent cleared.' : `Client agent set to ${agentId}.`)
      if (restartRequired) console.log(chalk.yellow('Restart the buyer to apply it (it could not restart itself).'))
    }))
}
