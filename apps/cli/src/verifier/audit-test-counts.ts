/**
 * How each test of a seller audit takes part in its verdict: the one table (Alex, 24 and 25 November). It is part of the
 * audit rules, so every auditor judges alike: it is in the rules fingerprint (`verifierRulesFingerprint`), and no config
 * changes it. One line per test, with two switches:
 *
 * - `counts`: whether the test counts toward the verdict at all. A test that does not still runs, is judged, stored,
 *   published and shown, and decides nothing: it never makes a DIFF and never blocks a SAME, and the published result
 *   names it as not active (`inactive`, cause `rule`). A test's own rule can narrow it further underneath (FLIPS never
 *   counts for a model its eval never measured): a test counts only where both say so.
 * - `blocksSame`: whether a SAME needs the test passed while it counts and is active. When false the test is flag-only:
 *   its flag makes a DIFF, and its no result (it ran and did not decide, or the seller could not be reached for it)
 *   never blocks a SAME and never makes an UNDETERMINED. Setting it to true makes the test required for a SAME again.
 *
 * The questions always count and decide a SAME themselves; they are not in the table.
 *
 * No imports: the test descriptions (`methods/`) and the shared readers (`audit-checks.ts`) both read it.
 */

/** The tests of the table: every finding with a record, by the id a verdict attributes it to. */
export type CountedTestId = 'tokens' | 'output-cap' | 'output-echo' | 'output-offset' | 'flips'

/** One test's line of the table. */
export interface AuditTestRule {
  counts: boolean
  blocksSame: boolean
}

/**
 * Today ("if the questions pass and there is no DIFF, call it SAME"): no test blocks a SAME. The pre-check and the echo
 * check's two findings count, so their flags are DIFFs. The cap check and FLIPS do not count: FLIPS flags too many honest
 * sellers to decide a verdict yet, and the cap check is switched off.
 */
export const AUDIT_TEST_COUNTS: Readonly<Record<CountedTestId, Readonly<AuditTestRule>>> = Object.freeze({
  tokens: Object.freeze({ counts: true, blocksSame: false }),
  'output-cap': Object.freeze({ counts: false, blocksSame: false }),
  'output-echo': Object.freeze({ counts: true, blocksSame: false }),
  'output-offset': Object.freeze({ counts: true, blocksSame: false }),
  flips: Object.freeze({ counts: false, blocksSame: false }),
})

const ruleOf = (id: string): Readonly<AuditTestRule> | null => (id in AUDIT_TEST_COUNTS ? AUDIT_TEST_COUNTS[id as CountedTestId] : null)

/**
 * Whether a test counts toward the verdict under the table, or under the table a reading is taken by (`ReadingRules`
 * `counts`: the eval replay and the dry-run report ask "what if FLIPS counted"; an audit and submit never pass one).
 * An id the table does not hold (the questions) always counts.
 */
export function testCounts(id: string, overrides?: Partial<Record<CountedTestId, boolean>>): boolean {
  const rule = ruleOf(id)
  if (!rule) return true
  return overrides?.[id as CountedTestId] ?? rule.counts
}

/** Whether a SAME needs the test passed while it counts and is active (`AuditTestRule.blocksSame`); the questions always do. */
export function testBlocksSame(id: string): boolean {
  return ruleOf(id)?.blocksSame ?? true
}

/** Why a test the table does not count is not active, as the published `inactive` reason gives it. */
export function notCountedReason(label: string): string {
  return `${label} is recorded only for now: the audit rules do not count it toward the verdict`
}
