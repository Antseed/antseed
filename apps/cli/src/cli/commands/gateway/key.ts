import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { buyerIdentityAddress, buyerIdentityDir, buyerIdentityExists, createBuyerIdentity } from '../../../buyer-identities/store.js'
import { effectiveKeyLimits } from '../../../gateway/accounting.js'
import { BUDGET_PERIODS, NO_BUDGET_LIMITS, periodStart, type BudgetLimits, type BudgetPeriod } from '../../../gateway/limits.js'
import { formatUsdc, usdcToDecimalString } from '../../../gateway/money.js'
import { resolvePolicy } from '../../../gateway/policy-resolver.js'
import { createKey, revokeKey, rotateKey, updateKey, type UpdateKeyInput } from '../../../gateway/services/keys.js'
import type { ApiKeyRecord, GatewayStore } from '../../../gateway/store.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { addConfirmOptions, addPolicyOptions, confirmFlags, describePolicy, policyFromOptions } from './policy-options.js'
import {
  addLimitOptions,
  addOwnerLimitOptions,
  describeLimits,
  formatTime,
  isoOrNull,
  keyStatusLabel,
  limitsUsd,
  parseLimitOptions,
  parseOnOff,
  parseOwnerLimitOptions,
  printJson,
  requireKey,
  requireMember,
  requireWorkspace,
  slugifyIdentityName,
  withGateway,
} from './shared.js'

const DAY_MS = 24 * 60 * 60 * 1000
const PERIOD_SPEND_LABELS: Record<BudgetPeriod, string> = { daily: 'Today', weekly: 'This week', monthly: 'This month', total: 'Lifetime' }

