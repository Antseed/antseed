import { join } from 'node:path'
import { KBF_CALIBRATION_PASSES } from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { acquirePidFileLock } from './atomic-files.js'
import { findVerifierModel } from './model-config.js'
import { buildModelReference, calibrateReferenceSets, type ReferenceRequestLimiter } from './model-reference.js'
import { loadConfiguredVerifierModelCatalog } from './openrouter-catalog.js'
import {
  appendModelReferenceToBank,
  epochQuestionSetPath,
  epochSetCalibrationProblem,
  inspectModelProbeBankPower,
  loadBankEnrollmentReference,
  loadBankProbeIndex,
  loadEpochQuestionSet,
  recordEpochQuestionPool,
  recordEpochSetCalibration,
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

/**
 * Measures this epoch's set on the batches sellers will get, once: the audit set and each extra set
 * get `KBF_CALIBRATION_PASSES` passes against the pinned reference, and their limit comes from these
 * trials. A set that has a calibration is returned as it is; one without gets it here, and an
 * interrupted calibration continues from its checkpoint, so nothing is paid for twice. Throws when
 * the reference fails the sanity gates: the model is not audited this epoch.
 */
export async function calibrateEpochQuestionSet(input: {
  model: string
  banksDir: string
  config: VerifierCLIConfig | undefined
  maxRequests: number
  epoch: string
  set: EpochQuestionSetV1
  buyerProxyPort?: number
  requestLimiter?: ReferenceRequestLimiter
  fetchFn?: typeof fetch
  log?: (message: string) => void
  now?: () => number
}, operations: {
  catalog: typeof loadConfiguredVerifierModelCatalog
  ask: typeof calibrateReferenceSets
  record: typeof recordEpochSetCalibration
} = { catalog: loadConfiguredVerifierModelCatalog, ask: calibrateReferenceSets, record: recordEpochSetCalibration }): Promise<EpochQuestionSetV1> {
  const stopped = (set: EpochQuestionSetV1): EpochQuestionSetV1 => {
    const problem = set.calibration?.status === 'failed' ? epochSetCalibrationProblem(set) : null
    if (problem) throw new Error(`the ${input.model} question set for epoch ${input.epoch} ${problem}; not audited this epoch`)
    return set
  }
  if (input.set.calibration) return stopped(input.set)
  const setPath = epochQuestionSetPath(input.banksDir, input.model, input.epoch)
  const lock = await acquirePidFileLock(`${setPath}.calibration.lock`)
  try {
    const set = await loadEpochQuestionSet(input) ?? input.set
    if (set.calibration) return stopped(set)
    const references = [set.reference, ...set.extensions]
    const config = structuredClone(input.config)
    const entry = findVerifierModel(config, input.model)
    if (!config?.referenceEndpoint || !entry) throw new Error(`no reference configuration for ${input.model}`)
    withContrastModels(config, entry[0], set.reference.contrasts.map((contrast) => contrast.model))
    const limits = buildRequestLimits(input.maxRequests, config.referenceMaxRequestsPerBuild)
    input.log?.(`calibrating ${references.length} question set(s) on their own batches (${KBF_CALIBRATION_PASSES} pass(es))`)
    const asked = await operations.ask({
      model: input.model,
      references,
      passes: KBF_CALIBRATION_PASSES,
      checkpointPath: `${setPath}.calibration.json`,
      exchangesPath: `${setPath}.calibration.exchanges.json`,
      config,
      catalog: await operations.catalog(config),
      maxNewRequests: limits.perRun,
      maxRequests: limits.total,
      ...(input.buyerProxyPort !== undefined ? { buyerProxyPort: input.buyerProxyPort } : {}),
      ...(input.requestLimiter ? { requestLimiter: input.requestLimiter } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
      ...(input.log ? { log: input.log } : {}),
      ...(input.now ? { now: input.now } : {}),
    })
    const recorded = await operations.record({
      banksDir: input.banksDir, model: input.model, epoch: input.epoch, config: input.config,
      calibrations: asked.calibrations, passes: KBF_CALIBRATION_PASSES, exchanges: asked.exchanges, cost: asked.cost,
      ...(input.now ? { now: input.now } : {}),
    })
    await asked.finalize()
    const { hamming, total, errorRate, enrollmentErrorLimit } = recorded.calibration!
    input.log?.(
      `calibration: ${hamming}/${total} missed (${(errorRate * 100).toFixed(1)}%), enrollment limit ${(enrollmentErrorLimit * 100).toFixed(1)}%, `
      + `$${(Number(asked.cost.totalUsdMicros) / 1_000_000).toFixed(6)}`,
    )
    if (errorRate > enrollmentErrorLimit) {
      input.log?.(
        `warning: the reference missed more than its enrollment limit; it may have changed since enrollment. `
        + 'The audit goes on, with its limit from this calibration.',
      )
    }
    return stopped(recorded)
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
 * `extensionCount` extra sets, then calibrated. Only questions built for this epoch can be in it.
 * Throws when the builds don't get there or calibration stops the model; it is then not audited in
 * this run.
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
  calibrate: typeof calibrateEpochQuestionSet
} = {
  inspect: inspectModelProbeBankPower, select: selectEpochQuestionSet, enrollFresh: enrollFreshProbes, record: recordEpochQuestionPool,
  calibrate: calibrateEpochQuestionSet,
}): Promise<EpochQuestionSetV1> {
  if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0) {
    throw new Error('enrollment requires an explicit positive integer request budget')
  }
  const select = () => operations.select({
    banksDir: input.banksDir, model: input.model, epoch: input.epoch, runId: input.runId,
    extensionCount: input.extensionCount, config: input.config,
  })
  const ready = async (set: EpochQuestionSetV1): Promise<EpochQuestionSetV1> => {
    input.log?.(`question set for epoch ${input.epoch} ready: ${describeSet(set)}`)
    return operations.calibrate({
      model: input.model, banksDir: input.banksDir, config: input.config, maxRequests: input.maxRequests,
      epoch: input.epoch, set, buyerProxyPort: input.buyerProxyPort,
      ...(input.requestLimiter ? { requestLimiter: input.requestLimiter } : {}),
      ...(input.log ? { log: input.log } : {}),
    })
  }
  // A model without a bank has nothing to select from yet: its first build makes the bank.
  let selection = await operations.inspect({ banksDir: input.banksDir, model: input.model, config: input.config })
    .then((status) => status.totalProbeCount === 0 ? null : select())
  if (selection?.status === 'ready') return ready(selection.set)
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
    if (selection.status === 'ready') return ready(selection.set)
    if (enrolled.addedProbeCount === 0) break
  }
  throw new Error(`no question set for epoch ${input.epoch}: ${selection?.reason ?? 'the build added no questions'}`)
}

function describeSet(set: EpochQuestionSetV1): string {
  return `${set.reference.probes.length} questions and ${set.extensions.length} extra set(s) of as many, `
    + `from ${set.candidateProbeCount} new questions (${set.previouslyAskedProbeCount} left out as asked before)`
}
