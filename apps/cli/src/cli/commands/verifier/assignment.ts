import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { assignAuditModelsRoundRobin, auditModelListHash } from '../../../verifier/audit-assignment.js'
import { resolveAuditEpochWindow, type AuditEpochWindow } from '../../../verifier/audit-epoch.js'
import { configuredVerifierModels } from '../../../verifier/model-config.js'
import { getGlobalOptions } from '../types.js'
import { approvedAuditorsAt, loadAuditorSetEvents } from '../../../verifier/auditor-set.js'
import { createVerifierClient } from '../../payment-utils.js'
import { auditEpochReader } from './run.js'

interface AssignmentOptions {
  epoch?: string
  epochs?: string
  json?: boolean
}

/** The window of `epoch`, assuming the same epoch length as `current`. */
export function shiftEpochWindow(current: AuditEpochWindow, epoch: bigint): AuditEpochWindow {
  const duration = current.endsAt - current.startedAt
  const offset = Number(epoch - BigInt(current.epoch))
  const startedAt = current.startedAt + offset * duration
  return { epoch: epoch.toString(), startedAt, endsAt: startedAt + duration, source: current.source }
}

export function registerVerifierAssignmentCommand(verifier: Command): void {
  verifier
    .command('assignment')
    .description('Show which models each approved auditor audits this epoch (round robin; every model is audited every epoch)')
    .option('--epoch <n>', 'first epoch to show (default: the current on-chain epoch)')
    .option('--epochs <count>', 'number of epochs to show', '1')
    .option('--json', 'print the assignment as JSON')
    .action(async (options: AssignmentOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const resolved = await resolveAuditEpochWindow(() => auditEpochReader(config))
      if (resolved.window.source !== 'onchain') throw new Error(resolved.warning ?? 'the on-chain epoch is unavailable')
      const count = Number(options.epochs)
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('--epochs must be an integer from 1 to 100')
      if (options.epoch !== undefined && !/^\d+$/.test(options.epoch.trim())) throw new Error('--epoch must be a non-negative integer')
      const first = options.epoch === undefined ? BigInt(resolved.window.epoch) : BigInt(options.epoch.trim())
      const availableModels = configuredVerifierModels(config.verifier)
      const events = await loadAuditorSetEvents(
        createVerifierClient(config), globalOptions.dataDir, (message) => console.error(chalk.dim(message)),
      )
      const epochs = Array.from({ length: count }, (_, index) => {
        const window = shiftEpochWindow(resolved.window, first + BigInt(index))
        // Epochs after the current one use today's auditors: later approvals are not known yet.
        const auditors = approvedAuditorsAt(events, Math.min(window.startedAt, resolved.window.startedAt))
        return {
          epoch: window.epoch,
          startedAt: new Date(window.startedAt * 1_000).toISOString(),
          auditors: auditors.length === 0
            ? []
            : assignAuditModelsRoundRobin({ auditors, epoch: window.epoch, availableModels })
              .map((entry) => ({ auditor: entry.auditor, models: entry.models })),
        }
      })
      if (options.json) {
        console.log(JSON.stringify({
          strategy: 'round-robin',
          modelListHash: auditModelListHash(availableModels),
          models: availableModels,
          epochs,
        }, null, 2))
        return
      }
      console.log(chalk.dim(
        `Round robin: every model is audited every epoch, split across the approved auditors. ${availableModels.length} models, `
        + `model list ${auditModelListHash(availableModels).slice(0, 10)} (auditors on another CLI version may differ).`,
      ))
      for (const entry of epochs) {
        console.log(`\nEpoch ${entry.epoch}${entry.epoch === resolved.window.epoch ? ' (current)' : ''}, started ${entry.startedAt}`)
        if (entry.auditors.length === 0) {
          console.log(chalk.yellow('  no approved auditors'))
          continue
        }
        const table = new Table({ head: ['Auditor', 'Models'] })
        for (const row of entry.auditors) table.push([row.auditor, row.models.join('\n') || chalk.dim('none')])
        console.log(table.toString())
      }
    })
}
