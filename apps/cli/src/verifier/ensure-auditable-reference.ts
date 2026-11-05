import { join } from 'node:path'
import type { VerifierCLIConfig } from '../config/types.js'
import { acquirePidFileLock } from './atomic-files.js'
import { findVerifierModel } from './model-config.js'
import { buildModelReference, type ReferenceRequestLimiter } from './model-reference.js'
import { loadConfiguredVerifierModelCatalog } from './openrouter-catalog.js'
import {
  appendModelReferenceToBank,
  inspectModelProbeBankPower,
  loadBankEnrollmentReference,
  loadBankProbeIndex,
  recordEpochQuestionPool,
  selectEpochQuestionSet,
  type EpochQuestionSetV1,
} from './probe-bank.js'
import { safeServiceSlug } from './slug.js'

const dependencies = {
  loadSeed: loadBankEnrollmentReference,
  loadIndex: loadBankProbeIndex,
  catalog: loadConfiguredVerifierModelCatalog,
  build: buildModelReference,
  append: appendModelReferenceToBank,
}

/** Pins a model's contrast models in a cloned config, so enrollment keeps the bank's contrasts. */
export function withContrastModels(config: VerifierCLIConfig, service: string, contrastModels: string[]): void {
  const models = config.models ?? {}
  const key = Object.keys(models).find((name) => findVerifierModel(config, name)?.[0] === service) ?? service
  config.models = { ...models, [key]: { ...models[key], contrastModels: [...contrastModels] } }
}

/** Runs' budgets one build may spend in total when `verifier.referenceMaxRequestsPerBuild` is not set. */
export const BUILD_REQUEST_RUNS = 3

/**
 * A run's `maxRequests` is what each build may spend in that run; an unfinished build continues from
 * its checkpoint in the next run with another budget, up to its total: the configured
 * `referenceMaxRequestsPerBuild`, or `BUILD_REQUEST_RUNS` runs' budgets.
 */
export function buildRequestLimits(maxRequests: number, configuredTotal: number | undefined): { perRun: number; total: number } {
  const total = configuredTotal ?? maxRequests * BUILD_REQUEST_RUNS
  return { perRun: Math.min(maxRequests, total), total }
}

/**
 * Builds a brand-new reference (fresh questions) and appends it to the bank, keeping the bank's
 * contrast models. Returns the ids of the questions it added.
 */
export async function enrollFreshProbes(input: {
  model: string
  banksDir: string
  referencesDir: string
  config: VerifierCLIConfig | undefined
  maxRequests: number
  buyerProxyPort?: number
  requestLimiter?: ReferenceRequestLimiter
  log?: (message: string) => void
}, operations: typeof dependencies = dependencies): Promise<{ addedProbeCount: number; addedProbeIds: string[]; costUsdMicros: string }> {
  if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0) {
    throw new Error('enrollment requires an explicit positive integer request budget')
  }
  const lock = await acquirePidFileLock(join(input.banksDir, safeServiceSlug(input.model), '.enrollment.lock'))
  try {
    const bank = await operations.loadIndex(input.banksDir, input.model)
    // The bank's request settings (thinking suppression etc.), so the fresh probes are measured
    // like the banked ones and the bank accepts them.
    const settingsReference = bank ? await operations.loadSeed(input.banksDir, input.model) : undefined
    const config = structuredClone(input.config)
    const entry = findVerifierModel(config, input.model)
    if (!config?.referenceEndpoint || !entry) {
      throw new Error(`no reference configuration for ${input.model}`)
    }
    if (bank) withContrastModels(config, entry[0], bank.contrastModels)
    const limits = buildRequestLimits(input.maxRequests, config.referenceMaxRequestsPerBuild)
    config.referenceMaxRequestsPerBuild = limits.total
    input.log?.(
      `generating fresh probes: up to ${limits.perRun} physical requests in this run, ${limits.total} for the whole build`,
    )
    const catalog = await operations.catalog(config)
    const built = await operations.build({
      model: input.model,
      referencesDir: input.referencesDir,
      config,
      catalog,
      buyerProxyPort: input.buyerProxyPort,
      ...(input.requestLimiter ? { requestLimiter: input.requestLimiter } : {}),
      log: input.log,
      excludedProbeIds: new Set(bank?.probeIds ?? []),
      ...(settingsReference ? { settingsReference } : {}),
      maxNewRequests: limits.perRun,
    })
    const appended = await operations.append({
      banksDir: input.banksDir, model: input.model, reference: built.reference, cost: built.cost,
      answeredContrastModelsByProbeId: built.answeredContrastModelsByProbeId,
      exchanges: built.exchanges,
    })
    await built.finalize()
    input.log?.(
      `enrolled +${appended.addedProbeCount} fresh probes; ${appended.totalProbeCount} banked, `
      + `$${(Number(built.cost.totalUsdMicros) / 1_000_000).toFixed(6)}`,
    )
    return { addedProbeCount: appended.addedProbeCount, addedProbeIds: appended.addedProbeIds, costUsdMicros: built.cost.totalUsdMicros }
  } finally {
    await lock.release()
  }
}

