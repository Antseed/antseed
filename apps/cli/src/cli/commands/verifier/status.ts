import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { loadConfig } from '../../../config/loader.js'
import { readVerifierStatus } from '../../../verifier/audit-artifacts.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierStatusCommand(verifier: Command): void {
  verifier
    .command('status')
    .description('Show the latest verifier run status')
    .option('--json', 'print the status as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const status = await readVerifierStatus(evidenceDir)
      if (!status) {
        if (options.json) console.log(JSON.stringify({ status: 'not-started' }))
        else console.log(chalk.dim('No verifier run status exists yet.'))
        return
      }
      if (options.json) {
        console.log(JSON.stringify(status, null, 2))
        return
      }
      console.log(chalk.bold(`${status.state.toUpperCase()} — epoch ${status.epoch}`))
      console.log(`Run: ${status.runId}`)
      console.log(`Progress: ${status.modelsCompleted}/${status.modelsTotal} models, ${status.auditsCompleted} audits`)
      console.log(`Active audits: ${status.activeAudits.length}; queued: ${status.queuedAudits}`)
      console.log(`Skipped: ${status.skipped ?? 0}`)
      console.log(`Failures: ${status.failures}`)
      console.log(
        `Estimated cost: $${status.cost.estimatedCostUsd.toFixed(6)} `
        + `(${status.cost.totalTokens} tokens, ${status.cost.missingCostExchangeCount} unpriced exchanges)`,
      )
      for (const audit of status.activeAudits) {
        console.log(`Active: ${audit.model} on ${audit.peerId}`)
      }
      console.log(`Message: ${status.message}`)
    })
}
