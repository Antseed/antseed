import type { Command } from 'commander'
import { registerVerifierReferenceCommand } from './reference.js'
import { registerVerifierReportCommand } from './report.js'
import { registerVerifierRewardsCommand } from './rewards.js'
import { registerVerifierRunCommand } from './run.js'
import { registerVerifierStatusCommand } from './status.js'
import { registerVerifierSubmitCommand } from './submit.js'

export function registerVerifierCommands(program: Command): void {
  const verifier = program
    .command('verifier')
    .description('Run buyer-proxy model verification, sign audit reports, and submit verified reports')
  registerVerifierRunCommand(verifier)
  registerVerifierReferenceCommand(verifier)
  registerVerifierStatusCommand(verifier)
  registerVerifierReportCommand(verifier)
  registerVerifierSubmitCommand(verifier)
  registerVerifierRewardsCommand(verifier)
}
