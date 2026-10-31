import { readFile } from 'node:fs/promises'
import { epochRunManifests, type ModelAuditSummaryV1, type VerifierRunManifestV1 } from './audit-artifacts.js'
import { finalAuditVerdict } from './diff-recheck.js'
import type {
  ModelVerificationFailure,
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'

/**
 * Who caused a failed or UNDETERMINED audit. `auditor` failures (our buyer refused the seller, our
 * deposit or payment channel, our probe bank) are always retried; `seller` and `unclear` failures
 * are retried once per epoch.
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
  // Our own buyer being down, not a request through it (a seller timeout also says "buyer proxy").
  /buyer proxy (?:state|is not connected|has no live)/i,
]

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

export type EpochCellState = 'same' | 'diff' | 'undetermined' | 'pending_diff' | 'failed' | 'skipped'
export type EpochCellAction = 'done' | 'retry' | 'recheck' | 'audit'

export interface EpochCell {
  model: string
  peerId: string
  runId: string
  state: EpochCellState
  /** Audits that reached the seller this epoch: results, failures and runtime skips (not preflight skips). */
  attempts: number
  blame: FailureBlame | null
  reason: string | null
  skipCode: string | null
  /** Where the latest skip was decided: before any request (`preflight`, `policy`, …) or during the audit (`runtime`). */
  skipSource: string | null
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

export function epochCellAction(cell: Omit<EpochCell, 'action'>): EpochCellAction {
  switch (cell.state) {
    case 'same':
    case 'diff':
      return 'done'
    case 'pending_diff':
      return 'recheck'
    case 'skipped':
      // A skip decided during the audit came after paid requests the seller could not serve
      // (bad upstream credentials, an incompatible request profile, a stale advertisement): it
      // gets the same attempts as a seller failure.
      if (cell.skipSource === 'runtime') return cell.attempts < SELLER_FAILURE_ATTEMPTS ? 'audit' : 'done'
      // Any other skip is decided before any request, so it is re-evaluated each run (a seller
      // may have lowered its price, or the model is advertised again).
      return 'audit'
    case 'undetermined':
      // A DIFF the recheck did not confirm, or a seller that answered and was simply too close to
      // call, is a finished UNDETERMINED: asking again would only repeat it.
      if (cell.result?.recheck || !cell.result?.outcomeReason) return 'done'
      // falls through
    case 'failed':
      if (cell.blame === 'auditor') return 'retry'
      return cell.attempts < SELLER_FAILURE_ATTEMPTS ? 'retry' : 'done'
  }
}

interface RunSummaries {
  manifest: VerifierRunManifestV1
  summaries: ModelAuditSummaryV1[]
}

/**
 * Merges runs oldest first. The latest submittable result per (model, seller) wins; a DIFF waiting
 * for its recheck replaces it only when nothing submittable came after. Failures and skips fill
 * cells without a result.
 */
export function mergeEpochRuns(epoch: string, runs: readonly RunSummaries[]): Map<string, EpochCell> {
  interface Acc {
    model: string
    peerId: string
    runId: string
    attempts: number
    result: ModelVerificationTargetResult | null
    resultRunId: string | null
    pending: { result: ModelVerificationTargetResult; runId: string } | null
    failure: { entry: ModelVerificationFailure; runId: string } | null
    skip: { entry: ModelVerificationSkip; runId: string } | null
    last: 'result' | 'pending' | 'failure' | 'skip'
    /** What the newest audit that reached the seller ended with; preflight skips are not attempts. */
    lastAttempt: 'result' | 'pending' | 'failure' | 'runtime-skip' | null
  }
  const acc = new Map<string, Acc>()
  const get = (model: string, peerId: string, runId: string): Acc => {
    const key = epochCellKey(model, peerId)
    let entry = acc.get(key)
    if (!entry) {
      entry = {
        model, peerId, runId, attempts: 0, result: null, resultRunId: null,
        pending: null, failure: null, skip: null, last: 'skip', lastAttempt: null,
      }
      acc.set(key, entry)
    }
    return entry
  }
  for (const { manifest, summaries } of runs) {
    for (const summary of summaries) {
      if (summary.epoch !== epoch || summary.runId !== manifest.runId) continue
      for (const result of summary.results ?? []) {
        const entry = get(summary.model, result.peerId, manifest.runId)
        entry.attempts += 1
        if (finalAuditVerdict(result) === null) {
          entry.pending = { result, runId: manifest.runId }
          entry.last = 'pending'
          entry.lastAttempt = 'pending'
        } else {
          entry.result = result
          entry.resultRunId = manifest.runId
          entry.pending = null
          entry.last = 'result'
          entry.lastAttempt = 'result'
        }
      }
      for (const failure of summary.failures ?? []) {
        if (failure.peerId.startsWith('model:')) continue
        const entry = get(summary.model, failure.peerId, manifest.runId)
        entry.attempts += 1
        entry.failure = { entry: failure, runId: manifest.runId }
        entry.last = 'failure'
        entry.lastAttempt = 'failure'
      }
      for (const skip of summary.skipped ?? []) {
        const entry = get(summary.model, skip.peerId, manifest.runId)
        if (skip.source === 'runtime') {
          entry.attempts += 1
          entry.lastAttempt = 'runtime-skip'
        }
        entry.skip = { entry: skip, runId: manifest.runId }
        entry.last = 'skip'
      }
    }
  }

  const cells = new Map<string, EpochCell>()
  for (const [key, entry] of acc) {
    let cell: Omit<EpochCell, 'action'>
    const base = { model: entry.model, peerId: entry.peerId, attempts: entry.attempts, skipCode: null, skipSource: null }
    if (entry.pending) {
      // A first DIFF newer than any submittable result: its recheck decides the cell.
      cell = {
        ...base, runId: entry.pending.runId, state: 'pending_diff', blame: null,
        reason: entry.pending.result.recheckPending?.reason ?? null, result: null,
      }
    } else if (entry.result) {
      const verdict = finalAuditVerdict(entry.result)!
      const state = verdict === 'SAME' ? 'same' : verdict === 'DIFF' ? 'diff' : 'undetermined'
      const reason = entry.result.outcomeReason ?? null
      cell = {
        ...base, runId: entry.resultRunId!, state, result: entry.result,
        blame: state === 'undetermined' ? failureBlame(reason) : null,
        reason: reason?.summary ?? null,
      }
      // An UNDETERMINED keeps its evidence, but when a newer audit of the seller failed or was
      // skipped mid-audit, that newer attempt decides who is to blame and so whether to retry.
      if (state === 'undetermined' && entry.lastAttempt === 'failure' && entry.failure) {
        cell.blame = failureBlame(entry.failure.entry.outcomeReason, entry.failure.entry.reason)
        cell.reason = entry.failure.entry.reason
      } else if (state === 'undetermined' && entry.lastAttempt === 'runtime-skip' && entry.skip) {
        cell.blame = 'seller'
        cell.reason = entry.skip.entry.reason
      }
    } else if (entry.failure && (entry.last === 'failure' || !entry.skip)) {
      cell = {
        ...base, runId: entry.failure.runId, state: 'failed', result: null,
        blame: failureBlame(entry.failure.entry.outcomeReason, entry.failure.entry.reason),
        reason: entry.failure.entry.reason,
      }
    } else {
      const skip = entry.skip!
      cell = {
        ...base, runId: skip.runId, state: 'skipped', result: null, blame: null,
        reason: skip.entry.reason, skipCode: skip.entry.code, skipSource: skip.entry.source ?? null,
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
  recheck: number
  audit: number
}

export function countPlan(cells: Iterable<EpochCell>): EpochPlanCounts {
  const counts: EpochPlanCounts = { done: 0, retryAuditor: 0, retrySeller: 0, recheck: 0, audit: 0 }
  for (const cell of cells) {
    if (cell.action === 'done') counts.done += 1
    else if (cell.action === 'recheck') counts.recheck += 1
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
  pendingRecheck: number
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
      entry = { model, same: 0, diff: 0, undetermined: 0, pendingRecheck: 0, failed: 0, skipped: 0, left: 0 }
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
    else if (cell.state === 'pending_diff') entry.pendingRecheck += 1
    else if (cell.state === 'failed') entry.failed += 1
    else entry.skipped += 1
    if (cell.action === 'retry' || cell.action === 'recheck') entry.left += 1
  }
  return [...rows.values()].sort((left, right) => left.model.localeCompare(right.model))
}
