import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { writeJsonAtomic } from './atomic-files.js'
import {
  epochDirectory,
  type ModelAuditSummaryV1,
  type VerifierRunManifestV1,
} from './audit-artifacts.js'
import { epochRunManifests } from './epoch-overview.js'
import { latestExtension } from './close-call.js'
import { finalAuditVerdict, retiredRecheckResult } from './model-audit.js'
import type {
  ModelVerificationFailure,
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'
import { addAuditCostSummaries, emptyAuditCostSummary } from './proxy-evidence.js'
import { safeServiceSlug } from './slug.js'
import { normalized } from './utils.js'

/**
 * Who caused a failed or UNDETERMINED audit. `auditor` failures (our buyer refused the seller, our
 * deposit or payment channel, our probe bank) don't use up the seller's retry: they are retried up
 * to `AUDITOR_FAILURE_ATTEMPTS` times per epoch, unless retrying cannot help, and an UNDETERMINED
 * they cause is never submitted. `seller` and `unclear` failures are retried once per epoch.
 */
export type FailureBlame = 'seller' | 'auditor' | 'unclear'

interface ReasonLike {
  code?: string | null
  source?: string | null
  summary?: string | null
}

const AUDITOR_TEXT = [
  /outside your buyer routing policy/i,
  /\bdeposit\b/i,
  /insufficient (?:funds|balance)/i,
  /probe bank/i,
  /BANK_EXHAUSTED/,
  /unseen questions/i,
  /\benrol(?:l)?ment\b/i,
  /reference (?:endpoint|credits?)/i,
  /buyer proxy/i,
  // The auditor's time limits, not the seller's: the fixed total deadline of earlier releases cut off
  // honest slow sellers that were still answering, and the total limit that replaced it.
  /seller audit deadline exceeded after \d+ms/i,
  /seller audit reached its time limit/i,
]

/** Auditor failures that the same configuration repeats on every attempt, so they are not retried. */
const PERMANENT_AUDITOR_TEXT = [
  /outside your buyer routing policy/i,
]

/** Whether an auditor failure would repeat on every attempt this epoch (see `PERMANENT_AUDITOR_TEXT`). */
export function permanentAuditorFailure(reason: ReasonLike | null | undefined, text?: string | null): boolean {
  const summary = [reason?.summary ?? '', text ?? ''].join(' ')
  return PERMANENT_AUDITOR_TEXT.some((pattern) => pattern.test(summary))
}

const SELLER_CODES = new Set([
  'transport_error',
  'rate_limited',
  'deadline_exceeded',
  'request_timeout',
  'temporarily_unavailable',
  'response_auth_missing',
  'response_auth_invalid',
  'missing_response_auth',
  'upstream_credentials_invalid',
  'request_profile_incompatible',
  'malformed_output',
  'stale_model_advertisement',
])

export function failureBlame(reason: ReasonLike | null | undefined, text?: string | null): FailureBlame {
  const summary = [reason?.summary ?? '', text ?? ''].join(' ')
  if (AUDITOR_TEXT.some((pattern) => pattern.test(summary))) return 'auditor'
  const code = reason?.code ?? null
  if (code === 'payment_lock_timeout' || code === 'policy_rejected' || code === 'reputation_below_minimum') return 'auditor'
  if (code && SELLER_CODES.has(code)) return 'seller'
  return 'unclear'
}

export type EpochCellState =
  | 'same' | 'diff' | 'undetermined' | 'pending_extension' | 'failed' | 'skipped'
export type EpochCellAction = 'done' | 'retry' | 'extend' | 'audit'

export interface EpochCell {
  model: string
  peerId: string
  runId: string
  state: EpochCellState
  /**
   * Audits that count toward the seller's retries this epoch: results and failures, and skips found
   * at runtime, but not failures caused by the auditor (`auditorAttempts`).
   */
  attempts: number
  /** Audits this epoch that failed because of the auditor; they have their own limit. */
  auditorAttempts: number
  /** The auditor failure repeats on every attempt (`permanentAuditorFailure`), so it is not retried. */
  permanent: boolean
  /** When the run holding the cell's latest audit finished, in seconds; null when unknown. */
  lastAttemptAt: number | null
  blame: FailureBlame | null
  reason: string | null
  skipCode: string | null
  /** The result submitted for this cell, when there is one. */
  result: ModelVerificationTargetResult | null
  action: EpochCellAction
}

export interface EpochState {
  epoch: string
  manifests: VerifierRunManifestV1[]
  cells: Map<string, EpochCell>
}

export function epochCellKey(model: string, peerId: string): string {
  return `${model.trim().toLowerCase()}\u0000${peerId.trim().replace(/^0x/i, '').toLowerCase()}`
}

/** Seller and unclear failures get this many audits per epoch (the first plus one retry). */
export const SELLER_FAILURE_ATTEMPTS = 2

/**
 * A seller or unclear failure is retried no sooner than this after the audit that failed, and
 * audits closer together than this count as one attempt. A seller's outage (an upstream rate or
 * usage limit, a failing self-health check) usually lasts hours, so a retry minutes later fails the
 * same way and uses up the seller's retry. The epoch lasts a week.
 */
export const SELLER_RETRY_SPACING_SECONDS = 3 * 60 * 60

/**
 * Audits per epoch that may fail because of the auditor before the seller is left alone for the
 * epoch. Without a limit, a cause that lasts (a refusing buyer, an empty deposit) would audit the
 * same seller every run.
 */
export const AUDITOR_FAILURE_ATTEMPTS = 3

/**
 * Audits per epoch for a seller whose DIFF waits for this auditor's confirmation and whose audit
 * ended UNDETERMINED because of a failure. Submitted, that UNDETERMINED replaces the waiting DIFF,
 * so it is held and the seller audited again until a SAME or DIFF, or the last attempt.
 */
export const CONFIRMATION_ATTEMPTS = 3

/** A confirmation is audited again at least this long after its last attempt finished. */
export const CONFIRMATION_RECHECK_SPACING_SECONDS = 10 * 60

/**
 * When a seller or unclear failure may be audited again (seconds), or null when the cell is not
 * such a retry. Confirmation re-checks are spaced by `CONFIRMATION_RECHECK_SPACING_SECONDS` instead.
 */
export function sellerRetryDueAt(cell: Pick<EpochCell, 'state' | 'action' | 'blame' | 'result' | 'attempts' | 'lastAttemptAt'>): number | null {
  if (cell.action !== 'retry' || cell.blame === 'auditor' || cell.lastAttemptAt === null) return null
  if (cell.state !== 'failed' && cell.state !== 'undetermined') return null
  if (cell.result?.confirmsDiff) return null
  return cell.lastAttemptAt + SELLER_RETRY_SPACING_SECONDS
}

/** Whether a cell is a confirmation's UNDETERMINED that is audited again before it is submitted. */
export function heldForConfirmationRecheck(cell: Pick<EpochCell, 'state' | 'action' | 'result' | 'attempts'>): boolean {
  return cell.state === 'undetermined' && cell.action === 'retry' && cell.result?.confirmsDiff === true
    && cell.attempts < CONFIRMATION_ATTEMPTS
}

export function epochCellAction(cell: Omit<EpochCell, 'action'>): EpochCellAction {
  switch (cell.state) {
    case 'same':
    case 'diff':
      return 'done'
    case 'pending_extension':
      return 'extend'
    case 'skipped':
      // A skip is decided before any request, so it is re-evaluated each run (a seller may have
      // lowered its price, or the model is advertised again).
      return 'audit'
    case 'undetermined':
      // The retired DIFF self-recheck's UNDETERMINED cannot be submitted (`retiredRecheckResult`).
      if (cell.result && retiredRecheckResult(cell.result)) return 'audit'
      // A seller that answered and was simply too close to call is a finished UNDETERMINED: asking
      // again would only repeat it.
      if (!cell.result || !failedUndetermined(cell.result)) return 'done'
      // A close call whose extra questions failed is final too, unless a waiting DIFF depends on it:
      // a confirmation's failure is retried like one in its first set.
      if (cell.result.extension && !cell.result.confirmsDiff) return 'done'
      // falls through
    case 'failed':
      if (cell.blame === 'auditor') {
        return !cell.permanent && cell.auditorAttempts < AUDITOR_FAILURE_ATTEMPTS ? 'retry' : 'done'
      }
      return cell.attempts < (cell.result?.confirmsDiff ? CONFIRMATION_ATTEMPTS : SELLER_FAILURE_ATTEMPTS) ? 'retry' : 'done'
  }
}

/**
 * Whether an UNDETERMINED came from a failure rather than from a seller that answered and was too
 * close to call: an outcome reason, or a last extra set whose answers lacked verified ResponseAuth.
 */
function failedUndetermined(result: ModelVerificationTargetResult): boolean {
  return Boolean(result.outcomeReason) || latestExtension(result)?.responseAuthVerified === false
}

interface RunSummaries {
  manifest: VerifierRunManifestV1
  summaries: ModelAuditSummaryV1[]
}

/**
 * Merges runs oldest first. The latest submittable result per (model, seller) wins; a close call
 * waiting for its extra questions replaces it only when nothing submittable came after. Failures
 * and skips fill cells without a result.
 */
export function mergeEpochRuns(epoch: string, runs: readonly RunSummaries[]): Map<string, EpochCell> {
  interface Acc {
    model: string
    peerId: string
    runId: string
    attempts: number
    auditorAttempts: number
    /** When the last counted seller attempt finished (seconds), for `SELLER_RETRY_SPACING_SECONDS`. */
    countedAt: number | null
    lastAttemptAt: number | null
    result: ModelVerificationTargetResult | null
    resultRunId: string | null
    pending: { result: ModelVerificationTargetResult; runId: string } | null
    failure: { entry: ModelVerificationFailure; runId: string } | null
    skip: { entry: ModelVerificationSkip; runId: string } | null
    last: 'result' | 'pending' | 'failure' | 'skip'
  }
  const acc = new Map<string, Acc>()
  const get = (model: string, peerId: string, runId: string): Acc => {
    const key = epochCellKey(model, peerId)
    let entry = acc.get(key)
    if (!entry) {
      entry = {
        model, peerId, runId, attempts: 0, auditorAttempts: 0, countedAt: null, lastAttemptAt: null,
        result: null, resultRunId: null,
        pending: null, failure: null, skip: null, last: 'skip',
      }
      acc.set(key, entry)
    }
    return entry
  }
  for (const { manifest, summaries } of runs) {
    const finishedAt = Number.isFinite(Date.parse(manifest.completedAt)) ? Date.parse(manifest.completedAt) / 1_000 : null
    // A seller attempt counts unless one was counted less than SELLER_RETRY_SPACING_SECONDS before
    // it. Confirmation re-checks have their own spacing and limit, so each of them counts.
    const countSellerAttempt = (entry: Acc, spaced: boolean): void => {
      entry.lastAttemptAt = finishedAt ?? entry.lastAttemptAt
      if (spaced && finishedAt !== null && entry.countedAt !== null
        && finishedAt - entry.countedAt < SELLER_RETRY_SPACING_SECONDS) return
      entry.attempts += 1
      entry.countedAt = finishedAt ?? entry.countedAt
    }
    for (const summary of summaries) {
      if (summary.epoch !== epoch || summary.runId !== manifest.runId) continue
      for (const result of summary.results ?? []) {
        const entry = get(summary.model, result.peerId, manifest.runId)
        if (result.outcomeReason && failureBlame(result.outcomeReason) === 'auditor') {
          entry.auditorAttempts += 1
          entry.lastAttemptAt = finishedAt ?? entry.lastAttemptAt
        } else countSellerAttempt(entry, result.confirmsDiff !== true)
        if (finalAuditVerdict(result) === null) {
          entry.pending = { result, runId: manifest.runId }
          entry.last = 'pending'
        } else {
          entry.result = result
          entry.resultRunId = manifest.runId
          entry.pending = null
          entry.last = 'result'
        }
      }
      for (const failure of summary.failures ?? []) {
        if (failure.peerId.startsWith('model:')) continue
        const entry = get(summary.model, failure.peerId, manifest.runId)
        if (failureBlame(failure.outcomeReason, failure.reason) === 'auditor') {
          entry.auditorAttempts += 1
          entry.lastAttemptAt = finishedAt ?? entry.lastAttemptAt
        } else countSellerAttempt(entry, true)
        entry.failure = { entry: failure, runId: manifest.runId }
        entry.last = 'failure'
      }
      for (const skip of summary.skipped ?? []) {
        const entry = get(summary.model, skip.peerId, manifest.runId)
        if (skip.source === 'runtime') {
          if (failureBlame(skip.outcomeReason, skip.reason) === 'auditor') {
            entry.auditorAttempts += 1
            entry.lastAttemptAt = finishedAt ?? entry.lastAttemptAt
          } else countSellerAttempt(entry, true)
        }
        entry.skip = { entry: skip, runId: manifest.runId }
        entry.last = 'skip'
      }
    }
  }

  const cells = new Map<string, EpochCell>()
  for (const [key, entry] of acc) {
    let cell: Omit<EpochCell, 'action'>
    const base = {
      model: entry.model, peerId: entry.peerId, attempts: entry.attempts, auditorAttempts: entry.auditorAttempts,
      permanent: false, lastAttemptAt: entry.lastAttemptAt, skipCode: null,
    }
    if (entry.pending) {
      // A close call newer than any submittable result: its extra questions decide the cell.
      cell = {
        ...base, runId: entry.pending.runId, state: 'pending_extension', blame: null,
        reason: entry.pending.result.extensionPending?.reason ?? null,
        result: null,
      }
    } else if (entry.result) {
      const verdict = finalAuditVerdict(entry.result)!
      const state = verdict === 'SAME' ? 'same' : verdict === 'DIFF' ? 'diff' : 'undetermined'
      const reason = entry.result.outcomeReason ?? null
      cell = {
        ...base, runId: entry.resultRunId!, state, result: entry.result,
        blame: state === 'undetermined' ? failureBlame(reason) : null,
        permanent: state === 'undetermined' && permanentAuditorFailure(reason),
        reason: reason?.summary ?? null,
      }
    } else if (entry.failure && (entry.last === 'failure' || !entry.skip)) {
      cell = {
        ...base, runId: entry.failure.runId, state: 'failed', result: null,
        blame: failureBlame(entry.failure.entry.outcomeReason, entry.failure.entry.reason),
        permanent: permanentAuditorFailure(entry.failure.entry.outcomeReason, entry.failure.entry.reason),
        reason: entry.failure.entry.reason,
      }
    } else {
      const skip = entry.skip!
      cell = {
        ...base, runId: skip.runId, state: 'skipped', result: null, blame: null,
        reason: skip.entry.reason, skipCode: skip.entry.code,
      }
    }
    cells.set(key, { ...cell, action: epochCellAction(cell) })
  }
  return cells
}

async function readSummary(path: string): Promise<ModelAuditSummaryV1 | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ModelAuditSummaryV1
    return parsed.kind === 'antseed-verifier-model-summary' ? parsed : null
  } catch {
    return null
  }
}

