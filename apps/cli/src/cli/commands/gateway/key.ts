import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { buyerIdentityAddress, buyerIdentityDir, createBuyerIdentity, loadBuyerIdentity } from '../../../buyer-identities/store.js'
import { LIMIT_PERIODS, periodStart, type LimitPeriod, type SpendLimits } from '../../../gateway/limits.js'
import { formatUsdc, optionalUsdcToDecimalString, usdcToDecimalString } from '../../../gateway/money.js'
import type { ApiKeyRecord, GatewayStore } from '../../../gateway/store.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import {
  addLimitOptions,
  describeLimits,
  keyStatusLabel,
  openGatewayStore,
  parseLimitOptions,
  slugifyIdentityName,
} from './shared.js'

const DAY_MS = 24 * 60 * 60 * 1000
const PERIOD_SPEND_LABELS: Record<LimitPeriod, string> = { daily: 'Today', monthly: 'This month', total: 'Lifetime' }

function requireKey(store: GatewayStore, id: string): ApiKeyRecord {
  const key = store.getKey(id)
  if (!key) throw new Error(`Unknown key "${id}". Run \`antseed gateway key list\` to see key ids.`)
  return key
}

async function uniqueIdentityName(dataDir: string, base: string): Promise<string> {
  if (!await loadBuyerIdentity(dataDir, base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, 28)}-${suffix}`
    if (!await loadBuyerIdentity(dataDir, candidate)) return candidate
  }
}

function keyJson(store: GatewayStore, key: ApiKeyRecord) {
  const spent = store.periodSpend(key.id)
  const usage = store.usageStats(key.id)
  return {
    id: key.id,
    label: key.label,
    hint: key.hint,
    identity: key.buyerIdentity,
    status: key.status,
    source: key.source,
    topupEnabled: key.topupEnabled,
    limitsUsd: Object.fromEntries(LIMIT_PERIODS.map((period) => [period, optionalUsdcToDecimalString(key.limits[period])])),
    spentUsd: Object.fromEntries(LIMIT_PERIODS.map((period) => [period, usdcToDecimalString(spent[period])])),
    requests: usage.requests,
    failedRequests: usage.failedRequests,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    createdAt: new Date(key.createdAt).toISOString(),
    expiresAt: key.expiresAt === null ? null : new Date(key.expiresAt).toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : new Date(key.lastUsedAt).toISOString(),
  }
}

export function registerGatewayKeyCommands(gateway: Command): void {
  const key = gateway.command('key').description('Create and manage gateway API keys')

  addLimitOptions(
    key.command('create')
      .description('Create an API key; the secret is shown only once')
      .requiredOption('--label <name>', 'who or what the key is for')
      .option('--identity <name>', 'buyer identity that pays for this key (default: the default identity)')
      .option('--new-identity [name]', 'create a dedicated buyer identity and wallet for this key')
      .option('--expires-in-days <days>', 'expire the key after this many days', parsePositiveInteger)
      .option('--allow-topup', 'let the key holder fund the key\'s wallet with x402 (needs its own identity)', false)
      .option('--json', 'print machine-readable JSON', false),
    false,
  ).action(async (options: Record<string, unknown>) => {
    const { store, dataDir } = openGatewayStore(key)
    try {
      const label = String(options['label']).trim()
      if (!label) throw new Error('--label cannot be empty.')
      if (options['identity'] && options['newIdentity']) throw new Error('Use either --identity or --new-identity, not both.')
      let identityName = typeof options['identity'] === 'string' ? options['identity'] : DEFAULT_BUYER_IDENTITY
      let createdIdentity = false
      if (options['newIdentity']) {
        const requested = typeof options['newIdentity'] === 'string'
          ? options['newIdentity']
          : await uniqueIdentityName(dataDir, slugifyIdentityName(label))
        identityName = (await createBuyerIdentity(dataDir, requested)).name
        createdIdentity = true
      } else if (identityName !== DEFAULT_BUYER_IDENTITY && !await loadBuyerIdentity(dataDir, identityName)) {
        throw new Error(`Unknown buyer identity "${identityName}". Create it with \`antseed buyer identity create ${identityName}\` or use --new-identity.`)
      }
      const topupEnabled = options['allowTopup'] === true
      if (topupEnabled && identityName === DEFAULT_BUYER_IDENTITY) {
        throw new Error('--allow-topup needs a key with its own wallet; add --new-identity or --identity <name>.')
      }
      const limits: SpendLimits = { daily: null, monthly: null, total: null, ...parseLimitOptions(options) }
      const days = options['expiresInDays'] as number | undefined
      const { key: record, secret } = store.createKey({
        label,
        buyerIdentity: identityName,
        limits,
        topupEnabled,
        expiresAt: days ? Date.now() + days * DAY_MS : null,
      })
      const address = await buyerIdentityAddress(dataDir, identityName)

      if (options['json']) {
        console.log(JSON.stringify({ ...keyJson(store, record), apiKey: secret, identityAddress: address }))
        return
      }
      console.log(chalk.green(`Created key ${record.id} (${record.label})`))
      console.log(`${chalk.bold('API key:')} ${secret}`)
      console.log(chalk.yellow('Store it now; it cannot be shown again.'))
      console.log(`Identity: ${identityName}${address ? ` (${address})` : ''}`)
      console.log(`Limits: ${describeLimits(record)}`)
      if (record.topupEnabled) console.log('Top-ups: enabled (POST /v1/key/topup)')
      if (record.expiresAt !== null) console.log(`Expires: ${new Date(record.expiresAt).toISOString()}`)
      if (createdIdentity) {
        console.log('')
        console.log(chalk.dim('This key has its own buyer wallet. Fund it by sending USDC on Base to the address above;'))
        console.log(chalk.dim('a running buyer deposits it into the identity\'s credits automatically. As a QR code:'))
        console.log(chalk.dim(`  antseed --data-dir ${buyerIdentityDir(dataDir, identityName)} buyer deposit --no-watch`))
      }
    } finally {
      store.close()
    }
  })

  key.command('list')
    .description('List API keys with their spend and limits')
    .option('--all', 'include revoked keys', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { all: boolean; json: boolean }) => {
      const { store } = openGatewayStore(key)
      try {
        const keys = store.listKeys().filter((record) => options.all || record.status === 'active')
        if (options.json) {
          console.log(JSON.stringify(keys.map((record) => keyJson(store, record))))
          return
        }
        if (keys.length === 0) {
          console.log(chalk.dim('No API keys. Create one with `antseed gateway key create --label <name>`.'))
          return
        }
        const table = new Table({ head: ['Id', 'Label', 'Identity', 'Status', 'Today', 'Month', 'Total', 'Limits', 'Last used'] })
        for (const record of keys) {
          const spent = store.periodSpend(record.id)
          table.push([
            record.id,
            record.label,
            record.buyerIdentity,
            keyStatusLabel(record),
            formatUsdc(spent.daily),
            formatUsdc(spent.monthly),
            formatUsdc(spent.total),
            describeLimits(record),
            record.lastUsedAt === null ? '-' : new Date(record.lastUsedAt).toISOString().replace('T', ' ').slice(0, 16),
          ])
        }
        console.log(table.toString())
      } finally {
        store.close()
      }
    })

  key.command('show')
    .description('Show usage and limits for one key')
    .argument('<id>', 'key id')
    .option('--json', 'print machine-readable JSON', false)
    .action(async (id: string, options: { json: boolean }) => {
      const { store, dataDir } = openGatewayStore(key)
      try {
        const record = requireKey(store, id)
        if (options.json) {
          console.log(JSON.stringify(keyJson(store, record)))
          return
        }
        const spent = store.periodSpend(record.id)
        const today = store.usageStats(record.id, periodStart('daily', Date.now()))
        const total = store.usageStats(record.id)
        const address = await buyerIdentityAddress(dataDir, record.buyerIdentity)
        console.log(`${chalk.bold(record.label)} ${chalk.dim(record.id)}  ${keyStatusLabel(record)}`)
        console.log(`Key: ${record.hint}`)
        console.log(`Identity: ${record.buyerIdentity}${address ? ` (${address})` : ''}`)
        console.log(`Top-ups: ${record.topupEnabled ? 'enabled' : 'disabled'}`)
        for (const period of LIMIT_PERIODS) {
          const limit = record.limits[period]
          console.log(`${PERIOD_SPEND_LABELS[period]}: ${formatUsdc(spent[period])}${limit === null ? '' : ` of ${formatUsdc(limit)}`}`)
        }
        console.log(`Requests: ${total.requests} (${total.failedRequests} failed), ${today.requests} today`)
        console.log(`Tokens: ${total.inputTokens} in (${total.cachedInputTokens} cached), ${total.outputTokens} out`)
        if (record.expiresAt !== null) console.log(`Expires: ${new Date(record.expiresAt).toISOString()}`)
      } finally {
        store.close()
      }
    })

  addLimitOptions(
    key.command('limits')
      .description('Change the spend caps of a key')
      .argument('<id>', 'key id'),
    true,
  ).action((id: string, options: Record<string, unknown>) => {
    const { store } = openGatewayStore(key)
    try {
      requireKey(store, id)
      const limits = parseLimitOptions(options)
      if (Object.keys(limits).length === 0) throw new Error('Pass at least one of --daily-limit, --monthly-limit or --total-limit.')
      const record = store.setLimits(id, limits)
      console.log(`Limits for ${record.id}: ${describeLimits(record)}`)
    } finally {
      store.close()
    }
  })

  key.command('topup')
    .description('Allow or stop x402 top-ups of a key\'s wallet by the key holder')
    .argument('<id>', 'key id')
    .argument('<state>', 'on or off')
    .action((id: string, state: string) => {
      const { store } = openGatewayStore(key)
      try {
        const normalized = state.trim().toLowerCase()
        if (normalized !== 'on' && normalized !== 'off') throw new Error('State must be "on" or "off".')
        const record = requireKey(store, id)
        if (normalized === 'on' && record.buyerIdentity === DEFAULT_BUYER_IDENTITY) {
          throw new Error('This key pays from the default wallet; only keys with their own identity can be topped up.')
        }
        store.setTopupEnabled(id, normalized === 'on')
        console.log(`Top-ups for ${record.id} (${record.label}): ${normalized === 'on' ? 'enabled' : 'disabled'}.`)
      } finally {
        store.close()
      }
    })

  key.command('revoke')
    .description('Revoke a key immediately')
    .argument('<id>', 'key id')
    .action((id: string) => {
      const { store } = openGatewayStore(key)
      try {
        const record = store.revokeKey(id)
        console.log(`Revoked ${record.id} (${record.label}).`)
        if (record.source === 'tunnel-env') {
          console.log(chalk.yellow('This key comes from ANTSEED_TUNNEL_API_KEY and is re-activated if the tunnel starts with it again.'))
        }
      } finally {
        store.close()
      }
    })
}
