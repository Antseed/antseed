import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { AdminTokenRecord } from '../../../gateway/store.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { createAdminToken, DEFAULT_TOKEN_DAYS, MAX_TOKEN_DAYS, revokeAdminToken } from '../../../gateway/services/tokens.js'
import { isoOrNull, openGatewayStore, printJson, withGateway } from './shared.js'

const DAY_MS = 24 * 60 * 60 * 1000

function tokenJson(token: AdminTokenRecord) {
  return {
    id: token.id,
    label: token.label,
    hint: token.hint,
    scope: token.scope,
    createdBy: token.createdBy,
    expiresAt: isoOrNull(token.expiresAt),
    createdAt: isoOrNull(token.createdAt),
    lastUsedAt: isoOrNull(token.lastUsedAt),
  }
}

export function registerGatewayAdminTokenCommands(gateway: Command): void {
  const adminToken = gateway.command('admin-token')
    .description('Management tokens for the console API (/console/api, Authorization: Bearer)')

  adminToken.command('create')
    .description('Create a management token; the secret is shown only once')
    .requiredOption('--label <name>', 'what the token is for')
    .option('--scope <scope>', 'read (GET only) or admin (full organization admin)', 'read')
    .option('--expires-in-days <days>', `days until the token stops working (default ${DEFAULT_TOKEN_DAYS}, at most ${MAX_TOKEN_DAYS})`, parsePositiveInteger)
    .option('--no-expiry', 'a token that never expires (prefer an expiry and rotate it)')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { label: string; scope: string; expiresInDays?: number; expiry: boolean; json: boolean }, cmd: Command) => withGateway(cmd, ({ ctx, actor }) => {
      const label = options.label.trim()
      if (!label) throw new Error('--label cannot be empty.')
      const scope = options.scope.trim().toLowerCase()
      if (scope !== 'read' && scope !== 'admin') throw new Error('--scope must be read or admin.')
      if (!options.expiry && options.expiresInDays !== undefined) throw new Error('Use either --expires-in-days or --no-expiry.')
      const days = options.expiresInDays ?? DEFAULT_TOKEN_DAYS
      if (days > MAX_TOKEN_DAYS) throw new Error(`--expires-in-days can be at most ${MAX_TOKEN_DAYS}.`)
      const expiresAt = options.expiry ? Date.now() + days * DAY_MS : null
      const { token, secret } = createAdminToken(ctx, actor, { label, scope, createdBy: null, expiresAt })
      if (options.json) {
        printJson({ ...tokenJson(token), token: secret })
        return
      }
      console.log(chalk.green(`Created ${scope} management token ${token.id} (${token.label})`))
      console.log(`${chalk.bold('Token:')} ${secret}`)
      console.log(chalk.yellow('Store it now; it cannot be shown again.'))
      console.log(token.expiresAt === null ? chalk.yellow('It never expires; revoke it when it is no longer needed.') : `Expires: ${new Date(token.expiresAt).toISOString()}`)
      console.log(chalk.dim('Use it as `Authorization: Bearer <token>` on /console/api/*.'))
    }))

  adminToken.command('list')
    .description('List active management tokens')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }) => {
      const { store } = openGatewayStore(adminToken)
      try {
        const tokens = store.listAdminTokens()
        if (options.json) {
          printJson(tokens.map(tokenJson))
          return
        }
        if (tokens.length === 0) {
          console.log(chalk.dim('No management tokens. Create one with `antseed gateway admin-token create --label <name>`.'))
          return
        }
        const table = new Table({ head: ['Id', 'Label', 'Token', 'Scope', 'Created', 'Expires', 'Last used'] })
        for (const token of tokens) {
          table.push([
            token.id,
            token.label,
            token.hint,
            token.scope,
            new Date(token.createdAt).toISOString().slice(0, 10),
            token.expiresAt === null ? 'never' : `${new Date(token.expiresAt).toISOString().slice(0, 10)}${token.expiresAt <= Date.now() ? ' (expired)' : ''}`,
            token.lastUsedAt === null ? '-' : new Date(token.lastUsedAt).toISOString().replace('T', ' ').slice(0, 16),
          ])
        }
        console.log(table.toString())
      } finally {
        store.close()
      }
    })

  adminToken.command('revoke')
    .description('Revoke a management token immediately')
    .argument('<id>', 'token id')
    .action((id: string, _options: unknown, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      if (!store.getAdminToken(id)) throw new Error(`Unknown token "${id}". Run \`antseed gateway admin-token list\` to see token ids.`)
      const { token, revoked } = revokeAdminToken(ctx, actor, id)
      console.log(revoked ? `Revoked ${token.id} (${token.label}).` : `${token.id} (${token.label}) was already revoked.`)
    }))
}
