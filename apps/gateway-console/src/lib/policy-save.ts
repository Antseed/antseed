import { isApiError, type SaveOptions } from '../api'
import { narrowedSummary } from './key-layers'

/** What a guarded save resolves to when the user backs out of a confirmation. */
export const CANCELLED = Symbol('cancelled')
export type Saved<T> = T | typeof CANCELLED

export type Question = { kind: 'empty' } | { kind: 'narrowed'; message: string; lines: string[] }

/**
 * Sends a policy write, asking the user before `confirmEmpty` (empty allow
 * list, known up front or from a 400 `empty_allow_list`) and before
 * `acceptNarrowed` (409 `narrowed`, nothing stored). Each flag is asked for
 * at most once; any other error is thrown.
 */
export async function guardedSave<T>(
  knownEmpty: boolean,
  send: (options: SaveOptions) => Promise<T>,
  ask: (question: Question) => Promise<boolean>,
): Promise<Saved<T>> {
  const options: SaveOptions = {}
  if (knownEmpty) {
    if (!(await ask({ kind: 'empty' }))) return CANCELLED
    options.confirmEmpty = true
  }
  for (;;) {
    try {
      return await send({ ...options })
    } catch (error) {
      if (isApiError(error, 'empty_allow_list') && !options.confirmEmpty) {
        if (!(await ask({ kind: 'empty' }))) return CANCELLED
        options.confirmEmpty = true
      } else if (isApiError(error, 'narrowed') && !options.acceptNarrowed) {
        if (!(await ask({ kind: 'narrowed', message: error.message, lines: narrowedSummary(error.details) }))) return CANCELLED
        options.acceptNarrowed = true
      } else {
        throw error
      }
    }
  }
}
