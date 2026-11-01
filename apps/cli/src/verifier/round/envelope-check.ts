import { isDeepStrictEqual } from 'node:util'
import {
  KBF_PROBES_PER_REQUEST,
  KBF_PROMPT_VARIANT_IDS,
  KBF_THINKING_SUPPRESSION_FIELDS,
  renderKbfProbeLine,
  type KbfProbe,
} from '@antseed/fingerprints'
import { modelHash, serviceHash } from '@antseed/node/payments'
import { REFERENCE_MAX_TOKENS_CEILING } from '../thinking-suppression.js'
import { sliceCollectors, sortTargets } from './plan.js'
import { targetKey, type EnvelopeContentV1, type EnvelopeSliceV1, type RoundTargetV1 } from './types.js'

/** Most output tokens an envelope may ask a seller for per request: the most any reference strategy uses. */
export const ENVELOPE_MAX_TOKENS = REFERENCE_MAX_TOKENS_CEILING
/** Longest question line an envelope may hold, so a publisher cannot inflate prompt costs. */
export const ENVELOPE_MAX_PROBE_CHARS = 1_000
const MAX_PREFILL_CHARS = 1_024
const MAX_THINKING_OVERRIDES_BYTES = 512
const THINKING_FIELDS = new Set<string>(KBF_THINKING_SUPPRESSION_FIELDS)
const VARIANT_IDS = new Set<string>(KBF_PROMPT_VARIANT_IDS)

export interface EnvelopeExpectations {
  epoch: bigint
  seed: string
  /** This verifier, lowercase. */
  collector: string
  backup: boolean
  /** The epoch's verifier snapshot. */
  verifiers: readonly string[]
  /** The plan file's public target list. */
  targets: readonly RoundTargetV1[]
  /** Model hashes on the epoch's audited model list, lowercase. */
  allowedModels: ReadonlySet<string>
  probesPerService: number
  slicesPerService: number
}

/**
 * A target that names an audited model and whose hashes match its own names. Whether the bank
 * has a reference for it can only be checked once the key is out.
 */
export function isListedTarget(target: RoundTargetV1, allowedModels: ReadonlySet<string>): boolean {
  return typeof target.agentId === 'string' && /^[1-9]\d*$/.test(target.agentId)
    && typeof target.peerId === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(target.peerId)
    && typeof target.model === 'string' && typeof target.service === 'string'
    && typeof target.modelHash === 'string' && typeof target.serviceHash === 'string'
    && allowedModels.has(target.modelHash.toLowerCase())
    && modelHash(target.model) === target.modelHash.toLowerCase()
    && serviceHash(target.service) === target.serviceHash.toLowerCase()
}

/**
 * Checks a decrypted envelope against everything public before a single paid request: it must
 * hold only slices the seed assigns to this verifier (as owner, or as backup), of targets on the
 * committed plan, with at most the schedule's questions per target, one-line questions of
 * bounded length in known prompt variants, and request settings limited to the reference's
 * fields. The questions themselves can only be checked against the bank after the reveal, but
 * whatever an envelope holds, the purchases it can cause stay within the schedule. Returns the
 * envelope with each slice's target replaced by the plan's own copy, or throws why it is not
 * acceptable.
 */
