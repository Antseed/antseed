import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { DEFAULT_BUYER_IDENTITY, DepositsClient, resolveChainConfig } from '@antseed/node'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { archiveBuyerIdentity, createBuyerIdentity, listBuyerIdentities, readDefaultWallet } from '../../../buyer-identities/store.js'

function formatUsdc(baseUnits: bigint): string {
  return (Number(baseUnits) / 1_000_000).toFixed(2)
}

export function registerBuyerIdentityCommands(buyerCmd: Command): void {
  const identity = buyerCmd
    .command('identity')
    .description('Extra buyer wallets one running buyer can pay as (select per request with x-antseed-buyer-identity)')

  identity.command('create')
    .description('Create a buyer identity with its own wallet')
    .argument('<name>', 'identity name (lowercase letters, digits, dashes)')
    .action(async (name: string) => {
      const { dataDir } = getGlobalOptions(buyerCmd)
      const created = await createBuyerIdentity(dataDir, name)
      console.log(chalk.green(`Created buyer identity ${created.name}`))
      console.log(`Wallet: ${created.address}`)
      console.log(chalk.dim(`Key: ${created.dir}/identity.key — back it up; the wallet holds this identity's credits.`))
      console.log('')
      console.log('Fund it by sending USDC on Base to the wallet. A running buyer deposits it into the')
      console.log("identity's credits automatically. To show the address as a QR code:")
      console.log(chalk.dim(`  antseed --data-dir ${created.dir} buyer deposit --no-watch`))
      console.log('')
      console.log(`Use it by sending ${chalk.bold(`x-antseed-buyer-identity: ${created.name}`)} with requests to the buyer.`)
    })

  identity.command('list')
    .description('List buyer identities')
    .option('--balances', 'read each wallet\'s deposits balance from the chain', false)
    .option('--json', 'print machine-readable JSON', false)
    .action(async (options: { balances: boolean; json: boolean }) => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const stored = await listBuyerIdentities(globalOpts.dataDir)
      const defaultWallet = await readDefaultWallet(globalOpts.dataDir)
      const rows: Array<{ name: string; address: string | null; available?: string; reserved?: string }> = [
        { name: DEFAULT_BUYER_IDENTITY, address: defaultWallet.address },
        ...stored.map((entry) => ({ name: entry.name, address: entry.address })),
      ]

      if (options.balances) {
        const config = await loadConfig(globalOpts.config)
        const crypto = config.payments?.crypto
        const chainConfig = resolveChainConfig({
          chainId: crypto?.chainId,
          rpcUrl: crypto?.rpcUrl,
          depositsContractAddress: crypto?.depositsContractAddress,
          usdcContractAddress: crypto?.usdcContractAddress,
        })
        const deposits = new DepositsClient({
          rpcUrl: chainConfig.rpcUrl,
          ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
          contractAddress: chainConfig.depositsContractAddress,
          usdcAddress: chainConfig.usdcContractAddress,
          evmChainId: chainConfig.evmChainId,
        })
        await Promise.all(rows.map(async (row) => {
          if (!row.address) return
          const account = await deposits.getBuyerBalance(row.address).catch(() => null)
          if (!account) return
          row.available = formatUsdc(account.available)
          row.reserved = formatUsdc(account.reserved)
        }))
      }

      if (options.json) {
        console.log(JSON.stringify(rows))
        return
      }
      const table = new Table({ head: ['Name', 'Wallet', ...(options.balances ? ['Available', 'Reserved'] : [])] })
      for (const row of rows) {
        table.push([
          row.name,
          row.address ?? chalk.dim(defaultWallet.note),
          ...(options.balances ? [row.available ?? '-', row.reserved ?? '-'] : []),
        ])
      }
      console.log(table.toString())
    })

  identity.command('remove')
    .description('Stop using a buyer identity; its key is archived, not deleted')
    .argument('<name>', 'identity name')
    .action(async (name: string) => {
      const { dataDir } = getGlobalOptions(buyerCmd)
      const archived = await archiveBuyerIdentity(dataDir, name)
      console.log(`Removed buyer identity ${name}. Its key was moved to ${archived}.`)
      console.log(chalk.dim('A running buyer keeps it until restart. Withdraw remaining credits with that key if needed.'))
    })
}
