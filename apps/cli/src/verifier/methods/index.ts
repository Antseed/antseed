import { TOKENS_CHECK } from './tokens/method.js'
import { OUTPUT_CAP_CHECK } from './output-cap/method.js'
import { OUTPUT_ECHO_CHECK } from './output-echo/method.js'
import { FLIPS_CHECK } from './flips/method.js'

/**
 * The tests of a seller audit that keep a record: the one list. Each has a folder beside this file, with its rule,
 * its record, its judgement and its description (`method.ts`, a `RecordCheck` of `audit-method.ts`). The rules that
 * read the list are in `audit-checks.ts`; the audit, the run and the rules hash loop over it. The questions are not in
 * it: they are the audit itself.
 */

/** The checks with a record, in run order and attribution order. Never reorder: the order is in the rules hash. */
export const METHODS = Object.freeze([TOKENS_CHECK, OUTPUT_CAP_CHECK, OUTPUT_ECHO_CHECK, FLIPS_CHECK] as const)
