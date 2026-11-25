import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import type { VerifierCLIConfig } from '../../../config/types.js'
import { loadConfig } from '../../../config/loader.js'
import {
  auditedVerifierModels,
  builtInReferenceProvider,
  configuredContrastModels,
  type VerifierContrastSource,
} from '../../../verifier/model-config.js'
import { getGlobalOptions } from '../types.js'

export interface VerifierModelSource {
  model: string
  aliases: string[]
  /** Where the genuine answers come from: `referenceEndpoint` (default) or a named upstream. */
  source: string
  sourceType: string
  /** Model id sent to that source. */
  sourceModel: string
  providerPin: string[] | null
  /** True when `providerPin` is the built-in default rather than the verifier's own setting. */
  providerPinBuiltIn: boolean
  /** Look-alikes a new bank is built against; empty when they are picked automatically at build time. */
  contrastModels: string[]
  contrastSource: VerifierContrastSource
}

/** Where each built-in audited model takes its genuine answers from, after the verifier's settings. */
export function describeVerifierModelSources(config: VerifierCLIConfig | undefined): VerifierModelSource[] {
  return auditedVerifierModels(config).map(([model, settings]) => {
    const upstream = settings.upstream ? config?.upstreams?.[settings.upstream.name] : undefined
    const route = settings.referenceRoute
    const builtIn = builtInReferenceProvider(config, model, settings)
    const contrasts = configuredContrastModels(config, model, settings)
    const source = route
      ? { source: `referenceRoute`, sourceType: 'antseed', sourceModel: route.service }
      : settings.upstream
        ? { source: settings.upstream.name, sourceType: upstream?.type ?? 'missing', sourceModel: settings.upstream.model ?? settings.upstreamModel }
        : { source: 'referenceEndpoint', sourceType: 'default', sourceModel: settings.upstreamModel }
    return {
      model,
      aliases: settings.serviceAliases ?? [],
      ...source,
      providerPin: settings.referenceProvider?.order ?? builtIn?.order ?? null,
      providerPinBuiltIn: !settings.referenceProvider && builtIn !== undefined,
      contrastModels: contrasts?.models ?? [],
      contrastSource: contrasts?.source ?? 'automatic',
    }
  })
}

export function registerVerifierModelsCommand(verifier: Command): void {
  verifier
    .command('models')
    .description('List the built-in audited models, where each takes its genuine answers from, and the look-alike models its new banks are built against')
    .option('--json', 'print the list as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const config = await loadConfig(getGlobalOptions(command).config)
      const rows = describeVerifierModelSources(config.verifier)
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      const endpoint = config.verifier?.referenceEndpoint
      console.log(endpoint
        ? chalk.dim(`Default reference: referenceEndpoint ${endpoint.baseUrl} (${endpoint.sourceId})`)
        : chalk.yellow('verifier.referenceEndpoint is not configured; reference builds will fail'))
      const table = new Table({ head: ['Model', 'Reference from', 'Model id there', 'Provider pin', 'Contrast models'] })
      for (const row of rows) {
        table.push([
          row.aliases.length ? `${row.model}\n${chalk.dim(row.aliases.join(', '))}` : row.model,
          row.sourceType === 'default' ? 'referenceEndpoint' : `${row.source} (${row.sourceType})`,
          row.sourceModel,
          row.providerPin ? `${row.providerPin.join(', ')}${row.providerPinBuiltIn ? chalk.dim(' (built-in)') : ''}` : '',
          row.contrastModels.length
            ? `${row.contrastModels.join('\n')}\n${chalk.dim(`(${row.contrastSource})`)}`
            : chalk.dim('automatic, picked when a bank is built'),
        ])
      }
      console.log(table.toString())
      console.log(chalk.dim('A bank keeps the contrast models it was built with; these apply to new banks.'))
    })
}