/** Fresh-question builds per model and run, at most, to complete an epoch's question set. */
export const EPOCH_SET_BUILD_ROUNDS = 4

/**
 * This epoch's question set for a model (`epochs/<epoch>/set.json`), built on the spot when there is
 * none yet: fresh questions are built and added to the bank (up to `EPOCH_SET_BUILD_ROUNDS` builds
 * per run, recorded so an interrupted run's builds still count) until they make an audit set and
 * `extensionCount` extra sets. Only questions built for this epoch can be in it. Throws when the
 * builds don't get there; the model is then not audited in this run.
 */
export async function ensureEpochQuestionSet(input: {
  model: string
  banksDir: string
  referencesDir: string
  config: VerifierCLIConfig | undefined
  maxRequests: number
  epoch: string
  runId: string
  extensionCount: number
  buyerProxyPort?: number
  requestLimiter?: ReferenceRequestLimiter
  log?: (message: string) => void
}, operations: {
  inspect: typeof inspectModelProbeBankPower
  select: typeof selectEpochQuestionSet
  enrollFresh: typeof enrollFreshProbes
  record: typeof recordEpochQuestionPool
} = {
  inspect: inspectModelProbeBankPower, select: selectEpochQuestionSet, enrollFresh: enrollFreshProbes, record: recordEpochQuestionPool,
}): Promise<EpochQuestionSetV1> {
  if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0) {
    throw new Error('enrollment requires an explicit positive integer request budget')
  }
  const select = () => operations.select({
    banksDir: input.banksDir, model: input.model, epoch: input.epoch, runId: input.runId,
    extensionCount: input.extensionCount, config: input.config,
  })
  // A model without a bank has nothing to select from yet: its first build makes the bank.
  let selection = await operations.inspect({ banksDir: input.banksDir, model: input.model, config: input.config })
    .then((status) => status.totalProbeCount === 0 ? null : select())
  if (selection?.status === 'ready') {
    input.log?.(`question set for epoch ${input.epoch} ready: ${describeSet(selection.set)}`)
    return selection.set
  }
  for (let round = 1; round <= EPOCH_SET_BUILD_ROUNDS; round += 1) {
    input.log?.(
      `building new questions for the epoch ${input.epoch} question set (build ${round}/${EPOCH_SET_BUILD_ROUNDS}`
      + `${selection ? `; ${selection.reason}` : ''})`,
    )
    const enrolled = await operations.enrollFresh({
      model: input.model, banksDir: input.banksDir, referencesDir: input.referencesDir, config: input.config,
      maxRequests: input.maxRequests, buyerProxyPort: input.buyerProxyPort,
      ...(input.requestLimiter ? { requestLimiter: input.requestLimiter } : {}),
      ...(input.log ? { log: input.log } : {}),
    })
    await operations.record({ banksDir: input.banksDir, model: input.model, epoch: input.epoch, probeIds: enrolled.addedProbeIds })
    selection = await select()
    if (selection.status === 'ready') {
      input.log?.(`question set for epoch ${input.epoch} ready: ${describeSet(selection.set)}`)
      return selection.set
    }
    if (enrolled.addedProbeCount === 0) break
  }
  throw new Error(`no question set for epoch ${input.epoch}: ${selection?.reason ?? 'the build added no questions'}`)
}

function describeSet(set: EpochQuestionSetV1): string {
  return `${set.reference.probes.length} questions and ${set.extensions.length} extra set(s) of as many, `
    + `from ${set.candidateProbeCount} new questions (${set.previouslyAskedProbeCount} left out as asked before)`
}
