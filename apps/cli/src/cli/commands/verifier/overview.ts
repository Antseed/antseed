import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { loadConfig } from '../../../config/loader.js'
import { readVerifierStatus } from '../../../verifier/audit-artifacts.js'
import { writeEpochOverview } from '../../../verifier/epoch-overview.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierOverviewCommand(verifier: Command): void {
  verifier
    .command('overview')
    .description('Write the seller × model overview page for an epoch from all of its local runs')
    .option('--epoch <n>', 'epoch to show (default: the latest run\'s epoch)')
    .option('--run <ids...>', 'only these runs (run ids or prefixes), merged oldest first')
    .action(async (options: { epoch?: string; run?: string[] }, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const epoch = options.epoch ?? (await readVerifierStatus(evidenceDir))?.epoch
      if (!epoch) throw new Error('no verifier run found; pass --epoch')
      const path = await writeEpochOverview(evidenceDir, String(epoch), options.run)
      if (!path) {
        console.log(chalk.dim(`No completed runs for epoch ${epoch}.`))
        return
      }
      console.log(`Epoch overview: ${path}`)
    })
}
