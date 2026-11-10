import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import type { AuditorSetEvent } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import { assignAuditModelsRoundRobin, auditModelListHash, confirmationAssignments } from '../../../verifier/audit-assignment.js'
import { resolveAuditEpochWindow, type AuditEpochWindow } from '../../../verifier/audit-epoch.js'
import { configuredVerifierModels } from '../../../verifier/model-config.js'
import { getGlobalOptions } from '../types.js'
import { approvedAuditorsAt, loadAuditorSetEvents, revokedSinceEpochStart } from '../../../verifier/auditor-set.js'
import { createVerifierClient, useVerifierEventCache } from '../../payment-utils.js'
import { auditEpochReader } from './run.js'
import { auditHandovers, loadEpochModelAudits, type AuditHandover } from '../../../verifier/audit-handover.js'
import { chainNow } from '../../../verifier/chain-clock.js'

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

/**
 * The auditors in `window`'s rotation: the ones approved when it starts. For an epoch that has not
 * started yet that is everyone approved so far, including auditors approved during the current
 * epoch, and it is only a preview: an approval or removal before the epoch starts still changes it.
 */
export function epochAuditors(
  events: readonly AuditorSetEvent[],
  window: AuditEpochWindow,
  current: AuditEpochWindow,
): { auditors: string[]; preview: boolean } {
  return { auditors: approvedAuditorsAt(events, window.startedAt), preview: BigInt(window.epoch) > BigInt(current.epoch) }
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
      useVerifierEventCache(globalOptions.dataDir)
      const config = await loadConfig(globalOptions.config)
      const resolved = await resolveAuditEpochWindow(() => auditEpochReader(config))
      if (resolved.window.source !== 'onchain') throw new Error(resolved.warning ?? 'the on-chain epoch is unavailable')
      const count = Number(options.epochs)
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('--epochs must be an integer from 1 to 100')
      if (options.epoch !== undefined && !/^\d+$/.test(options.epoch.trim())) throw new Error('--epoch must be a non-negative integer')
      const first = options.epoch === undefined ? BigInt(resolved.window.epoch) : BigInt(options.epoch.trim())
      const availableModels = configuredVerifierModels(config.verifier)
      const client = createVerifierClient(config)
      const events = await loadAuditorSetEvents(client, globalOptions.dataDir, (message) => console.error(chalk.dim(message)))
      // Stand-ins exist only in the current epoch: they follow this epoch's audits and how far it has come.
      const [now, audits] = await Promise.all([
        chainNow(client.provider),
        loadEpochModelAudits({
          reader: client,
          epoch: resolved.window.epoch,
          epochStartedAt: resolved.window.startedAt,
          deploymentBlock: client.deploymentBlock,
        }),
      ])
      const epochs = Array.from({ length: count }, (_, index) => {
        const window = shiftEpochWindow(resolved.window, first + BigInt(index))
        const { auditors, preview } = epochAuditors(events, window, resolved.window)
        const handovers: AuditHandover[] = auditors.length === 0 || window.epoch !== resolved.window.epoch
          ? []
          : auditHandovers({
            auditors,
            epoch: window.epoch,
            availableModels,
            audits,
            revoked: revokedSinceEpochStart(events, window.startedAt),
            epochStartedAt: window.startedAt,
            epochEndsAt: window.endsAt,
            now,
          })
        return {
          epoch: window.epoch,
          startedAt: new Date(window.startedAt * 1_000).toISOString(),
          preview,
          auditors: auditors.length === 0
            ? []
            : (() => {
              const confirms = confirmationAssignments({ auditors, epoch: window.epoch, availableModels })
              return assignAuditModelsRoundRobin({ auditors, epoch: window.epoch, availableModels })
                .map((entry) => ({
                  auditor: entry.auditor,
                  models: entry.models,
                  confirms: confirms.get(entry.auditor) ?? [],
                  standsInFor: handovers.filter((handover) => handover.standIn === entry.auditor),
                }))
            })(),
          handovers,
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
        + `model list ${auditModelListHash(availableModels).slice(0, 10)} (auditors on another CLI version may differ). `
        + 'A DIFF needs a second auditor: each model\'s confirmer (the next auditor in the rotation) audits the sellers whose DIFF waits for it. '
        + 'A model its auditor has not audited by halfway through the epoch goes to the next active auditor in the rotation (stand-in).',
      ))
      for (const entry of epochs) {
        console.log(entry.preview
          ? `\nEpoch ${entry.epoch}, starts ${entry.startedAt} (preview: the auditors approved so far; an approval or removal before it starts changes it)`
          : `\nEpoch ${entry.epoch}${entry.epoch === resolved.window.epoch ? ' (current)' : ''}, started ${entry.startedAt}`)
        if (entry.auditors.length === 0) {
          console.log(chalk.yellow('  no approved auditors'))
          continue
        }
        const current = entry.epoch === resolved.window.epoch
        const table = new Table({ head: ['Auditor', 'Audits', 'Confirms DIFFs on', ...(current ? ['Stands in for'] : [])] })
        for (const row of entry.auditors) {
          table.push([
            row.auditor,
            row.models.join('\n') || chalk.dim('none'),
            row.confirms.join('\n') || chalk.dim('none'),
            ...(current
              ? [row.standsInFor.map((handover) => `${handover.model} (for ${handover.assignedAuditor.slice(0, 10)}…)`).join('\n') || chalk.dim('none')]
              : []),
          ])
        }
        console.log(table.toString())
      }
    })
}
