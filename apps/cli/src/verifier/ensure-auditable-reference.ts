import { join } from 'node:path'
import type { VerifierCLIConfig } from '../config/types.js'
import { acquirePidFileLock } from './atomic-files.js'
import { findVerifierModel } from './model-config.js'
import { buildModelReference, type ReferenceRequestLimiter } from './model-reference.js'
import { loadConfiguredVerifierModelCatalog } from './openrouter-catalog.js'
import {
  appendModelReferenceToBank,
  inspectModelProbeBankPower,
  inspectSellerProbeCapacity,
  loadBankEnrollmentReference,
  loadBankProbeIndex,
} from './probe-bank.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'

const dependencies = {
  inspect: inspectModelProbeBankPower,
  loadSeed: loadBankEnrollmentReference,
  loadIndex: loadBankProbeIndex,
  catalog: loadConfiguredVerifierModelCatalog,
  build: buildModelReference,
  append: appendModelReferenceToBank,
}

/** Pins a model's contrast models in a cloned config, so enrollment keeps the bank's contrasts. */
function withContrastModels(config: VerifierCLIConfig, service: string, contrastModels: string[]): void {
  const models = config.models ?? {}
  const key = Object.keys(models).find((name) => findVerifierModel(config, name)?.[0] === service) ?? service
  config.models = { ...models, [key]: { ...models[key], contrastModels: [...contrastModels] } }
}

export async function ensureAuditableReference(input: {
  model: string
  banksDir: string
  referencesDir: string
  config: VerifierCLIConfig | undefined
  maxRequests: number
  buyerProxyPort?: number
  /** Shared across models enrolled at the same time, so they respect one concurrency limit. */
  requestLimiter?: ReferenceRequestLimiter
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
    const config = structuredClone(input.config)
    const entry = findVerifierModel(config, input.model)
    if (!config?.referenceEndpoint || !entry) {
      throw new Error(`no reference configuration for ${input.model}`)
    }
    if (initialReference) {
      withContrastModels(config, entry[0], initialReference.contrasts.map((contrast) => contrast.model))
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
      requestLimiter: input.requestLimiter,
      initialReference,
      log: input.log,
    })
    const appended = await operations.append({
      banksDir: input.banksDir, model: input.model, reference: built.reference, cost: built.cost,
      answeredContrastModelsByProbeId: built.answeredContrastModelsByProbeId,
      exchanges: built.exchanges,
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

/**
 * Builds a brand-new reference (fresh questions) and appends it to the bank, keeping the bank's
 * contrast models. Used when a DIFF recheck needs probes the seller has never seen.
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
}, operations: typeof dependencies = dependencies): Promise<{ addedProbeCount: number; costUsdMicros: string }> {
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
    config.referenceMaxRequestsPerBuild = Math.min(
      input.maxRequests, config.referenceMaxRequestsPerBuild ?? input.maxRequests,
    )
    input.log?.(`generating fresh probes: at most ${config.referenceMaxRequestsPerBuild} physical requests`)
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
    return { addedProbeCount: appended.addedProbeCount, costUsdMicros: built.cost.totalUsdMicros }
  } finally {
    await lock.release()
  }
}

/** Fresh-question builds per model and run, at most, when sellers have seen too much of the bank. */
export const SELLER_CAPACITY_ENROLLMENT_ROUNDS = 3

/**
 * Makes sure every seller about to be audited has enough questions it has never been given: one
 * audit set (unless it already has one this epoch) plus a DIFF recheck set. A bank can be ready
 * as a whole while the sellers audited in earlier epochs have seen most of it; for them, fresh
 * questions are built and added to the bank (up to `SELLER_CAPACITY_ENROLLMENT_ROUNDS` builds).
 * Returns the sellers still short afterwards, which will fail with BANK_EXHAUSTED.
 */
export async function ensureSellerProbeCapacity(input: {
  model: string
  banksDir: string
  referencesDir: string
  config: VerifierCLIConfig | undefined
  maxRequests: number
  epoch: string
  sellerPeerIds: readonly string[]
  recheck: boolean
  buyerProxyPort?: number
  requestLimiter?: ReferenceRequestLimiter
  log?: (message: string) => void
}, operations: {
  capacity: typeof inspectSellerProbeCapacity
  enrollFresh: typeof enrollFreshProbes
} = { capacity: inspectSellerProbeCapacity, enrollFresh: enrollFreshProbes }): Promise<string[]> {
  if (input.sellerPeerIds.length === 0) return []
  const shortSellers = async () => {
    const capacity = await operations.capacity({
      banksDir: input.banksDir, model: input.model, epoch: input.epoch,
      sellerPeerIds: input.sellerPeerIds, recheck: input.recheck, config: input.config,
    })
    return capacity.sellers.filter((seller) => seller.unseenProbeCount < seller.neededProbeCount)
  }
  let short = await shortSellers()
  for (let round = 1; round <= SELLER_CAPACITY_ENROLLMENT_ROUNDS && short.length > 0; round += 1) {
    const worst = short.reduce((low, seller) => seller.unseenProbeCount < low.unseenProbeCount ? seller : low)
    input.log?.(
      `${short.length} seller(s) have too few unseen questions (lowest: ${worst.unseenProbeCount} of `
      + `${worst.neededProbeCount} needed); building fresh questions (round ${round}/${SELLER_CAPACITY_ENROLLMENT_ROUNDS})`,
    )
    const enrolled = await operations.enrollFresh({
      model: input.model, banksDir: input.banksDir, referencesDir: input.referencesDir, config: input.config,
      maxRequests: input.maxRequests, buyerProxyPort: input.buyerProxyPort,
      ...(input.requestLimiter ? { requestLimiter: input.requestLimiter } : {}),
      ...(input.log ? { log: input.log } : {}),
    })
    if (enrolled.addedProbeCount === 0) {
      input.log?.('fresh enrollment added no questions; stopping')
      break
    }
    short = await shortSellers()
  }
  if (short.length > 0) {
    input.log?.(`${short.length} seller(s) still short of unseen questions; they will fail with BANK_EXHAUSTED`)
  } else {
    input.log?.('every seller has enough unseen questions')
  }
  return short.map((seller) => seller.sellerPeerId)
}
