import { InvalidArgumentError, type Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import {
  assertNewIdentityPassphrase,
  DEFAULT_BUYER_IDENTITY,
  DepositsClient,
  FileIdentityStore,
  MIN_PASSPHRASE_LENGTH,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  resolveChainConfig,
} from '@antseed/node'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import {
  archiveBuyerIdentity,
  createBuyerIdentity,
  listBuyerIdentities,
  parseKeySource,
  readDefaultWallet,
  storedWalletKeys,
} from '../../../buyer-identities/store.js'
import { anyKeyEncrypted, walletPassphrase, type PassphrasePrompt } from '../../wallet-passphrase.js'

function formatUsdc(baseUnits: bigint): string {
  return (Number(baseUnits) / 1_000_000).toFixed(2)
}

async function walletKeysFor(dataDir: string, name: string | undefined, all: boolean): ReturnType<typeof storedWalletKeys> {
  if (all && name) throw new Error('Pass an identity name or --all, not both.')
  const keys = await storedWalletKeys(dataDir, all ? undefined : (name ?? DEFAULT_BUYER_IDENTITY))
  if (keys.length === 0) throw new Error(`No wallet keys are stored in ${dataDir}.`)
  return keys
}

/** `prompt` replaces the terminal prompt for the passphrase, for tests. */
export function registerBuyerIdentityCommands(buyerCmd: Command, prompt?: PassphrasePrompt): void {
  const identity = buyerCmd
    .command('identity')
    .description('Extra buyer wallets one running buyer can pay as (select per request with x-antseed-buyer-identity)')

  identity.command('create')
    .description('Create a buyer identity with its own wallet')
    .argument('<name>', 'identity name (lowercase letters, digits, dashes)')
    .option('--key-from <source>', 'read an existing private key from env:<VAR> or file:<absolute path> on every load, instead of storing one in the data dir', (value: string) => {
      try {
        return parseKeySource(value)
      } catch (err) {
        throw new InvalidArgumentError((err as Error).message)
      }
    })
    .action(async (name: string, options: { keyFrom?: string }) => {
      const { dataDir } = getGlobalOptions(buyerCmd)
      const created = await createBuyerIdentity(dataDir, name, options.keyFrom)
      console.log(chalk.green(`Created buyer identity ${created.name}`))
      console.log(`Wallet: ${created.address}`)
      if (created.keyFrom) {
        console.log(chalk.dim(`Key: read from ${created.keyFrom}; it is not stored in the data dir. The buyer must be started with it available.`))
      } else {
        console.log(chalk.dim(`Key: ${created.dir}/identity.key — back it up; the wallet holds this identity's credits.`))
      }
      console.log('')
      console.log('Fund it by sending USDC on Base to the wallet. A running buyer deposits it into the')
      console.log("identity's credits automatically.")
      if (!created.keyFrom) {
        console.log('To show the address as a QR code:')
        console.log(chalk.dim(`  antseed --data-dir ${created.dir} buyer deposit --no-watch`))
      }
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
      const encrypted = async (dir: string): Promise<boolean> => (await new FileIdentityStore(dir).format().catch(() => null)) === 'encrypted'
      const rows: Array<{ name: string; address: string | null; keyFrom?: string; encrypted?: boolean; error?: string; available?: string; reserved?: string }> = [
        { name: DEFAULT_BUYER_IDENTITY, address: defaultWallet.address, encrypted: await encrypted(globalOpts.dataDir) },
        ...await Promise.all(stored.map(async (entry) => ({
          name: entry.name,
          address: entry.address,
          ...(entry.keyFrom ? { keyFrom: entry.keyFrom } : { encrypted: await encrypted(entry.dir) }),
          ...(entry.error ? { error: entry.error } : {}),
        }))),
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
      const table = new Table({ head: ['Name', 'Wallet', 'Key', ...(options.balances ? ['Available', 'Reserved'] : [])] })
      for (const row of rows) {
        table.push([
          row.name,
          row.address ?? (row.error ? chalk.yellow(row.error) : chalk.dim(defaultWallet.note)),
          row.keyFrom ?? (row.encrypted ? 'data dir, encrypted' : 'data dir'),
          ...(options.balances ? [row.available ?? '-', row.reserved ?? '-'] : []),
        ])
      }
      console.log(table.toString())
    })

  identity.command('protect')
    .description(`Encrypt stored wallet keys with the passphrase in ${PASSPHRASE_ENV} (or the first line of ${PASSPHRASE_FILE_ENV}), asked on the terminal when neither is set; at least ${MIN_PASSPHRASE_LENGTH} characters`)
    .argument('[name]', `identity to protect (default: ${DEFAULT_BUYER_IDENTITY})`)
    .option('--all', 'every wallet key in the data dir, archived ones included', false)
    .action(async (name: string | undefined, options: { all: boolean }) => {
      const { dataDir } = getGlobalOptions(buyerCmd)
      const keys = await walletKeysFor(dataDir, name, options.all)
      const passphrase = await walletPassphrase({ confirm: true, ...(prompt ? { prompt } : {}) })
      if (!passphrase) {
        throw new Error(`Set ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV} to the passphrase that should protect the keys.`)
      }
      assertNewIdentityPassphrase(passphrase)
      for (const key of keys) {
        const changed = await key.store.protect()
        console.log(changed ? chalk.green(`Encrypted ${key.name}`) : chalk.dim(`${key.name} is already encrypted`))
      }
      console.log(chalk.dim(`Every process that uses these wallets (buyer, gateway) now needs ${PASSPHRASE_ENV} or ${PASSPHRASE_FILE_ENV}, or asks for the passphrase when started on a terminal. Keep the passphrase safe: without it the keys cannot be recovered.`))
    })

  identity.command('unprotect')
    .description('Store encrypted wallet keys as plaintext again')
    .argument('[name]', `identity to decrypt (default: ${DEFAULT_BUYER_IDENTITY})`)
    .option('--all', 'every wallet key in the data dir, archived ones included', false)
    .option('--yes', 'confirm writing the private keys to disk unencrypted', false)
    .action(async (name: string | undefined, options: { all: boolean; yes: boolean }) => {
      const { dataDir } = getGlobalOptions(buyerCmd)
      if (!options.yes) throw new Error('This writes the private keys to disk unencrypted; pass --yes to confirm.')
      const keys = await walletKeysFor(dataDir, name, options.all)
      if (await anyKeyEncrypted(keys)) await walletPassphrase(prompt ? { prompt } : {})
      for (const key of keys) {
        const changed = await key.store.unprotect()
        console.log(changed ? chalk.yellow(`Decrypted ${key.name}`) : chalk.dim(`${key.name} is not encrypted`))
      }
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
