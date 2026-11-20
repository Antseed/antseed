import type { Command } from 'commander'
import { registerVerifierAssignmentCommand } from './assignment.js'
import { registerVerifierCheckCommand } from './check.js'
import { registerVerifierLogsCommand, startVerifierCommandLog } from './logs.js'
import { registerVerifierModelsCommand } from './models.js'
import { registerVerifierOverviewCommand } from './overview.js'
import { registerVerifierProfileCommand } from './profile.js'
import { registerVerifierRewardsCommand } from './rewards.js'
import { registerVerifierRunCommand } from './run.js'
import { registerVerifierStatusCommand } from './status.js'
import { registerVerifierSubmitCommand } from './submit.js'
import { registerVerifierWatchCommand } from './watch.js'

export function registerVerifierCommands(program: Command): void {
  const verifier = program
    .command('verifier')
    .description('Run KBF model audits (one of the first of many Antseed verification methods), submit them, claim auditor rewards, manage your auditor profile, and check other endpoints')
  verifier.hook('preAction', (_command, actionCommand) => startVerifierCommandLog(program, actionCommand))
  registerVerifierRunCommand(verifier)
  registerVerifierAssignmentCommand(verifier)
  registerVerifierModelsCommand(verifier)
  registerVerifierStatusCommand(verifier)
  registerVerifierOverviewCommand(verifier)
  registerVerifierSubmitCommand(verifier)
  registerVerifierWatchCommand(verifier)
  registerVerifierRewardsCommand(verifier)
  registerVerifierProfileCommand(verifier)
  registerVerifierCheckCommand(verifier)
  registerVerifierLogsCommand(verifier)
}
