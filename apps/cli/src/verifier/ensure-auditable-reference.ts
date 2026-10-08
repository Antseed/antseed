import { join } from 'node:path'
import type { VerifierCLIConfig } from '../config/types.js'
import { acquirePidFileLock } from './atomic-files.js'
import { buildModelReference } from './model-reference.js'
import { loadConfiguredVerifierModelCatalog } from './openrouter-catalog.js'
import {
  appendModelReferenceToBank,
  inspectModelProbeBankPower,
  loadBankEnrollmentReference,
} from './probe-bank.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'

const dependencies = {
  inspect: inspectModelProbeBankPower,
  loadSeed: loadBankEnrollmentReference,
  catalog: loadConfiguredVerifierModelCatalog,
  build: buildModelReference,
  append: appendModelReferenceToBank,
}

export async function ensureAuditableReference(input: {
  model: string
  banksDir: string
  referencesDir: string
  config: VerifierCLIConfig | undefined
  maxRequests: number
  buyerProxyPort?: number
  log?: (message: string) => void
}, operations: typeof dependencies = dependencies): Promise<void> {
  if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0) {
    throw new Error('enrollment requires an explicit positive integer request budget')
  }
  const lock = await acquirePidFileLock(join(input.banksDir, safeServiceSlug(input.model), '.enrollment.lock'))
  try {
    const status = await operations.inspect(input)
    if (status.selectedProbeCount !== null) {
      input.log?.(`bank ready: ${status.selectedProbeCount}/${status.totalProbeCount} probes; no enrollment calls needed`)
      return
    }
    const initialReference = await operations.loadSeed(input.banksDir, input.model)
    const configuredModel = input.config?.referenceEndpoint?.models[input.model]
    const config = structuredClone(input.config)
    if (!config?.referenceEndpoint || !configuredModel || configuredModel.enabled === false) {
      throw new Error(`no enabled reference configuration for ${input.model}`)
    }
    if (initialReference) {
      config.referenceEndpoint.models[input.model]!.contrastModels = initialReference.contrasts.map((entry) => entry.model)
    }
    config.referenceMaxRequestsPerBuild = Math.min(
      input.maxRequests, config.referenceMaxRequestsPerBuild ?? input.maxRequests,
    )
    const sizing = resolveReferenceSizingPolicy(config)
    input.log?.(
      `enrollment required: ${status.totalProbeCount} banked; maximum ${sizing.maximumProbeCount} probes, `
      + `${config.referenceMaxRequestsPerBuild} physical requests per model (including retries and checkpoint history)`,
    )
    const catalog = await operations.catalog(config)
    const built = await operations.build({
      model: input.model,
      referencesDir: input.referencesDir,
      config,
      catalog,
      buyerProxyPort: input.buyerProxyPort,
      initialReference,
      log: input.log,
    })
    const appended = await operations.append({
      banksDir: input.banksDir, model: input.model, reference: built.reference, cost: built.cost,
    })
    input.log?.(`enrolled +${appended.addedProbeCount} probes; ${appended.totalProbeCount} banked`)
    const refreshed = await operations.inspect({ ...input, config })
    if (refreshed.selectedProbeCount === null) {
      throw new Error(`bank still fails audit readiness after enrollment; no seller audit started for ${input.model}`)
    }
    await built.finalize()
    input.log?.(`bank ready after enrollment: ${refreshed.selectedProbeCount} probes`)
  } finally {
    await lock.release()
  }
}
