import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { provisionManagedIdentity } from '../../../gateway/identities.js'
import { DEFAULT_IDENTITY_ID, type GatewayIdentity } from '../../../gateway/store.js'
import { openGatewayStore } from './shared.js'

function runByLabel(identity: GatewayIdentity, activeIdentities: ReadonlySet<string>): string {
  if (identity.id === DEFAULT_IDENTITY_ID) return 'you (buyer start / desktop)'
  if (activeIdentities.has(identity.id)) return 'gateway'
  return chalk.dim('idle')
}

export function registerGatewayIdentityCommands(gateway: Command): void {
  const identity = gateway.command('identity').description('Buyer identities (wallets) that pay for gateway keys')

  identity.command('create')
    .description('Create a buyer identity with its own wallet, data dir and buyer port')
    .argument('<id>', 'identity name (lowercase letters, digits, dashes)')
    .action(async (id: string) => {
      const { store, dataDir } = openGatewayStore(identity)
      try {
        const created = await provisionManagedIdentity(store, dataDir, id)
        console.log(chalk.green(`Created identity ${created.id}`))
        console.log(`Wallet: ${created.address}`)
        console.log(`Data dir: ${created.dataDir}`)
        console.log(`Buyer port: ${created.buyerPort}`)
        console.log(chalk.dim('Attach keys with `antseed gateway key create --identity ' + created.id + '`.'))
        console.log(chalk.dim(`Fund it: antseed --data-dir ${created.dataDir} buyer deposit --no-watch`))
      } finally {
        store.close()
      }
    })

  identity.command('list')
    .description('List buyer identities')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }) => {
      const { store } = openGatewayStore(identity)
      try {
        const identities = store.listIdentities()
        const active = store.identitiesWithActiveKeys()
        const keyCounts = new Map<string, number>()
        for (const key of store.listKeys()) {
          if (key.status === 'active') keyCounts.set(key.identityId, (keyCounts.get(key.identityId) ?? 0) + 1)
        }
        if (options.json) {
          console.log(JSON.stringify(identities.map((entry) => ({ ...entry, activeKeys: keyCounts.get(entry.id) ?? 0 }))))
          return
        }
        const table = new Table({ head: ['Id', 'Wallet', 'Buyer port', 'Run by', 'Active keys'] })
        for (const entry of identities) {
          table.push([
            entry.id,
            entry.address ?? chalk.dim('unknown'),
            entry.buyerPort ?? chalk.dim('config'),
            runByLabel(entry, active),
            keyCounts.get(entry.id) ?? 0,
          ])
        }
        console.log(table.toString())
      } finally {
        store.close()
      }
    })

  identity.command('remove')
    .description('Remove an identity that never backed a key (its wallet files stay on disk)')
    .argument('<id>', 'identity name')
    .action((id: string) => {
      const { store } = openGatewayStore(identity)
      try {
        const existing = store.getIdentity(id)
        store.removeIdentity(id)
        console.log(`Removed identity ${id}.`)
        if (existing) console.log(chalk.dim(`Its wallet is still at ${existing.dataDir}/identity.key.`))
      } finally {
        store.close()
      }
    })
}
