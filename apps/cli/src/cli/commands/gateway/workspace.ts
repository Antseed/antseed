import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { buyerIdentityDir } from '../../../buyer-identities/store.js'
import { NO_BUDGET_LIMITS } from '../../../gateway/limits.js'
import { formatUsdc } from '../../../gateway/money.js'
import { resolvePolicy } from '../../../gateway/policy-resolver.js'
import {
  createWorkspace,
  deleteWorkspace,
  removeWorkspaceMember,
  setWorkspaceMember,
  updateWorkspace,
  withWallet,
} from '../../../gateway/services/workspaces.js'
import type { GatewayStore, WorkspaceRecord, WorkspaceRole } from '../../../gateway/store.js'
import { printResolved } from './key.js'
import { registerGatewayOperatorCommands } from './operator.js'
import { addConfirmOptions, addPolicyOptions, confirmFlags, describePolicy, policyFromOptions } from './policy-options.js'
import {
  addBuyerPortOption,
  addLimitOptions,
  describeLimits,
  isoOrNull,
  limitsUsd,
  parseLimitOptions,
  printJson,
  requireMember,
  requireWorkspace,
  withGateway,
} from './shared.js'

function workspaceJson(store: GatewayStore, workspace: WorkspaceRecord & { walletNote?: string }) {
  return {
    id: workspace.id,
    name: workspace.name,
    isDefault: workspace.isDefault,
    identity: workspace.buyerIdentity,
    walletAddress: workspace.walletAddress,
    ...(workspace.walletNote ? { walletNote: workspace.walletNote } : {}),
    limitsUsd: limitsUsd(workspace.limits),
    routingPolicy: workspace.routingPolicy,
    orgRoutingPolicy: workspace.orgRoutingPolicy,
    members: store.countWorkspaceMembers(workspace.id),
    activeKeys: store.countWorkspaceKeys(workspace.id),
    createdAt: isoOrNull(workspace.createdAt),
  }
}

/** The data dir `antseed buyer deposit` uses for an identity's wallet. */
function fundingDataDir(dataDir: string, identity: string): string {
  return identity === DEFAULT_BUYER_IDENTITY ? dataDir : buyerIdentityDir(dataDir, identity)
}

function parseWorkspaceRole(raw: string): WorkspaceRole {
  const role = raw.trim().toLowerCase()
  if (role !== 'admin' && role !== 'member') throw new Error('The workspace role must be admin or member.')
  return role
}

/** `workspace` (the workspace admins' policy) or `org` (the org admins' policy above it). */
function policyLayer(raw: unknown): 'routingPolicy' | 'orgRoutingPolicy' {
  const layer = String(raw ?? 'workspace').trim().toLowerCase()
  if (layer === 'workspace') return 'routingPolicy'
  if (layer === 'org') return 'orgRoutingPolicy'
  throw new Error('--layer must be workspace or org.')
}