/** Every completed run of the epoch, merged into one state per (model, seller). */
export async function loadEpochState(evidenceDir: string, epoch: string): Promise<EpochState> {
  const manifests = await epochRunManifests(evidenceDir, epoch)
  const runs: RunSummaries[] = []
  for (const manifest of manifests) {
    const summaries: ModelAuditSummaryV1[] = []
    for (const entry of manifest.models) {
      const summary = await readSummary(entry.summaryPath)
      if (summary) summaries.push(summary)
    }
    runs.push({ manifest, summaries })
  }
  return { epoch, manifests, cells: mergeEpochRuns(epoch, runs) }
}

export interface EpochPlanCounts {
  done: number
  retryAuditor: number
  retrySeller: number
  /** Close calls waiting for their extra questions. */
  extend: number
  audit: number
}

export function countPlan(cells: Iterable<EpochCell>): EpochPlanCounts {
  const counts: EpochPlanCounts = { done: 0, retryAuditor: 0, retrySeller: 0, extend: 0, audit: 0 }
  for (const cell of cells) {
    if (cell.action === 'done') counts.done += 1
    else if (cell.action === 'extend') counts.extend += 1
    else if (cell.action === 'audit') counts.audit += 1
    else if (cell.blame === 'auditor') counts.retryAuditor += 1
    else counts.retrySeller += 1
  }
  return counts
}

