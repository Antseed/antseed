import { join } from 'node:path'
import chalk from 'chalk'
import type { KbfModel } from '@antseed/node/payments'
import type { AntseedConfig } from '../../config/types.js'
import { buildModelReference } from '../model-reference.js'
import { loadConfiguredVerifierModelCatalog } from '../openrouter-catalog.js'
import type { EpochBankV1 } from './types.js'

/** Builds a fresh KBF reference for every audited model, skipping probes used in recent banks. */
export async function buildEpochBank(input: {
  config: AntseedConfig
  epoch: bigint
  models: KbfModel[]
  excludedProbeIds: ReadonlySet<string>
  referencesDir: string
  buyerPort: number
  log: (message: string) => void
}): Promise<EpochBankV1> {
  const catalog = await loadConfiguredVerifierModelCatalog(input.config.verifier)
  const bank: EpochBankV1 = { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: input.epoch.toString(), models: {} }
  for (const model of input.models) {
    try {
      const built = await buildModelReference({
        model: model.service,
        referencesDir: join(input.referencesDir, input.epoch.toString()),
        config: input.config.verifier,
        catalog,
        buyerProxyPort: input.buyerPort,
        excludedProbeIds: input.excludedProbeIds,
        log: (message) => input.log(`[bank:${model.service}] ${message}`),
      })
      await built.finalize()
      bank.models[model.service] = built.reference
    } catch (error) {
      input.log(chalk.yellow(`[bank:${model.service}] skipped: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  if (Object.keys(bank.models).length === 0) throw new Error(`no model reference could be built for epoch ${input.epoch}`)
  return bank
}
