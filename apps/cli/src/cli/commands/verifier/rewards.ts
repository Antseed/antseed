import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { formatUnits, getAddress } from 'ethers'
import { loadConfig } from '../../../config/loader.js'
import { createVerifierClient, loadCryptoContext } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface RewardsOptions {
  epochs: string
  claim?: boolean
  yes?: boolean
  auditor?: string
  rpcUrl?: string
}

/** Emission rewards are ANTS, an 18-decimal ERC-20. */
const ANTS_DECIMALS = 18

export function parseEpochList(value: string): bigint[] {
  const epochs = new Set<bigint>()
  for (const part of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) {
      const start = BigInt(range[1]!)
      const end = BigInt(range[2]!)
      if (end < start || end - start > 1_000n) throw new Error(`invalid epoch range: ${part}`)
      for (let epoch = start; epoch <= end; epoch += 1n) epochs.add(epoch)
      continue
    }
    if (!/^\d+$/.test(part)) throw new Error(`invalid epoch: ${part}`)
    epochs.add(BigInt(part))
  }
  if (epochs.size === 0) throw new Error('--epochs requires at least one epoch')
  return [...epochs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

export function registerVerifierRewardsCommand(verifierCmd: Command): void {
  verifierCmd
    .command('rewards')
    .description('Show pending auditor rewards and optionally claim them')
    .requiredOption('--epochs <list>', 'comma-separated epochs or ranges, e.g. 12,14-16')
    .option('--claim', 'claim the pending rewards for the listed epochs')
    .option('--yes', 'claim without an interactive confirmation prompt')
    .option('--auditor <address>', 'show rewards for another auditor address (read-only)')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options: RewardsOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const epochs = parseEpochList(options.epochs)
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      const { wallet, address } = await loadCryptoContext(globalOptions.dataDir)
      const auditor = options.auditor ? getAddress(options.auditor) : address
      if (options.claim && auditor !== address) throw new Error('--claim cannot be combined with another --auditor')

      const pending = await Promise.all(epochs.map(async (epoch) => ({
        epoch,
        amount: await verifierClient.pendingAuditorReward(auditor, epoch),
      })))
      const table = new Table({ head: ['Epoch', 'Pending ANTS'] })
      for (const entry of pending) table.push([entry.epoch.toString(), formatUnits(entry.amount, ANTS_DECIMALS)])
      const total = pending.reduce((sum, entry) => sum + entry.amount, 0n)
      console.log(table.toString())
      console.log(`Auditor: ${auditor}`)
      console.log(`Total pending: ${formatUnits(total, ANTS_DECIMALS)} ANTS`)
      if (!options.claim) return

      const claimable = pending.filter((entry) => entry.amount > 0n).map((entry) => entry.epoch)
      if (claimable.length === 0) {
        console.log(chalk.dim('Nothing to claim.'))
        return
      }
      if (!options.yes) await confirmClaim(claimable.length, formatUnits(total, ANTS_DECIMALS))
      const transactionHash = await verifierClient.claimAuditorRewards(wallet, claimable)
      console.log(chalk.green(`Claimed auditor rewards for epoch(s) ${claimable.join(', ')} (${transactionHash})`))
    })
}

async function confirmClaim(epochCount: number, total: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('refusing non-interactive claim without --yes')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Claim ${total} ANTS across ${epochCount} epoch(s)? [y/N] `)
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) throw new Error('claim cancelled')
  } finally {
    prompt.close()
  }
}