export interface EpochModelRow {
  model: string
  same: number
  diff: number
  undetermined: number
  /** Close calls waiting for their extra questions. */
  closeCalls: number
  failed: number
  skipped: number
  left: number
}

/** Per-model totals of the merged epoch, for the end-of-run table. */
export function epochModelRows(cells: Iterable<EpochCell>, models?: readonly string[]): EpochModelRow[] {
  const rows = new Map<string, EpochModelRow>()
  const row = (model: string): EpochModelRow => {
    const key = model.toLowerCase()
    let entry = rows.get(key)
    if (!entry) {
      entry = { model, same: 0, diff: 0, undetermined: 0, closeCalls: 0, failed: 0, skipped: 0, left: 0 }
      rows.set(key, entry)
    }
    return entry
  }
  for (const model of models ?? []) row(model)
  for (const cell of cells) {
    const entry = row(cell.model)
    if (cell.state === 'same') entry.same += 1
    else if (cell.state === 'diff') entry.diff += 1
    else if (cell.state === 'undetermined') entry.undetermined += 1
    else if (cell.state === 'pending_extension') entry.closeCalls += 1
    else if (cell.state === 'failed') entry.failed += 1
    else entry.skipped += 1
    if (cell.action === 'retry' || cell.action === 'extend') entry.left += 1
  }
  return [...rows.values()].sort((left, right) => left.model.localeCompare(right.model))
}

