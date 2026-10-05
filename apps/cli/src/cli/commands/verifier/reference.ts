import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { loadConfig } from '../../../config/loader.js'
import { writeJsonAtomic } from '../../../verifier/atomic-files.js'
import { resolveVerifierCommandModels, resolveVerifierModelConfig } from '../../../verifier/model-config.js'
import { buildModelReference, createReferenceRequestLimiter } from '../../../verifier/model-reference.js'
import { loadConfiguredVerifierModelCatalog } from '../../../verifier/openrouter-catalog.js'
import { asError } from '../../../verifier/utils.js'
import {
  appendModelReferenceToBank,
  inspectModelProbeBankPower,
  type ProbeBankPowerStatus,
} from '../../../verifier/probe-bank.js'
import { getGlobalOptions } from '../types.js'
import {
  formatReferenceBuildPlan,
  ReferenceBuildProgress,
  type ReferenceProgressPlan,
} from './reference-progress.js'

export function registerVerifierReferenceCommand(verifier: Command): void {
  const reference = verifier.command('reference').description('Manage powered model references')
  reference
    .command('build [model]')
    .description('Build and append references for one configured model or every underpowered model')
    .option('--all', 'build references for enabled models without a reusable powered bank')
    .action(async (modelValue: string | undefined, options: { all?: boolean }, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const models = resolveVerifierCommandModels(config.verifier, modelValue, options.all === true)
      const referencesDir = config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'verifier', 'references')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const catalog = await loadConfiguredVerifierModelCatalog(config.verifier)
      const startedAt = new Date().toISOString()
      const plans: ReferenceProgressPlan[] = await Promise.all(models.map(async (model) => {
        try {
          const selected = resolveVerifierModelConfig(config.verifier, model, catalog)
          const bankStatus = await inspectModelProbeBankPower({ banksDir, model, config: config.verifier })
          const skipReason = referenceBuildSkipReason(options.all === true, bankStatus)
          return {
            model,
            contrastModels: selected.contrastModels,
            bankedProbeCount: bankStatus?.totalProbeCount,
            skipReason,
          }
        } catch (error) {
          return { model, contrastModels: [], configurationError: asError(error).message }
        }
      }))
      console.log(chalk.bold('Reference build plan:'))
      for (const line of formatReferenceBuildPlan(plans)) console.log(chalk.dim(line))
      const progress = new ReferenceBuildProgress(plans)
      const requestLimiter = createReferenceRequestLimiter(config.verifier)
      progress.start()
      type ReferenceBuildResult = {
        model: string
        status: 'BUILT' | 'FAILED' | 'SKIPPED'
        referenceId?: string
        referencePath?: string
        bankPath?: string
        addedProbeCount?: number
        canonicalConflictProbeCount?: number
        totalProbeCount?: number
        contrastModels?: string[]
        costUsdMicros?: string
        reason?: string
      }

      const results: ReferenceBuildResult[] = await Promise.all(plans.map(async (plan) => {
        const { model } = plan
        try {
          if (plan.configurationError) throw new Error(plan.configurationError)
          if (plan.skipReason) {
            const result: ReferenceBuildResult = {
              model,
              status: 'SKIPPED',
              totalProbeCount: plan.bankedProbeCount,
              contrastModels: [...plan.contrastModels],
              reason: plan.skipReason,
            }
            progress.complete(model, `skipped: ${plan.skipReason}`)
            if (!progress.interactive) console.log(chalk.cyan(`Skipped ${model}: ${plan.skipReason}`))
            return result
          }
          const built = await buildModelReference({
            model,
            referencesDir,
            config: config.verifier,
            catalog,
            buyerProxyPort: config.buyer.proxyPort,
            requestLimiter,
            log: (message) => {
              if (progress.interactive) progress.update(model, message)
              else console.log(chalk.dim(`[reference:${model}] ${message}`))
            },
          })
          const appended = await appendModelReferenceToBank({
            banksDir,
            model,
            reference: built.reference,
            cost: built.cost,
          })
          await built.finalize()
          const result: ReferenceBuildResult = {
            model,
            status: 'BUILT',
            referenceId: built.reference.referenceId,
            referencePath: built.path,
            bankPath: appended.path,
            addedProbeCount: appended.addedProbeCount,
            canonicalConflictProbeCount: appended.canonicalConflictProbeCount,
            totalProbeCount: appended.totalProbeCount,
            contrastModels: built.reference.contrasts.map((contrast) => contrast.model),
            costUsdMicros: built.cost.totalUsdMicros,
          }
          const conflictSuffix = appended.canonicalConflictProbeCount > 0
            ? `, discarded ${appended.canonicalConflictProbeCount} conflicting canonical variants`
            : ''
          const successMessage = chalk.green(
            `Built ${model}: +${appended.addedProbeCount} probes (${appended.totalProbeCount} banked)${conflictSuffix}, `
            + `$${(Number(built.cost.totalUsdMicros) / 1_000_000).toFixed(6)}`,
          )
          progress.complete(
            model,
            `built: +${appended.addedProbeCount} probes (${appended.totalProbeCount} banked)${conflictSuffix}, `
            + `$${(Number(built.cost.totalUsdMicros) / 1_000_000).toFixed(6)}`,
          )
          if (!progress.interactive) console.log(successMessage)
          return result
        } catch (error) {
          const reason = asError(error).message
          const failureMessage = chalk.yellow(`FAILED ${model}: ${reason}`)
          progress.complete(model, `failed: ${reason}`)
          if (!progress.interactive) console.warn(failureMessage)
          return { model, status: 'FAILED', reason }
        }
      }))
      progress.finish()

      const completedAt = new Date().toISOString()
      const summary = {
        version: 1,
        kind: 'antseed-verifier-reference-build-summary',
        buildId: canonicalHashBytes32({
          domain: 'antseed-verifier-reference-build-v1', models, startedAt, completedAt,
        }),
        startedAt,
        completedAt,
        results,
      }
      const summaryPath = join(banksDir, 'reference-build-summary.json')
      await writeJsonAtomic(summaryPath, summary)
      console.log(chalk.dim(`Summary: ${summaryPath}`))
      if (results.some((result) => result.status === 'FAILED')) process.exitCode = 1
    })
}

export function referenceBuildSkipReason(
  all: boolean,
  bankStatus: ProbeBankPowerStatus | undefined,
): string | undefined {
  if (!all || bankStatus?.selectedProbeCount === null || bankStatus?.selectedProbeCount === undefined
    || bankStatus.statisticalPower === null) return undefined
  return `powered bank available: ${bankStatus.selectedProbeCount}/${bankStatus.totalProbeCount} probes, `
    + `power ${bankStatus.statisticalPower.toFixed(3)}`
}
