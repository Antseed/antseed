import { MIN_SECONDS_FOR_ANOTHER_ROUND } from './audit-window.js'
import { CONFIRMATION_ATTEMPTS, epochCellKey, type EpochCell, type EpochState } from './epoch-plan.js'

/**
 * Whether a cell is a confirmation that has started (an attempt of it finished) and waits to be audited again: the
 * plan audits it again (`retry`, after `CONFIRMATION_RECHECK_SPACING_SECONDS`, within `CONFIRMATION_ATTEMPTS`) or asks
 * its extra questions (`extend`). A confirmation given up (its seller no longer offers the model) waits for nothing.
 */
export function confirmationAwaitingReaudit(cell: EpochCell): boolean {
  if (cell.givenUp || cell.lastAttemptAt === null) return false
  if (cell.action === 'extend') return cell.pending?.confirmsDiff === true
  if (cell.action !== 'retry') return false
  const confirmation = cell.confirmationReport !== undefined || cell.result?.confirmsDiff === true
  return confirmation && cell.attempts < CONFIRMATION_ATTEMPTS
}

/**
 * The confirmations each model's submit is held for, by model in lower case: a model's results are not sent while a
 * confirmation of it that has started waits to be audited again (`confirmationAwaitingReaudit`), since their evidence
 * would publish the model's questions that the confirmation is asked again. As the audit window holds first looks:
 * the confirmation's own attempts and spacing, and nothing is held once the epoch is too near its end for another
 * round (`MIN_SECONDS_FOR_ANOTHER_ROUND`), when every result is sent.
 */
export function confirmationsHoldingSubmit(
  state: Pick<EpochState, 'cells' | 'reportCells'>,
  secondsLeftInEpoch: number,
): Map<string, EpochCell[]> {
  const held = new Map<string, EpochCell[]>()
  if (secondsLeftInEpoch < MIN_SECONDS_FOR_ANOTHER_ROUND) return held
  const sellers = new Set<string>()
  for (const cell of [...state.reportCells?.values() ?? [], ...state.cells.values()]) {
    if (!confirmationAwaitingReaudit(cell)) continue
    // One seller once: its report's cell and its latest cell are the same attempt.
    const seller = epochCellKey(cell.model, cell.peerId)
    if (sellers.has(seller)) continue
    sellers.add(seller)
    const model = cell.model.trim().toLowerCase()
    held.set(model, [...held.get(model) ?? [], cell])
  }
  return held
}

/** Why a model's submit is held for its waiting confirmations, or null when it is not (`confirmationsHoldingSubmit`). */
export function confirmationHoldReason(cells: readonly EpochCell[] | undefined): string | null {
  if (!cells || cells.length === 0) return null
  const attempts = cells.map((cell) => `${cell.peerId.slice(0, 12)} ${cell.action === 'extend' ? 'waiting for its extra questions' : `after attempt ${cell.attempts} of ${CONFIRMATION_ATTEMPTS}`}`)
  return `${cells.length} confirmation(s) of this model wait to be audited again (${attempts.join('; ')}): the model's results `
    + 'would publish the questions they are asked again, so they are sent together once those confirmations are decided, '
    + 'out of attempts, or the epoch is nearly over'
}