/**
 * One manifest for `verifier submit` that covers the whole epoch: per model, the merged result for
 * each seller. Its summaries are written under `epochs/<epoch>/submission/<id>/`; the evidence
 * files they point to stay in their runs. The id changes whenever another run is added.
 */
export async function writeEpochSubmissionManifest(
  evidenceDir: string,
  state: EpochState,
): Promise<VerifierRunManifestV1> {
  const { epoch, manifests } = state
  if (manifests.length === 0) throw new Error(`no completed verifier run found for epoch ${epoch}; run \`antseed verifier run\` first`)
  const runIds = manifests.map((manifest) => manifest.runId)
  const runId = canonicalHashBytes32({ domain: 'antseed-verifier-epoch-submission-v1', epoch, runIds })
  const directory = join(epochDirectory(evidenceDir, epoch), 'submission', safeServiceSlug(runId))
  const models: string[] = []
  for (const manifest of manifests) {
    for (const model of manifest.modelOrder) {
      if (!models.some((entry) => normalized(entry) === normalized(model))) models.push(model)
    }
  }
  const summaries = new Map<string, ModelAuditSummaryV1[]>()
  for (const manifest of manifests) {
    for (const entry of manifest.models) {
      const summary = await readSummary(entry.summaryPath)
      if (!summary || summary.runId !== manifest.runId || summary.epoch !== epoch) continue
      const list = summaries.get(normalized(summary.model)) ?? []
      list.push(summary)
      summaries.set(normalized(summary.model), list)
    }
  }
  const startedAt = manifests.map((manifest) => manifest.startedAt).sort()[0]!
  const completedAt = manifests.map((manifest) => manifest.completedAt).sort().at(-1)!
  const modelEntries: VerifierRunManifestV1['models'] = []
  for (const model of models) {
    const runSummaries = summaries.get(normalized(model)) ?? []
    const results: ModelVerificationTargetResult[] = []
    const failures: ModelVerificationFailure[] = []
    const skipped: ModelVerificationSkip[] = []
    for (const cell of state.cells.values()) {
      if (normalized(cell.model) !== normalized(model)) continue
      const peer = normalized(cell.peerId)
      if (cell.state === 'pending_extension') {
        const pending = latestBy(runSummaries, (summary) => summary.results, peer, (result) => finalAuditVerdict(result) === null)
        if (pending) results.push(pending)
      } else if (heldForConfirmationRecheck(cell)) {
        // Not submitted yet: it would replace the DIFF waiting for this auditor's confirmation.
        const result = cell.result!
        failures.push({
          peerId: result.peerId,
          displayName: result.displayName,
          agentId: result.agentId,
          service: result.service,
          status: 'FAILED',
          reason: `held: UNDETERMINED (${cell.reason ?? 'audit failed'}) on a DIFF waiting for this auditor's confirmation; `
            + `audited again before it is submitted (attempt ${cell.attempts} of ${CONFIRMATION_ATTEMPTS})`,
          ...(result.outcomeReason ? { outcomeReason: result.outcomeReason } : {}),
        })
      } else if (cell.result && cell.state === 'undetermined' && cell.blame === 'auditor') {
        // The auditor's own failure says nothing about the seller's model: never submitted.
        const result = cell.result
        failures.push({
          peerId: result.peerId,
          displayName: result.displayName,
          agentId: result.agentId,
          service: result.service,
          status: 'FAILED',
          reason: `not submitted: UNDETERMINED caused by this auditor (${cell.reason ?? 'audit failed'})`
            + (cell.action === 'retry'
              ? `; audited again (attempt ${cell.auditorAttempts} of ${AUDITOR_FAILURE_ATTEMPTS})`
              : cell.permanent ? '; not retried, since every attempt would fail the same way' : ''),
          ...(result.outcomeReason ? { outcomeReason: result.outcomeReason } : {}),
        })
      } else if (cell.result) {
        results.push(cell.result)
      } else if (cell.state === 'failed') {
        const failure = latestBy(runSummaries, (summary) => summary.failures, peer)
        if (failure) failures.push(failure)
      } else {
        const skip = latestBy(runSummaries, (summary) => summary.skipped, peer)
        if (skip) skipped.push(skip)
      }
    }
    for (const failure of runSummaries.flatMap((summary) => summary.failures)) {
      if (failure.peerId.startsWith('model:') && results.length === 0) failures.push(failure)
    }
    const byPeer = <T extends { peerId: string }>(values: T[]): T[] => values.sort((a, b) => a.peerId.localeCompare(b.peerId))
    const summary: ModelAuditSummaryV1 = {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId,
      epoch,
      model,
      startedAt,
      completedAt,
      results: byPeer(results),
      failures: byPeer(failures),
      skipped: byPeer(skipped),
      cost: addAuditCostSummaries(emptyAuditCostSummary(), ...runSummaries.map((entry) => entry.cost)),
    }
    const summaryPath = join(directory, `${safeServiceSlug(model)}.summary.json`)
    await writeJsonAtomic(summaryPath, summary)
    modelEntries.push({
      model,
      summaryPath,
      reportPath: '',
      resultCount: results.length,
      failureCount: failures.length,
      skippedCount: skipped.length,
      cost: summary.cost,
      reasonCounts: {},
    })
  }
  return {
    version: 1,
    kind: 'antseed-verifier-run-manifest',
    runId,
    state: 'completed',
    epoch,
    epochSource: manifests.every((manifest) => manifest.epochSource === 'onchain') ? 'onchain' : 'utc-day',
    epochStartedAt: manifests[0]!.epochStartedAt,
    epochEndsAt: manifests[0]!.epochEndsAt,
    startedAt,
    completedAt,
    summaryPath: join(directory, 'manifest.json'),
    modelOrder: models,
    models: modelEntries,
    failureCount: modelEntries.reduce((total, entry) => total + entry.failureCount, 0),
  }
}

function latestBy<T extends { peerId: string }>(
  summaries: readonly ModelAuditSummaryV1[],
  pick: (summary: ModelAuditSummaryV1) => readonly T[] | undefined,
  peer: string,
  filter: (value: T) => boolean = () => true,
): T | null {
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const found = (pick(summaries[index]!) ?? []).find((value) => normalized(value.peerId) === peer && filter(value))
    if (found) return found
  }
  return null
}
