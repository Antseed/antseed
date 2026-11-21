import { closeFinishedAuditWindows, type AuditWindowV1 } from './audit-window.js'
import { AUDITOR_FAILURE_ATTEMPTS, SELLER_FAILURE_ATTEMPTS, SELLER_RETRY_SPACING_SECONDS, epochCellKey, type EpochCell, type EpochState } from './epoch-plan.js'
import { auditBeforeAllTests, auditFinishedAt } from './model-audit.js'

/**
 * First looks whose result submit would refuse (its evidence cannot be read, has no valid date or was written before
 * the all-tests format, `auditFinishedAt`) and that still have attempts left, the seller's and the auditor's: by
 * `epochCellKey`. They are audited again, and their window stays open, so a SAME or DIFF is not left unsent all epoch.
 * A completed result refused only for its format (`auditBeforeAllTests`, from a CLI upgraded within the epoch) gets
 * one attempt beyond those limits, which no seller or auditor caused: it is recovered while no attempt has finished
 * since its own run. A seller that a completed run of the model, started after its last attempt, did not plan (it no
 * longer offers the model, or another auditor judged it) is no longer waited for: its window would otherwise stay
 * open until the end of the epoch, holding the model's other results.
 */
export async function recoveringFirstLooks(state: Pick<EpochState, 'ordinaryCells' | 'manifests'> | null): Promise<Map<string, EpochCell>> {
  const recovering = new Map<string, EpochCell>()
  for (const cell of state?.ordinaryCells?.values() ?? []) {
    // Given up (its seller no longer offers the model, `decideRetryGiveUps`): no longer waited for.
    if (!cell.result || cell.action !== 'done' || cell.confirmationReport !== undefined || cell.givenUp) continue
    const attemptsLeft = cell.attempts < SELLER_FAILURE_ATTEMPTS && cell.auditorAttempts < AUDITOR_FAILURE_ATTEMPTS
    if (!attemptsLeft && !(await extraAttemptLeft(cell, state?.manifests ?? []))) continue
    // Passed over: a completed run of the model, not limited to some sellers and no `--resume-run` repair (which audits
    // only another run's undetermined sellers), that started once the seller was due again (after its retry spacing)
    // and still did not audit it.
    const lastAttemptAt = cell.lastAttemptAt
    const passedOver = lastAttemptAt !== null && (state?.manifests ?? []).some((manifest) => manifest.runId !== cell.runId
      && manifest.state !== 'running' && manifest.selection === undefined && manifest.repairOf === undefined
      && Date.parse(manifest.startedAt) / 1_000 >= lastAttemptAt + SELLER_RETRY_SPACING_SECONDS
      // The model ran to its summary in that run: one only planned (a failed build, a run stopped first) passed nobody.
      && manifest.models.some((entry) => entry.model.toLowerCase() === cell.model.toLowerCase())
      // A run that audited the model only for its confirmations never considered its other sellers.
      && !(manifest.confirmationOnly ?? []).some((model) => model.toLowerCase() === cell.model.toLowerCase()))
    if (passedOver) continue
    if (await auditFinishedAt(cell.result) === null) recovering.set(epochCellKey(cell.model, cell.peerId), cell)
  }
  return recovering
}

/**
 * Whether a first look whose attempts are used up still has its one extra attempt: its result was written before the
 * all-tests format, and no attempt has finished since the run that wrote it (the cell's last attempt is that run's).
 */
async function extraAttemptLeft(cell: EpochCell, manifests: readonly EpochState['manifests'][number][]): Promise<boolean> {
  const resultRun = manifests.find((manifest) => manifest.runId === cell.runId)
  const resultFinishedAt = resultRun && Number.isFinite(Date.parse(resultRun.completedAt)) ? Date.parse(resultRun.completedAt) / 1_000 : null
  if (resultFinishedAt === null || (cell.lastAttemptAt !== null && cell.lastAttemptAt > resultFinishedAt)) return false
  return auditBeforeAllTests(cell.result!)
}

/**
 * Closes the epoch's finished windows as `closeFinishedAuditWindows` does, with the first looks still to be recovered
 * counted as left: the one close `verifier run` and `verifier submit` (and its publication) both make.
 */
export async function closeFinishedWindowsRecovering(input: {
  evidenceDir: string
  epoch: string
  state: Pick<EpochState, 'cells' | 'manifests' | 'ordinaryCells'>
  secondsLeftInEpoch: number
}): Promise<AuditWindowV1[]> {
  return closeFinishedAuditWindows({ ...input, recovering: new Set((await recoveringFirstLooks(input.state)).keys()) })
}