export function registerGatewayWorkspaceCommands(gateway: Command): void {
  const workspace = gateway.command('workspace').description('Manage console workspaces (each pays from its own wallet): budgets, routing policy, members')

  workspace.command('list')
    .description('List workspaces with their wallets, members, keys and budgets')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }, cmd: Command) => withGateway(cmd, async ({ store, ctx }) => {
      const rows = await Promise.all(store.listWorkspaces().map((record) => withWallet(ctx, record)))
      if (options.json) {
        printJson(rows.map((record) => workspaceJson(store, record)))
        return
      }
      const table = new Table({ head: ['Id', 'Name', 'Identity', 'Wallet', 'Members', 'Keys', 'Budgets'] })
      for (const record of rows) {
        table.push([
          record.id,
          `${record.name}${record.isDefault ? chalk.dim(' (default)') : ''}`,
          record.buyerIdentity,
          record.walletAddress ?? (record.walletNote ? chalk.dim(record.walletNote) : '-'),
          String(store.countWorkspaceMembers(record.id)),
          String(store.countWorkspaceKeys(record.id)),
          describeLimits(record),
        ])
      }
      console.log(table.toString())
    }))

  addConfirmOptions(addLimitOptions(
    workspace.command('create')
      .description('Create a workspace with a new buyer identity (wallet), or an existing one')
      .requiredOption('--name <name>', 'workspace name')
      .option('--identity <name>', 'pay from this existing buyer identity instead of creating one'),
    false,
  ))
    .option('--json', 'print machine-readable JSON', false)
    .action((options: Record<string, unknown>, cmd: Command) => withGateway(cmd, async ({ store, dataDir, ctx, actor }) => {
      const name = String(options['name']).trim()
      if (!name) throw new Error('--name cannot be empty.')
      if (name.length > 100) throw new Error('--name can be at most 100 characters.')
      const record = await createWorkspace(ctx, actor, {
        name,
        limits: { ...NO_BUDGET_LIMITS, ...parseLimitOptions(options) },
        ...(typeof options['identity'] === 'string' ? { buyerIdentity: options['identity'] } : {}),
        ...confirmFlags(options),
      })
      if (options['json']) {
        printJson(workspaceJson(store, record))
        return
      }
      console.log(chalk.green(`Created workspace ${record.id} (${record.name})`))
      console.log(`Identity: ${record.buyerIdentity}${record.walletAddress ? ` (${record.walletAddress})` : ''}`)
      console.log(`Budgets: ${describeLimits(record)}`)
      console.log(chalk.dim(`Create keys in it with \`antseed gateway key create --label <name> --workspace ${record.id}\`.`))
      console.log(chalk.dim(`Fund its wallet: send USDC on Base to the address above, or show a QR code with`))
      console.log(chalk.dim(`  antseed --data-dir ${fundingDataDir(dataDir, record.buyerIdentity)} buyer deposit --no-watch`))
    }))

  workspace.command('show')
    .description('Show a workspace: wallet, budgets and spend, routing policies, members')
    .argument('<workspace>', 'workspace id or name')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrName: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, async ({ store, ctx }) => {
      const record = await withWallet(ctx, requireWorkspace(store, idOrName))
      const members = store.workspaceMembers(record.id)
      if (options.json) {
        printJson({ ...workspaceJson(store, record), memberRoles: members.map(({ member, role }) => ({ memberId: member.id, label: member.label, role })) })
        return
      }
      const spent = store.spendByPeriod({ workspaceId: record.id })
      console.log(`${chalk.bold(record.name)} ${chalk.dim(record.id)}${record.isDefault ? chalk.dim(' (default)') : ''}`)
      console.log(`Identity: ${record.buyerIdentity}${record.walletAddress ? ` (${record.walletAddress})` : record.walletNote ? ` (wallet ${record.walletNote})` : ''}`)
      console.log(`Budgets: ${describeLimits(record)}`)
      console.log(`Spent: ${Object.entries(spent).map(([period, value]) => `${period} ${formatUsdc(value)}`).join(', ')}`)
      console.log(`Active keys: ${store.countWorkspaceKeys(record.id)}`)
      console.log(chalk.bold('Org routing policy:'))
      for (const line of describePolicy(record.orgRoutingPolicy, store)) console.log(`  ${line}`)
      console.log(chalk.bold('Workspace routing policy:'))
      for (const line of describePolicy(record.routingPolicy, store)) console.log(`  ${line}`)
      console.log(chalk.bold('Members:'))
      if (members.length === 0) console.log(chalk.dim('  none (org owners and admins see every workspace)'))
      for (const { member, role } of members) console.log(`  ${member.id}  ${member.label}${member.email ? ` <${member.email}>` : ''}  ${role}`)
    }))

  addLimitOptions(
    workspace.command('update')
      .description('Rename a workspace or change its budgets')
      .argument('<workspace>', 'workspace id or name')
      .option('--name <name>', 'new name'),
    true,
  )
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrName: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireWorkspace(store, idOrName)
      const limits = parseLimitOptions(options)
      if (typeof options['name'] !== 'string' && Object.keys(limits).length === 0) throw new Error('Nothing to change: pass --name or a limit flag.')
      const updated = updateWorkspace(ctx, actor, record.id, {
        ...(typeof options['name'] === 'string' ? { name: options['name'] } : {}),
        ...(Object.keys(limits).length ? { limits } : {}),
      })
      if (options['json']) {
        printJson(workspaceJson(store, updated))
        return
      }
      console.log(`Updated ${updated.name} (${updated.id}): budgets ${describeLimits(updated)}.`)
    }))

  addBuyerPortOption(
    workspace.command('delete')
      .description('Delete a workspace without active keys or funds (its buyer identity is kept)')
      .argument('<workspace>', 'workspace id or name'),
  ).action((idOrName: string, _options: unknown, cmd: Command) => withGateway(cmd, async ({ store, ctx, actor, buyer }) => {
    const record = requireWorkspace(store, idOrName)
    await deleteWorkspace(ctx, actor, record.id, await buyer())
    console.log(`Deleted workspace ${record.name} (${record.id}); identity ${record.buyerIdentity} was kept.`)
  }))

  const policy = workspace.command('policy').description('A workspace\'s routing policies: the workspace admins\' (default) or the org admins\' with --layer org')

  policy.command('show')
    .description('Show both workspace policies and the effective policy with the gateway default above them')
    .argument('<workspace>', 'workspace id or name')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrName: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const record = requireWorkspace(store, idOrName)
      const resolved = resolvePolicy(store, { workspaceId: record.id })
      if (options.json) {
        printJson({ routingPolicy: record.routingPolicy, orgRoutingPolicy: record.orgRoutingPolicy, effective: resolved.policy, sources: resolved.sources })
        return
      }
      printResolved(store, resolved)
    }))

  addConfirmOptions(addPolicyOptions(
    policy.command('set')
      .description('Set a workspace routing policy (replaces it unless --merge)')
      .argument('<workspace>', 'workspace id or name')
      .option('--layer <layer>', 'workspace (default) or org', 'workspace'),
  )).action((idOrName: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
    const record = requireWorkspace(store, idOrName)
    const field = policyLayer(options['layer'])
    const next = policyFromOptions(store, options, record[field])
    const updated = updateWorkspace(ctx, actor, record.id, { [field]: next, ...confirmFlags(options) })
    console.log(`${field === 'orgRoutingPolicy' ? 'Org' : 'Workspace'} routing policy of ${updated.name}:`)
    for (const line of describePolicy(updated[field], store)) console.log(`  ${line}`)
  }))

  policy.command('clear')
    .description('Remove a workspace routing policy')
    .argument('<workspace>', 'workspace id or name')
    .option('--layer <layer>', 'workspace (default) or org', 'workspace')
    .action((idOrName: string, options: { layer: string }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireWorkspace(store, idOrName)
      const field = policyLayer(options.layer)
      updateWorkspace(ctx, actor, record.id, { [field]: null })
      console.log(`Cleared the ${field === 'orgRoutingPolicy' ? 'org' : 'workspace'} routing policy of ${record.name}.`)
    }))

  const members = workspace.command('member').description('Who belongs to a workspace, and as what')

  members.command('list')
    .description('List a workspace\'s members and their roles')
    .argument('<workspace>', 'workspace id or name')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrName: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const record = requireWorkspace(store, idOrName)
      const rows = store.workspaceMembers(record.id)
      if (options.json) {
        printJson(rows.map(({ member, role }) => ({ memberId: member.id, label: member.label, email: member.email, status: member.status, role })))
        return
      }
      if (rows.length === 0) {
        console.log(chalk.dim('No members (org owners and admins see every workspace).'))
        return
      }
      const table = new Table({ head: ['Id', 'Name', 'Email', 'Status', 'Role'] })
      for (const { member, role } of rows) table.push([member.id, member.label, member.email ?? '-', member.status, role])
      console.log(table.toString())
    }))

  members.command('add')
    .description('Add a member to a workspace')
    .argument('<workspace>', 'workspace id or name')
    .argument('<member>', 'member id or email')
    .option('--role <role>', 'admin or member', 'member')
    .action((idOrName: string, memberRef: string, options: { role: string }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireWorkspace(store, idOrName)
      const target = requireMember(store, memberRef)
      setWorkspaceMember(ctx, actor, record.id, target.id, parseWorkspaceRole(options.role))
      console.log(`${target.label} is now ${parseWorkspaceRole(options.role)} of ${record.name}.`)
    }))

  members.command('role')
    .description('Change a member\'s role in a workspace')
    .argument('<workspace>', 'workspace id or name')
    .argument('<member>', 'member id or email')
    .argument('<role>', 'admin or member')
    .action((idOrName: string, memberRef: string, role: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireWorkspace(store, idOrName)
      const target = requireMember(store, memberRef)
      if (!store.memberWorkspaceRoles(target.id).has(record.id)) throw new Error(`${target.label} is not in ${record.name}; add them with \`workspace member add\`.`)
      setWorkspaceMember(ctx, actor, record.id, target.id, parseWorkspaceRole(role))
      console.log(`${target.label} is now ${parseWorkspaceRole(role)} of ${record.name}.`)
    }))

  members.command('remove')
    .description('Remove a member from a workspace; their keys in it are revoked')
    .argument('<workspace>', 'workspace id or name')
    .argument('<member>', 'member id or email')
    .action((idOrName: string, memberRef: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireWorkspace(store, idOrName)
      const target = requireMember(store, memberRef)
      const { revokedKeys } = removeWorkspaceMember(ctx, actor, record.id, target.id)
      console.log(`Removed ${target.label} from ${record.name}; revoked ${revokedKeys.length} key(s).`)
    }))

  registerGatewayOperatorCommands(workspace)
}
