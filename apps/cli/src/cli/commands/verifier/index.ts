import type { Command } from 'commander'
import { registerVerifierAssignmentCommand } from './assignment.js'
import { registerVerifierCheckCommand } from './check.js'
import { registerVerifierModelsCommand } from './models.js'
import { registerVerifierOverviewCommand } from './overview.js'
import { registerVerifierReferenceCommand } from './reference.js'
import { registerVerifierRewardsCommand } from './rewards.js'
import { registerVerifierRunCommand } from './run.js'
import { registerVerifierStatusCommand } from './status.js'
import { registerVerifierSubmitCommand } from './submit.js'

export function registerVerifierCommands(program: Command): void {
  const verifier = program
    .command('verifier')
    .description('Run buyer-proxy model verification, submit audits, claim auditor rewards, and check other endpoints')
  registerVerifierRunCommand(verifier)
  registerVerifierAssignmentCommand(verifier)
  registerVerifierModelsCommand(verifier)
  registerVerifierReferenceCommand(verifier)
  registerVerifierStatusCommand(verifier)
  registerVerifierOverviewCommand(verifier)
  registerVerifierSubmitCommand(verifier)
  registerVerifierRewardsCommand(verifier)
  registerVerifierCheckCommand(verifier)
}
