import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { createConsoleAuth } from '../../../gateway/auth/index.js'
import { consoleBaseUrl } from '../../../gateway/console.js'
import { formatUsdc } from '../../../gateway/money.js'
import { resolvePolicy } from '../../../gateway/policy-resolver.js'
import {
  DEFAULT_INVITE_HOURS,
  MAX_INVITE_HOURS,
  ORG_ROLES,
  cancelInvite,
  disableMember,
  enableMember,
  inviteMember,
  removeCredential,
  requireOpenInvite,
  updateMember,
  type CredentialStore,
  type UpdateMemberInput,
} from '../../../gateway/services/members.js'
import { DEFAULT_WORKSPACE_ID, type GatewayStore, type MemberRecord, type OrgRole, type WorkspaceRole } from '../../../gateway/store.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { addConsoleLocationOptions, resolveConsoleLocation, type ConsoleLocationOptions } from './console-link.js'
import { printResolved } from './key.js'
import { addConfirmOptions, addPolicyOptions, collect, confirmFlags, describePolicy, policyFromOptions } from './policy-options.js'
import {
  addLimitOptions,
  describeLimits,
  formatTime,
  isoOrNull,
  limitsUsd,
  parseCountOrNone,
  parseLimitOptions,
  printJson,
  requireMember,
  requireWorkspace,
  withGateway,
} from './shared.js'

/** `<workspace>` or `<workspace>:admin` / `<workspace>:member`. */
function parseWorkspaceGrant(store: GatewayStore, spec: string): { workspaceId: string; role: WorkspaceRole } {
  const match = /^(.*?)(?::(admin|member))?$/.exec(spec.trim())
  const target = match?.[1]?.trim() ?? ''
  if (!target) throw new Error(`--workspace "${spec}" needs a workspace id or name.`)
  return { workspaceId: requireWorkspace(store, target).id, role: (match?.[2] as WorkspaceRole | undefined) ?? 'member' }
}

/** Sign-in methods through the console's auth module, so removals end sessions exactly as in the console. */
function credentialStore(store: GatewayStore): CredentialStore {
  return createConsoleAuth({ store, publicUrl: null, now: () => Date.now(), log: () => undefined }, { env: {} })
}

function memberJson(store: GatewayStore, credentials: CredentialStore, member: MemberRecord) {
  return {
    id: member.id,
    label: member.label,
    email: member.email,
    orgRole: member.orgRole,
    status: member.status,
    workspaces: [...store.memberWorkspaceRoles(member.id)].map(([workspaceId, role]) => ({ workspaceId, role })),
    signInMethods: credentials.credentialsFor(member.id).map((row) => row.kind),
    limitsUsd: limitsUsd(member.limits),
    routingPolicy: member.routingPolicy,
    maxKeys: member.maxKeys,
    activeKeys: store.countActiveKeysForMember(member.id),
    createdAt: isoOrNull(member.createdAt),
  }
}

function statusLabel(status: MemberRecord['status']): string {
  if (status === 'active') return chalk.green('active')
  if (status === 'invited') return chalk.yellow('invited')
  return chalk.red('disabled')
}

function parseOrgRole(raw: string, flag = '--role'): OrgRole {
  const role = raw.trim().toLowerCase() as OrgRole
  if (!ORG_ROLES.includes(role)) throw new Error(`${flag} must be member, admin or owner.`)
  return role
}

