import { RECORD_CHECKS, type CheckSlot, type RecordCheck } from './audit-checks.js'
import type { MethodEnv, MethodRun, OwnScreenFor } from './audit-method.js'
import type { ProxyVerificationContext } from './model-run.js'

/** The tests' switches as a run's config holds them (`verifier.<key>`, `RecordCheck.toggle`). */
export type MethodSwitches = { readonly [Key in RecordCheck['toggle']['key']]?: boolean }

/** The own screens of one model's tests, each under its slot: the fields of those names in an audit's context. */
export type OwnScreens = Pick<ProxyVerificationContext, CheckSlot>

/**
 * The tests of one run, from the list (`RECORD_CHECKS`), so that the run names none of them. Called once, before any
 * model lane: each test that is switched on does its once-per-run work here, in list order (`RecordCheck.forRun`).
 * A test is off only when its switch is false, and then it is given no screen. What is returned gives one model's
 * screens, built in list order from what the run hands each test (`MethodEnv`).
 */
export async function testsOfRun(run: MethodRun, switches: MethodSwitches | undefined): Promise<(env: MethodEnv) => OwnScreens> {
  const tests: Array<{ check: RecordCheck<CheckSlot>; own: OwnScreenFor<CheckSlot> | null }> = []
  for (const check of RECORD_CHECKS as readonly unknown[] as ReadonlyArray<RecordCheck<CheckSlot>>) {
    tests.push({ check, own: switches?.[check.toggle.key] === false ? null : await check.forRun(run) })
  }
  return (env) => {
    const screens: Record<string, unknown> = {}
    for (const { check, own } of tests) {
      check.announce?.(env)
      const screen = own?.(env)
      if (screen) screens[check.slot] = screen
    }
    // Each test builds the screen its slot of the context is typed as.
    return screens as OwnScreens
  }
}