export function checkEnvelope(value: unknown, expected: EnvelopeExpectations): EnvelopeContentV1 {
  const fail = (reason: string): never => { throw new Error(`envelope rejected: ${reason}`) }
  if (!isRecord(value)) return fail('not an object')
  if (value['kind'] !== 'antseed-kbf-envelope' || value['version'] !== 1) fail('not a v1 envelope')
  if (value['epoch'] !== expected.epoch.toString()) fail('wrong epoch')
  if (value['collector'] !== expected.collector.toLowerCase()) fail('addressed to another verifier')
  if (value['backup'] !== expected.backup) fail(expected.backup ? 'not a backup envelope' : 'not a primary envelope')
  if (!Array.isArray(value['slices'])) return fail('no slice list')

  const planTargets = new Map(sortTargets(expected.targets).map((target) => [targetKey(target), target]))
  const seenSlices = new Set<string>()
  const batchesByTarget = new Map<string, Set<number>>()
  const probesByTarget = new Map<string, Set<string>>()
  const settingsByModel = new Map<string, EnvelopeSliceV1['request']>()
  const slices: EnvelopeSliceV1[] = []
  for (const raw of value['slices'] as unknown[]) {
    if (!isRecord(raw) || !isRecord(raw['target'])) fail('malformed slice')
    const slice = raw as unknown as EnvelopeSliceV1
    const key = typeof slice.target.agentId === 'string' && typeof slice.target.serviceHash === 'string' ? targetKey(slice.target) : ''
    const target = planTargets.get(key)
    if (!target || !isListedTarget(target, expected.allowedModels)) fail(`target ${key || '?'} is not an audited target of the plan`)
    const listed = target!
    if (!isDeepStrictEqual(sortTargets([slice.target])[0], listed)) fail(`target ${key} differs from the plan`)
    if (!Number.isSafeInteger(slice.sliceIndex) || slice.sliceIndex < 0 || slice.sliceIndex >= expected.slicesPerService) {
      fail(`slice index ${String(slice.sliceIndex)} of ${key} is out of range`)
    }
    const sliceId = `${key}#${slice.sliceIndex}`
    if (seenSlices.has(sliceId)) fail(`slice ${sliceId} appears twice`)
    seenSlices.add(sliceId)
    const collectors = sliceCollectors(expected.verifiers, expected.seed, listed, slice.sliceIndex)
    const assignee = expected.backup ? collectors.backup : collectors.owner
    if (assignee !== expected.collector.toLowerCase() || (expected.backup && collectors.backup === collectors.owner)) {
      fail(`slice ${sliceId} is not assigned to this verifier`)
    }

    checkRequest(slice.request, sliceId, fail)
    const known = settingsByModel.get(listed.model)
    if (known && !isDeepStrictEqual(known, slice.request)) fail(`request settings of ${listed.model} differ between slices`)
    settingsByModel.set(listed.model, slice.request)

    if (!Array.isArray(slice.batches) || slice.batches.length === 0) fail(`slice ${sliceId} has no batches`)
    const batchIndexes = batchesByTarget.get(key) ?? new Set<number>()
    const probeIds = probesByTarget.get(key) ?? new Set<string>()
    for (const batch of slice.batches) {
      if (!isRecord(batch)) fail(`slice ${sliceId} has a malformed batch`)
      if (!Number.isSafeInteger(batch.batchIndex) || batch.batchIndex < 0 || batch.batchIndex >= expected.probesPerService) {
        fail(`batch index ${String(batch.batchIndex)} of ${key} is out of range`)
      }
      if (batchIndexes.has(batch.batchIndex)) fail(`batch ${batch.batchIndex} of ${key} appears twice`)
      batchIndexes.add(batch.batchIndex)
      if (typeof batch.promptVariantId !== 'string' || !VARIANT_IDS.has(batch.promptVariantId)) fail(`unknown prompt variant in ${key}`)
      if (
        !Array.isArray(batch.probeIds) || !Array.isArray(batch.probes) || batch.probeIds.length === 0
        || batch.probeIds.length > KBF_PROBES_PER_REQUEST || batch.probes.length !== batch.probeIds.length
      ) {
        fail(`batch ${batch.batchIndex} of ${key} has a bad question count`)
      }
      batch.probeIds.forEach((id, position) => {
        const probe = batch.probes[position]
        if (typeof id !== 'string' || !isProbe(probe) || probe.id !== id) fail(`batch ${batch.batchIndex} of ${key} has a malformed question`)
        if (renderKbfProbeLine(probe as KbfProbe).length > ENVELOPE_MAX_PROBE_CHARS) fail(`a question of ${key} is too long`)
        if (probeIds.has(id)) fail(`question ${id} of ${key} appears twice`)
        probeIds.add(id)
      })
    }
    if (probeIds.size > expected.probesPerService) fail(`${key} has more than ${expected.probesPerService} questions`)
    batchesByTarget.set(key, batchIndexes)
    probesByTarget.set(key, probeIds)
    slices.push({ ...slice, target: listed })
  }
  return {
    kind: 'antseed-kbf-envelope', version: 1, epoch: expected.epoch.toString(),
    collector: expected.collector.toLowerCase(), backup: expected.backup, slices,
  }
}

function checkRequest(request: unknown, sliceId: string, fail: (reason: string) => never): void {
  if (!isRecord(request)) fail(`slice ${sliceId} has no request settings`)
  const settings = request as EnvelopeSliceV1['request']
  if (Object.keys(settings).some((key) => !['maxTokens', 'thinkingOverrides', 'assistantPrefill'].includes(key))) {
    fail(`slice ${sliceId} has unknown request settings`)
  }
  if (!Number.isSafeInteger(settings.maxTokens) || settings.maxTokens < 1 || settings.maxTokens > ENVELOPE_MAX_TOKENS) {
    fail(`slice ${sliceId} asks for ${String(settings.maxTokens)} max tokens`)
  }
  if (!isRecord(settings.thinkingOverrides) || Object.keys(settings.thinkingOverrides).some((key) => !THINKING_FIELDS.has(key))) {
    fail(`slice ${sliceId} has request fields other than thinking settings`)
  }
  if (Buffer.byteLength(JSON.stringify(settings.thinkingOverrides)) > MAX_THINKING_OVERRIDES_BYTES) {
    fail(`slice ${sliceId} has oversized thinking settings`)
  }
  if (settings.assistantPrefill !== null && (typeof settings.assistantPrefill !== 'string' || settings.assistantPrefill.length > MAX_PREFILL_CHARS)) {
    fail(`slice ${sliceId} has a bad assistant prefill`)
  }
}

function isProbe(value: unknown): value is KbfProbe {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string' && typeof value['template'] === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
