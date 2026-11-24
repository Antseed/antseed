/**
 * Which tests of a seller audit count toward its verdict: the one table (Alex, 24 November: "a flag per audit method
 * where we set if we want to count them as part of the audit"). It is part of the audit rules, so every auditor judges
 * alike: it is in the rules fingerprint (`verifierRulesFingerprint`), and no config changes it.
 *
 * A test whose entry is false still runs, is judged, stored, published and shown, and decides nothing: it never makes a
 * DIFF and never blocks a SAME, and the published result names it as not active (`inactive`, cause `rule`). A test's own
 * rule can narrow it further underneath (FLIPS never counts for MiniMax M3 nor for a model its eval never measured): a
 * test counts only where both say so. The questions always count, and are not in the table.
 *
 * No imports: the test descriptions (`methods/`) and the shared readers (`audit-checks.ts`) both read it.
 */

/** The tests of the table: every finding with a record, by the id a verdict attributes it to. */
export type CountedTestId = 'tokens' | 'output-cap' | 'output-echo' | 'output-offset' | 'flips'

/**
 * Today: every test counts but FLIPS, which has too many false positives on honest sellers to decide a verdict yet.
 * FLIPS is recorded only.
 */
export const AUDIT_TEST_COUNTS: Readonly<Record<CountedTestId, boolean>> = Object.freeze({
  tokens: true,
  'output-cap': true,
  'output-echo': true,
  'output-offset': true,
  flips: false,
})

/**
 * Whether a test counts toward the verdict under the table, or under the table a reading is taken by (`ReadingRules`
 * `counts`: the eval replay and the dry-run report ask "what if FLIPS counted"; an audit and submit never pass one).
 * An id the table does not hold (the questions) always counts.
 */
export function testCounts(id: string, overrides?: Partial<Record<CountedTestId, boolean>>): boolean {
  if (!(id in AUDIT_TEST_COUNTS)) return true
  const key = id as CountedTestId
  return overrides?.[key] ?? AUDIT_TEST_COUNTS[key]
}

/** Why a test the table does not count is not active, as the published `inactive` reason gives it. */
export function notCountedReason(label: string): string {
  return `${label} is recorded only for now: the audit rules do not count it toward the verdict`
}