async function uniqueIdentityName(dataDir: string, base: string): Promise<string> {
  if (!await buyerIdentityExists(dataDir, base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, 28)}-${suffix}`
    if (!await buyerIdentityExists(dataDir, candidate)) return candidate
  }
}

function keyJson(store: GatewayStore, key: ApiKeyRecord) {
  const spent = store.spendByPeriod({ keyId: key.id })
  const usage = store.usageStats(key.id)
  return {
    id: key.id,
    label: key.label,
    hint: key.hint,
    identity: key.buyerIdentity,
    workspaceId: key.workspaceId,
    ownerMemberId: key.ownerMemberId,
    status: key.status,
    source: key.source,
    topupEnabled: key.topupEnabled,
    limitsUsd: limitsUsd(key.limits),
    ownerLimitsUsd: limitsUsd(key.ownerLimits),
    effectiveLimitsUsd: limitsUsd(effectiveKeyLimits(key)),
    routingPolicy: key.routingPolicy,
    ownerRoutingPolicy: key.ownerRoutingPolicy,
    spentUsd: Object.fromEntries(BUDGET_PERIODS.map((period) => [period, usdcToDecimalString(spent[period])])),
    requests: usage.requests,
    failedRequests: usage.failedRequests,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    createdAt: isoOrNull(key.createdAt),
    expiresAt: isoOrNull(key.expiresAt),
    lastUsedAt: isoOrNull(key.lastUsedAt),
  }
}

function printSecret(record: ApiKeyRecord, secret: string, verb: string): void {
  console.log(chalk.green(`${verb} key ${record.id} (${record.label})`))
  console.log(`${chalk.bold('API key:')} ${secret}`)
  console.log(chalk.yellow('Store it now; it cannot be shown again.'))
}

export function registerGatewayKeyCommands(gateway: Command): void {
  const key = gateway.command('key').description('Create and manage gateway API keys')

  addLimitOptions(
    key.command('create')
      .description('Create an API key; the secret is shown only once')
      .requiredOption('--label <name>', 'who or what the key is for')
      .option('--identity <name>', 'buyer identity that pays for this key (default: the default identity)')
      .option('--new-identity [name]', 'create a dedicated buyer identity and wallet for this key')
      .option('--workspace <id|name>', 'create the key in this workspace; it pays from the workspace\'s wallet')
      .option('--owner <member>', 'member (id or email) who owns the key and can manage it in the console')
      .option('--expires-in-days <days>', 'expire the key after this many days', parsePositiveInteger)
      .option('--allow-topup', 'let the key holder fund the key\'s wallet with x402 (needs its own identity)', false)
      .option('--json', 'print machine-readable JSON', false),
    false,
  ).action(async (options: Record<string, unknown>, cmd: Command) => withGateway(cmd, async ({ store, dataDir, ctx, actor }) => {
    const label = String(options['label']).trim()
    if (!label) throw new Error('--label cannot be empty.')
    const walletOptions = ['identity', 'newIdentity', 'workspace'].filter((name) => options[name])
    if (walletOptions.length > 1) throw new Error('Use only one of --identity, --new-identity and --workspace.')
    const workspace = typeof options['workspace'] === 'string' ? requireWorkspace(store, options['workspace']) : null
    let identityName = workspace?.buyerIdentity ?? (typeof options['identity'] === 'string' ? options['identity'] : DEFAULT_BUYER_IDENTITY)
    let createdIdentity = false
    if (workspace) {
      // The workspace's identity already exists.
    } else if (options['newIdentity']) {
      const requested = typeof options['newIdentity'] === 'string'
        ? options['newIdentity']
        : await uniqueIdentityName(dataDir, slugifyIdentityName(label))
      identityName = (await createBuyerIdentity(dataDir, requested)).name
      createdIdentity = true
    } else if (identityName !== DEFAULT_BUYER_IDENTITY && !await buyerIdentityExists(dataDir, identityName)) {
      throw new Error(`Unknown buyer identity "${identityName}". Create it with \`antseed buyer identity create ${identityName}\` or use --new-identity.`)
    }
    const topupEnabled = options['allowTopup'] === true
    if (topupEnabled && identityName === DEFAULT_BUYER_IDENTITY) {
      throw new Error('--allow-topup needs a key with its own wallet; add --new-identity, --identity <name> or --workspace <non-default workspace>.')
    }
    const limits: BudgetLimits = { ...NO_BUDGET_LIMITS, ...parseLimitOptions(options) }
    const days = options['expiresInDays'] as number | undefined
    const owner = typeof options['owner'] === 'string' ? requireMember(store, options['owner']) : null
    const { key: record, secret } = createKey(ctx, actor, {
      label,
      ...(workspace ? { workspaceId: workspace.id } : { buyerIdentity: identityName }),
      ...(owner ? { ownerMemberId: owner.id } : {}),
      limits,
      topupEnabled,
      expiresAt: days ? Date.now() + days * DAY_MS : null,
    })
    const address = await buyerIdentityAddress(dataDir, identityName)

    if (options['json']) {
      printJson({ ...keyJson(store, record), apiKey: secret, identityAddress: address })
      return
    }
    printSecret(record, secret, 'Created')
    console.log(`Workspace: ${store.getWorkspace(record.workspaceId)?.name ?? record.workspaceId}`)
    console.log(`Identity: ${identityName}${address ? ` (${address})` : ''}`)
    if (owner) console.log(`Owner: ${owner.label} (${owner.id})`)
    console.log(`Limits: ${describeLimits(record)}`)
    if (record.topupEnabled) console.log('Top-ups: enabled (POST /v1/key/topup)')
    if (record.expiresAt !== null) console.log(`Expires: ${new Date(record.expiresAt).toISOString()}`)
    if (createdIdentity) {
      console.log('')
      console.log(chalk.dim('This key has its own buyer wallet. Fund it by sending USDC on Base to the address above;'))
      console.log(chalk.dim('a running buyer deposits it into the identity\'s credits automatically. As a QR code:'))
      console.log(chalk.dim(`  antseed --data-dir ${buyerIdentityDir(dataDir, identityName)} buyer deposit --no-watch`))
    }
  }))

  key.command('list')
    .description('List API keys with their spend and limits')
    .option('--all', 'include revoked keys', false)
    .option('--workspace <id|name>', 'only keys in this workspace')
    .option('--member <member>', 'only keys owned by this member (id or email)')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { all: boolean; workspace?: string; member?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const workspaceId = options.workspace ? requireWorkspace(store, options.workspace).id : undefined
      const ownerMemberId = options.member ? requireMember(store, options.member).id : undefined
      const keys = store.listKeys({ ...(workspaceId ? { workspaceId } : {}), ...(ownerMemberId ? { ownerMemberId } : {}) })
        .filter((record) => options.all || record.status === 'active')
      if (options.json) {
        printJson(keys.map((record) => keyJson(store, record)))
        return
      }
      if (keys.length === 0) {
        console.log(chalk.dim('No API keys. Create one with `antseed gateway key create --label <name>`.'))
        return
      }
      const workspaceNames = new Map(store.listWorkspaces().map((workspace) => [workspace.id, workspace.name]))
      const table = new Table({ head: ['Id', 'Label', 'Workspace', 'Identity', 'Status', 'Today', 'Month', 'Total', 'Limits', 'Last used'] })
      for (const record of keys) {
        const spent = store.periodSpend(record.id)
        table.push([
          record.id,
          record.label,
          workspaceNames.get(record.workspaceId) ?? record.workspaceId,
          record.buyerIdentity,
          keyStatusLabel(record),
          formatUsdc(spent.daily),
          formatUsdc(spent.monthly),
          formatUsdc(spent.total),
          describeLimits({ limits: effectiveKeyLimits(record) }),
          formatTime(record.lastUsedAt),
        ])
      }
      console.log(table.toString())
    }))

  key.command('show')
    .description('Show a key: usage, both limit layers and routing policies')
    .argument('<id>', 'key id')
    .option('--json', 'print machine-readable JSON', false)
    .action((id: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, async ({ store, dataDir }) => {
      const record = requireKey(store, id)
      if (options.json) {
        printJson(keyJson(store, record))
        return
      }
      const spent = store.spendByPeriod({ keyId: record.id })
      const today = store.usageStats(record.id, periodStart('daily', Date.now()))
      const total = store.usageStats(record.id)
      const address = await buyerIdentityAddress(dataDir, record.buyerIdentity)
      const owner = record.ownerMemberId ? store.getMember(record.ownerMemberId) : null
      console.log(`${chalk.bold(record.label)} ${chalk.dim(record.id)}  ${keyStatusLabel(record)}`)
      console.log(`Key: ${record.hint}`)
      console.log(`Workspace: ${store.getWorkspace(record.workspaceId)?.name ?? record.workspaceId} (${record.workspaceId})`)
      console.log(`Identity: ${record.buyerIdentity}${address ? ` (${address})` : ''}`)
      console.log(`Owner: ${owner ? `${owner.label} (${owner.id})` : '-'}`)
      console.log(`Top-ups: ${record.topupEnabled ? 'enabled' : 'disabled'}`)
      const effective = effectiveKeyLimits(record)
      for (const period of BUDGET_PERIODS) {
        const limit = effective[period]
        console.log(`${PERIOD_SPEND_LABELS[period]}: ${formatUsdc(spent[period])}${limit === null ? '' : ` of ${formatUsdc(limit)}`}`)
      }
      console.log(`Admin limits: ${describeLimits(record)}`)
      console.log(`Owner limits: ${describeLimits({ limits: record.ownerLimits })}`)
      console.log(`Requests: ${total.requests} (${total.failedRequests} failed), ${today.requests} today`)
      console.log(`Tokens: ${total.inputTokens} in (${total.cachedInputTokens} cached), ${total.outputTokens} out`)
      if (record.expiresAt !== null) console.log(`Expires: ${new Date(record.expiresAt).toISOString()}`)
      console.log(chalk.bold('Admin routing policy:'))
      for (const line of describePolicy(record.routingPolicy, store)) console.log(`  ${line}`)
      console.log(chalk.bold('Owner routing policy:'))
      for (const line of describePolicy(record.ownerRoutingPolicy, store)) console.log(`  ${line}`)
      console.log(chalk.dim('Effective policy with every level: `antseed gateway key policy show ' + record.id + '`'))
    }))

  addLimitOptions(
    key.command('limits')
      .description('Change the admin-layer spend caps of a key')
      .argument('<id>', 'key id'),
    true,
  ).action((id: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
    requireKey(store, id)
    const limits = parseLimitOptions(options)
    if (Object.keys(limits).length === 0) throw new Error('Pass at least one of --daily-limit, --weekly-limit, --monthly-limit or --total-limit.')
    const record = updateKey(ctx, actor, id, { limits, acceptNarrowed: true })
    console.log(`Limits for ${record.id}: ${describeLimits(record)}`)
  }))

  addConfirmOptions(addOwnerLimitOptions(addLimitOptions(
    key.command('update')
      .description('Change a key: label, admin and owner limit layers, expiry, owner, top-ups')
      .argument('<id>', 'key id')
      .option('--label <name>', 'new label'),
    true,
  )), false)
    .option('--expires-in-days <days>', 'expire the key this many days from now', parsePositiveInteger)
    .option('--no-expiry', 'remove the key\'s expiry')
    .option('--owner <member>', 'member (id or email) who owns the key; "none" for no owner')
    .option('--topup <state>', 'x402 top-ups by the key holder: on or off')
    .option('--accept-narrowed', 'save owner caps above the admin caps (they never apply)', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((id: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      requireKey(store, id)
      if (options['expiry'] === false && options['expiresInDays'] !== undefined) throw new Error('Use either --expires-in-days or --no-expiry.')
      const limits = parseLimitOptions(options)
      const ownerLimits = parseOwnerLimitOptions(options)
      const owner = typeof options['owner'] === 'string' ? ownerOption(store, options['owner']) : undefined
      const changes: UpdateKeyInput = {
        ...(typeof options['label'] === 'string' ? { label: options['label'] } : {}),
        ...(Object.keys(limits).length ? { limits } : {}),
        ...(Object.keys(ownerLimits).length ? { ownerLimits } : {}),
        ...(options['expiresInDays'] !== undefined ? { expiresAt: Date.now() + (options['expiresInDays'] as number) * DAY_MS } : {}),
        ...(options['expiry'] === false ? { expiresAt: null } : {}),
        ...(owner !== undefined ? { ownerMemberId: owner } : {}),
        ...(typeof options['topup'] === 'string' ? { topupEnabled: parseOnOff(options['topup'], '--topup') } : {}),
      }
      if (Object.keys(changes).length === 0) throw new Error('Nothing to change: pass --label, a limit flag, --expires-in-days, --no-expiry, --owner or --topup.')
      const record = updateKey(ctx, actor, id, { ...changes, ...confirmFlags(options) })
      if (options['json']) {
        printJson(keyJson(store, record))
        return
      }
      console.log(`Updated ${record.id} (${record.label}).`)
      console.log(`Admin limits: ${describeLimits(record)}`)
      console.log(`Owner limits: ${describeLimits({ limits: record.ownerLimits })}`)
    }))

  key.command('topup')
    .description('Allow or stop x402 top-ups of a key\'s wallet by the key holder')
    .argument('<id>', 'key id')
    .argument('<state>', 'on or off')
    .action((id: string, state: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const normalized = state.trim().toLowerCase()
      if (normalized !== 'on' && normalized !== 'off') throw new Error('State must be "on" or "off".')
      requireKey(store, id)
      const record = updateKey(ctx, actor, id, { topupEnabled: normalized === 'on' })
      console.log(`Top-ups for ${record.id} (${record.label}): ${normalized === 'on' ? 'enabled' : 'disabled'}.`)
    }))

  key.command('rotate')
    .description('Issue a new secret for a key (same id, limits, policy and usage); the old secret stops working')
    .argument('<id>', 'key id')
    .option('--json', 'print machine-readable JSON', false)
    .action((id: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      requireKey(store, id)
      const { key: record, secret } = rotateKey(ctx, actor, id)
      if (options.json) {
        printJson({ ...keyJson(store, record), apiKey: secret })
        return
      }
      printSecret(record, secret, 'Rotated')
    }))

  key.command('revoke')
    .description('Revoke a key immediately')
    .argument('<id>', 'key id')
    .action((id: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      requireKey(store, id)
      const record = revokeKey(ctx, actor, id)
      console.log(`Revoked ${record.id} (${record.label}).`)
      if (record.source === 'tunnel-env') {
        console.log(chalk.yellow('This key comes from ANTSEED_TUNNEL_API_KEY and is re-activated if the tunnel starts with it again.'))
      }
    }))

  const policy = key.command('policy').description('A key\'s routing policy: the admin layer, or the owner layer with --layer owner')

  policy.command('show')
    .description('Show both layers of a key\'s policy and the effective policy with every level above it')
    .argument('<id>', 'key id')
    .option('--preset <slug>', 'include a preset as the last level')
    .option('--json', 'print machine-readable JSON', false)
    .action((id: string, options: { preset?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const record = requireKey(store, id)
      const resolved = resolvePolicy(store, { keyId: record.id, ...(options.preset ? { presetSlug: options.preset } : {}) })
      if (options.json) {
        printJson({ routingPolicy: record.routingPolicy, ownerRoutingPolicy: record.ownerRoutingPolicy, effective: resolved.policy, sources: resolved.sources })
        return
      }
      printResolved(store, resolved)
    }))

  addConfirmOptions(addPolicyOptions(
    policy.command('set')
      .description('Set a key\'s routing policy (replaces it unless --merge)')
      .argument('<id>', 'key id')
      .option('--layer <layer>', 'admin (default) or owner', 'admin'),
  )).action((id: string, options: Record<string, unknown>, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
    const record = requireKey(store, id)
    const owner = keyLayer(options['layer'])
    const next = policyFromOptions(store, options, owner ? record.ownerRoutingPolicy : record.routingPolicy)
    const updated = updateKey(ctx, actor, id, { ...(owner ? { ownerRoutingPolicy: next } : { routingPolicy: next }), ...confirmFlags(options) })
    console.log(`${owner ? 'Owner' : 'Admin'} routing policy of ${updated.id} (${updated.label}):`)
    for (const line of describePolicy(owner ? updated.ownerRoutingPolicy : updated.routingPolicy, store)) console.log(`  ${line}`)
  }))

  policy.command('clear')
    .description('Remove a key\'s routing policy at one layer')
    .argument('<id>', 'key id')
    .option('--layer <layer>', 'admin (default) or owner', 'admin')
    .action((id: string, options: { layer: string }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      requireKey(store, id)
      const owner = keyLayer(options.layer)
      const updated = updateKey(ctx, actor, id, owner ? { ownerRoutingPolicy: null } : { routingPolicy: null })
      console.log(`Cleared the ${owner ? 'owner' : 'admin'} routing policy of ${updated.id} (${updated.label}).`)
    }))
}

/** `--owner`: a member id or email, or "none" for no owner. */
function ownerOption(store: GatewayStore, raw: string): string | null {
  return raw.trim().toLowerCase() === 'none' ? null : requireMember(store, raw).id
}

function keyLayer(raw: unknown): boolean {
  const layer = String(raw ?? 'admin').trim().toLowerCase()
  if (layer !== 'admin' && layer !== 'owner') throw new Error('--layer must be admin or owner.')
  return layer === 'owner'
}

/** The effective policy and the level each part comes from. */
export function printResolved(store: GatewayStore, resolved: ReturnType<typeof resolvePolicy>): void {
  console.log(chalk.bold('Effective policy:'))
  for (const line of describePolicy(resolved.policy, store)) console.log(`  ${line}`)
  console.log(chalk.bold('Levels (top to bottom):'))
  for (const source of resolved.sources) {
    if (source.level === 'buyer') {
      console.log(`  buyer: ${chalk.dim('the buyer\'s own config, applied by the buyer')}`)
      continue
    }
    const lines = source.policy ? describePolicy(source.policy, store) : [chalk.dim('(none)')]
    console.log(`  ${source.level}${source.id ? ` ${chalk.dim(source.id)}` : ''}: ${lines.join('; ')}`)
  }
}
