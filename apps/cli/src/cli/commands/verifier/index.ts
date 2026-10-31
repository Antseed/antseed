import type { Command } from 'commander'
import { registerVerifierCheckCommand } from './check.js'
import { registerVerifierPublishCommand } from './publish.js'
import { registerVerifierStartCommand } from './start.js'
import { registerVerifierModelsCommand } from './models.js'
import { registerVerifierOverviewCommand } from './overview.js'
import { registerVerifierReferenceCommand } from './reference.js'
import { registerVerifierRunCommand } from './run.js'
import { registerVerifierStatusCommand } from './status.js'

export function registerVerifierCommands(program: Command): void {
  const verifier = program
    .command('verifier')
    .description('Run a KBF verifier (one of the first of many Antseed verification methods), publish rounds, audit locally, and check other endpoints')
  registerVerifierStartCommand(verifier)
  registerVerifierPublishCommand(verifier)
  registerVerifierRunCommand(verifier)
  registerVerifierModelsCommand(verifier)
  registerVerifierReferenceCommand(verifier)
  registerVerifierStatusCommand(verifier)
  registerVerifierOverviewCommand(verifier)
  registerVerifierCheckCommand(verifier)
}