export function registerGatewayMemberCommands(gateway: Command): void {
  const member = gateway.command('member').description('Invite and manage gateway console members')

  addConsoleLocationOptions(
    member.command('invite')
      .description('Invite someone to the console; prints a single-use invite link')
      .requiredOption('--label <name>', 'their name')
      .option('--email <email>', 'their email (lets them join with single sign-on)')
      .option('--role <role>', 'organization role: member, admin or owner', 'member')
      .option('--workspace <id|name[:admin]>', 'add them to a workspace, optionally as its admin (repeatable; default: Default workspace for members)', collect)
      .option('--expires-in-hours <hours>', `how long the link works (default: ${DEFAULT_INVITE_HOURS})`, parsePositiveInteger),
  )
    .option('--json', 'print machine-readable JSON', false)
    .action((options: ConsoleLocationOptions & { label: string; email?: string; role: string; workspace?: string[]; expiresInHours?: number; json: boolean }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const label = options.label.trim()
      if (!label) throw new Error('--label cannot be empty.')
      const orgRole = parseOrgRole(options.role)
      const email = options.email?.trim().toLowerCase() || null
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`"${options.email}" is not an email address.`)
      if (email && store.findMemberByEmail(email)) throw new Error(`A member with email ${email} already exists.`)
      const hours = options.expiresInHours ?? DEFAULT_INVITE_HOURS
      if (hours > MAX_INVITE_HOURS) throw new Error(`--expires-in-hours can be at most ${MAX_INVITE_HOURS}.`)
      const grants = (options.workspace ?? []).map((spec) => parseWorkspaceGrant(store, spec))
      // Org owners and admins see every workspace; a plain member needs one.
      const workspaces = grants.length > 0 || orgRole !== 'member' ? grants : [{ workspaceId: DEFAULT_WORKSPACE_ID, role: 'member' as const }]
      const location = resolveConsoleLocation(store, options)
      const { invite, token } = inviteMember(ctx, actor, { label, email, orgRole, workspaces, expiresInHours: hours, createdBy: null })
      const url = `${consoleBaseUrl(location)}/console/invite#${token}`
      if (options.json) {
        printJson({ id: invite.id, memberId: invite.memberId, label, email, orgRole, workspaces, url, expiresAt: isoOrNull(invite.expiresAt) })
        return
      }
      console.log(chalk.green(`Invited ${label} as ${orgRole} (member ${invite.memberId}).`))
      console.log(`${chalk.bold('Invite link:')} ${url}`)
      console.log(chalk.dim(`Single use; expires ${new Date(invite.expiresAt).toISOString()}. Send it to them privately.`))
    }))

  member.command('invites')
    .description('List open invites')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const invites = store.listInvites().filter((invite) => invite.usedAt === null)
      if (options.json) {
        printJson(invites.map((invite) => ({ ...invite, expiresAt: isoOrNull(invite.expiresAt), createdAt: isoOrNull(invite.createdAt) })))
        return
      }
      if (invites.length === 0) {
        console.log(chalk.dim('No open invites.'))
        return
      }
      const table = new Table({ head: ['Id', 'Member', 'Name', 'Email', 'Role', 'Expires'] })
      for (const invite of invites) {
        table.push([invite.id, invite.memberId, invite.label, invite.email ?? '-', invite.orgRole, `${formatTime(invite.expiresAt)}${invite.expiresAt <= Date.now() ? ' (expired)' : ''}`])
      }
      console.log(table.toString())
    }))

  member.command('cancel-invite')
    .description('Cancel an open invite; its link stops working')
    .argument('<inviteId>', 'invite id (from `member invites`)')
    .action((id: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ ctx, actor }) => {
      requireOpenInvite(ctx, id)
      const invite = cancelInvite(ctx, actor, id)
      console.log(`Cancelled the invite for ${invite.label} (${invite.id}).`)
    }))

  member.command('list')
    .description('List console members')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const credentials = credentialStore(store)
      const members = store.listMembers()
      if (options.json) {
        printJson(members.map((record) => memberJson(store, credentials, record)))
        return
      }
      if (members.length === 0) {
        console.log(chalk.dim('No members yet. Claim the console with `antseed gateway console-link`.'))
        return
      }
      const workspaceNames = new Map(store.listWorkspaces().map((workspace) => [workspace.id, workspace.name]))
      const table = new Table({ head: ['Id', 'Name', 'Email', 'Role', 'Status', 'Workspaces', 'Sign-in'] })
      for (const record of members) {
        const roles = [...store.memberWorkspaceRoles(record.id)]
          .map(([workspaceId, role]) => `${workspaceNames.get(workspaceId) ?? workspaceId}${role === 'admin' ? ' (admin)' : ''}`)
        table.push([
          record.id,
          record.label,
          record.email ?? '-',
          record.orgRole,
          statusLabel(record.status),
          record.orgRole === 'member' ? roles.join(', ') || '-' : 'all',
          credentials.credentialsFor(record.id).map((row) => row.kind).join(', ') || '-',
        ])
      }
      console.log(table.toString())
    }))

  member.command('show')
    .description('Show a member: role, workspaces, limits, key quota, policy and sign-in methods')
    .argument('<member>', 'member id or email')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrEmail: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const record = requireMember(store, idOrEmail)
      const credentials = credentialStore(store)
      if (options.json) {
        printJson(memberJson(store, credentials, record))
        return
      }
      const workspaceNames = new Map(store.listWorkspaces().map((workspace) => [workspace.id, workspace.name]))
      const spent = store.spendByPeriod({ memberId: record.id })
      console.log(`${chalk.bold(record.label)} ${chalk.dim(record.id)}  ${statusLabel(record.status)}`)
      console.log(`Email: ${record.email ?? '-'}`)
      console.log(`Org role: ${record.orgRole}`)
      const roles = [...store.memberWorkspaceRoles(record.id)].map(([workspaceId, role]) => `${workspaceNames.get(workspaceId) ?? workspaceId} (${role})`)
      console.log(`Workspaces: ${roles.join(', ') || '-'}`)
      console.log(`Limits: ${describeLimits(record)}  ${chalk.dim(`(spent: ${Object.entries(spent).map(([period, value]) => `${period} ${formatUsdc(value)}`).join(', ')})`)}`)
      console.log(`Keys: ${store.countActiveKeysForMember(record.id)} active${record.maxKeys === null ? '' : ` of at most ${record.maxKeys}`}`)
      console.log(chalk.bold('Routing policy:'))
      for (const line of describePolicy(record.routingPolicy, store)) console.log(`  ${line}`)
      const methods = credentials.credentialsFor(record.id)
      console.log(chalk.bold('Sign-in methods:'))
      if (methods.length === 0) console.log(chalk.dim('  none'))
      for (const method of methods) console.log(`  ${method.id}  ${method.kind}  ${method.label}  last used ${formatTime(method.lastUsedAt)}`)
    }))

  addLimitOptions(
    member.command('update')
      .description('Change a member: name, email, org role, spend caps across all their keys, key quota')
      .argument('<member>', 'member id or email')
      .option('--label <name>', 'their name')
      .option('--email <email>', 'their email ("none" removes it)')
      .option('--role <role>', 'organization role: member, admin or owner (demoting an admin revokes their management tokens)')
      .option('--max-keys <n>', 'how many keys they may create themselves ("none" for no limit)'),
    true,
  )
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrEmail: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireMember(store, idOrEmail)
      const limits = parseLimitOptions(options)
      const email = typeof options['email'] === 'string' ? options['email'].trim().toLowerCase() : undefined
      if (email && email !== 'none' && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`"${options['email']}" is not an email address.`)
      const patch: UpdateMemberInput = {
        ...(typeof options['label'] === 'string' ? { label: options['label'] } : {}),
        ...(email !== undefined ? { email: email === 'none' ? null : email } : {}),
        ...(typeof options['role'] === 'string' ? { orgRole: parseOrgRole(options['role']) } : {}),
        ...(Object.keys(limits).length ? { limits } : {}),
        ...(typeof options['maxKeys'] === 'string' ? { maxKeys: parseCountOrNone(options['maxKeys'], '--max-keys') } : {}),
      }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change: pass --label, --email, --role, --max-keys or a limit flag.')
      const updated = updateMember(ctx, actor, record.id, patch)
      if (options['json']) {
        printJson(memberJson(store, credentialStore(store), updated))
        return
      }
      console.log(`Updated ${updated.label} (${updated.id}): ${updated.orgRole}, limits ${describeLimits(updated)}, max keys ${updated.maxKeys ?? 'no limit'}.`)
    }))

  const policy = member.command('policy').description('A member\'s routing policy, applied to every key they own')

  policy.command('show')
    .description('Show a member\'s policy and the effective policy with the gateway default above it')
    .argument('<member>', 'member id or email')
    .option('--workspace <id|name>', 'also apply this workspace\'s policies')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrEmail: string, options: { workspace?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const record = requireMember(store, idOrEmail)
      const resolved = resolvePolicy(store, { memberId: record.id, ...(options.workspace ? { workspaceId: requireWorkspace(store, options.workspace).id } : {}) })
      if (options.json) {
        printJson({ routingPolicy: record.routingPolicy, effective: resolved.policy, sources: resolved.sources })
        return
      }
      printResolved(store, resolved)
    }))

  addConfirmOptions(addPolicyOptions(
    policy.command('set')
      .description('Set a member\'s routing policy (replaces it unless --merge)')
      .argument('<member>', 'member id or email'),
  )).action((idOrEmail: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
    const record = requireMember(store, idOrEmail)
    const updated = updateMember(ctx, actor, record.id, { routingPolicy: policyFromOptions(store, options, record.routingPolicy), ...confirmFlags(options) })
    console.log(`Routing policy of ${updated.label} (${updated.id}):`)
    for (const line of describePolicy(updated.routingPolicy, store)) console.log(`  ${line}`)
  }))

  policy.command('clear')
    .description('Remove a member\'s routing policy')
    .argument('<member>', 'member id or email')
    .action((idOrEmail: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireMember(store, idOrEmail)
      updateMember(ctx, actor, record.id, { routingPolicy: null })
      console.log(`Cleared the routing policy of ${record.label} (${record.id}).`)
    }))

  member.command('disable')
    .description('Disable a member: ends their console sessions and revokes the keys they own')
    .argument('<member>', 'member id or email')
    .action((idOrEmail: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const target = requireMember(store, idOrEmail)
      if (target.orgRole === 'owner' && target.status === 'active' && store.countActiveOwners() <= 1) {
        throw new Error('This is the only owner; make someone else owner first.')
      }
      const { revokedKeys, revokedTokens } = disableMember(ctx, actor, target.id)
      console.log(`Disabled ${target.label} (${target.id}); revoked ${revokedKeys.length} key(s) and ${revokedTokens.length} management token(s).`)
    }))

  member.command('enable')
    .description('Re-enable a disabled member (their revoked keys stay revoked)')
    .argument('<member>', 'member id or email')
    .action((idOrEmail: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const target = requireMember(store, idOrEmail)
      if (target.status === 'invited') throw new Error('This member has not accepted their invite yet.')
      enableMember(ctx, actor, target.id)
      console.log(`Enabled ${target.label} (${target.id}).`)
    }))

  const credentials = member.command('credentials').description('A member\'s console sign-in methods (passkeys, wallets, single sign-on)')

  credentials.command('list')
    .description('List a member\'s sign-in methods')
    .argument('<member>', 'member id or email')
    .option('--json', 'print machine-readable JSON', false)
    .action((idOrEmail: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const record = requireMember(store, idOrEmail)
      const methods = credentialStore(store).credentialsFor(record.id)
      if (options.json) {
        printJson(methods.map((method) => ({ ...method, createdAt: isoOrNull(method.createdAt), lastUsedAt: isoOrNull(method.lastUsedAt) })))
        return
      }
      if (methods.length === 0) {
        console.log(chalk.dim(`${record.label} has no sign-in methods yet.`))
        return
      }
      const table = new Table({ head: ['Id', 'Kind', 'Label', 'Added', 'Last used'] })
      for (const method of methods) table.push([method.id, method.kind, method.label, formatTime(method.createdAt), formatTime(method.lastUsedAt)])
      console.log(table.toString())
    }))

  credentials.command('remove')
    .description('Remove a sign-in method and end all of the member\'s console sessions')
    .argument('<member>', 'member id or email')
    .argument('<credentialId>', 'sign-in method id (from `credentials list`)')
    .option('--allow-last', 'remove their last sign-in method too (they cannot sign in until re-invited)', false)
    .action((idOrEmail: string, credentialId: string, options: { allowLast: boolean }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const record = requireMember(store, idOrEmail)
      try {
        const removed = removeCredential(ctx, actor, credentialStore(store), { memberId: record.id, credentialId, allowLast: options.allowLast })
        console.log(`Removed ${removed.kind} sign-in "${removed.label}" from ${record.label}; their console sessions ended.`)
      } catch (error) {
        if ((error as { code?: string }).code === 'last_credential') throw new Error('This is their last sign-in method; pass --allow-last to remove it anyway.')
        throw error
      }
    }))
}
