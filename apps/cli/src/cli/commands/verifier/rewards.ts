import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { formatUnits, getAddress } from 'ethers'
import { VERIFICATION_REWARDS_OFF } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import { createVerifierClient } from '../../payment-utils.js'
import { resolveAuditorAddress, resolveAuditorSigner } from './auditor-identity.js'
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
    .description('Show KBF auditor rewards (paid in proportion to audit credits) and optionally claim them from the verification results contract')
    .requiredOption('--epochs <list>', 'comma-separated epochs or ranges, e.g. 12,14-16')
    .option('--claim', 'claim the pending rewards for the listed epochs')
    .option('--yes', 'claim without an interactive confirmation prompt')
    .option('--auditor <address>', 'show rewards for this auditor address instead of verifier.auditor (read-only)')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options: RewardsOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const epochs = parseEpochList(options.epochs)
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      if (options.claim && options.auditor) throw new Error('--claim signs as your own auditor; drop --auditor')
      const signer = options.claim
        ? await resolveAuditorSigner({ config: config.verifier, dataDir: globalOptions.dataDir })
        : null
      const auditor = signer?.address ?? (await resolveAuditorAddress({
        config: config.verifier, dataDir: globalOptions.dataDir, flag: options.auditor,
      })).address

      const resultsAddress = await verifierClient.resultsAddress()
      const kbf = getAddress(verifierClient.contractAddress)
      const settings = await verifierClient.rewardSettings()
      const pending = await Promise.all(epochs.map(async (epoch) => {
        const [amount, credits] = await Promise.all([
          verifierClient.pendingAuditorReward(auditor, epoch),
          verifierClient.auditCredits(auditor, epoch),
        ])
        return { epoch, amount, credits }
      }))
      const table = new Table({ head: ['Epoch', 'Credits', 'Share of credits', 'Pending ANTS'] })
      for (const entry of pending) {
        table.push([
          entry.epoch.toString(),
          `${entry.credits.auditor} / ${entry.credits.total}`,
          formatShare(entry.credits.auditor, entry.credits.total),
          formatUnits(entry.amount, ANTS_DECIMALS),
        ])
      }
      const total = pending.reduce((sum, entry) => sum + entry.amount, 0n)
      console.log(table.toString())
      console.log(`Auditor: ${auditor}`)
      console.log(`Audit: KBF audits ${kbf}`)
      console.log(`Verification results: ${resultsAddress}`)
      console.log(`Total pending: ${formatUnits(total, ANTS_DECIMALS)} ANTS`)
      console.log(describeRewardSettings(settings))
      if (!options.claim) return

      const claimable = pending.filter((entry) => entry.amount > 0n).map((entry) => entry.epoch)
      if (claimable.length === 0) {
        console.log(chalk.dim('Nothing to claim.'))
        return
      }
      if (!options.yes) await confirmClaim(claimable.length, formatUnits(total, ANTS_DECIMALS))
      // The results contract claims one epoch per transaction.
      const transactionHashes = await verifierClient.claimAuditorRewards(signer!.wallet, claimable)
      console.log(chalk.green(
        `Claimed KBF auditor rewards for epoch(s) ${claimable.join(', ')} from ${resultsAddress} `
        + `(audit ${kbf}) (${transactionHashes.join(', ')})`,
      ))
    })
}

/** One line on KBF's reward settings: whether audits earn credits yet, its share, and the per-auditor cap. */
export function describeRewardSettings(settings: { rewardsStartEpoch: bigint; shareBps: number; maxAuditorShareBps: number }): string {
  const start = settings.rewardsStartEpoch === VERIFICATION_REWARDS_OFF
    ? 'KBF rewards are off: audits earn no credits yet'
    : `audits earn credits from epoch ${settings.rewardsStartEpoch}`
  return `Rewards: ${start}; KBF share ${settings.shareBps / 100}% of the verification bucket (latest setting), `
    + `at most ${settings.maxAuditorShareBps / 100}% of it per auditor and epoch; anything above goes to the emissions reserve.`
}

function formatShare(part: bigint, total: bigint): string {
  if (total === 0n) return '-'
  return `${(Number((part * 10_000n) / total) / 100).toFixed(2)}%`
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
