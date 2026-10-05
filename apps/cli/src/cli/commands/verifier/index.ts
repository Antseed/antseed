import type { Command } from 'commander'
import { registerVerifierReferenceCommand } from './reference.js'
import { registerVerifierRunCommand } from './run.js'
import { registerVerifierStatusCommand } from './status.js'
import { registerVerifierSubmitCommand } from './submit.js'

export function registerVerifierCommands(program: Command): void {
  const verifier = program
    .command('verifier')
    .description('Run buyer-proxy model verification and manage verifier references')
  registerVerifierRunCommand(verifier)
  registerVerifierReferenceCommand(verifier)
  registerVerifierStatusCommand(verifier)
  registerVerifierSubmitCommand(verifier)
}
