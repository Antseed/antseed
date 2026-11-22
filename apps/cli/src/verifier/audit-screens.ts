import { RECORD_CHECKS, type CheckScreens, type CheckSlot, type ListedCheck, type RecordCheck } from './audit-checks.js'
import type { MethodEnv, MethodRun, OwnScreenFor } from './audit-method.js'

/** The tests' switches as a run's config holds them (`verifier.<key>`, `RecordCheck.toggle`). */
export type MethodSwitches = { readonly [Key in RecordCheck['toggle']['key']]?: boolean }

/** The own screens of one model's tests, each under its slot: the fields of those names in an audit's context. */
export type OwnScreens = Partial<CheckScreens>

/** One test of a run with what builds its own screen for a model, the two of one slot; `own` is null when the test is off. */
type TestOfRun<Slot extends CheckSlot = CheckSlot> = { [Each in Slot]: { check: RecordCheck<Each>; own: OwnScreenFor<Each> | null } }[Slot]

/**
 * The tests of one run, from the list (`RECORD_CHECKS`), so that the run names none of them. Called once, before any
 * model lane: each test that is switched on does its once-per-run work here, in list order (`RecordCheck.forRun`).
 * A test is off only when its switch is false, and then it is given no screen. What is returned gives one model's
 * screens, built in list order from what the run hands each test (`MethodEnv`).
 */
export async function testsOfRun(run: MethodRun, switches: MethodSwitches | undefined): Promise<(env: MethodEnv) => OwnScreens> {
  const ofRun = async <Slot extends CheckSlot>(check: ListedCheck<Slot>): Promise<TestOfRun<Slot>> => (
    { check, own: switches?.[check.toggle.key] === false ? null : await check.forRun(run) }
  )
  const tests: TestOfRun[] = []
  for (const check of RECORD_CHECKS) tests.push(await ofRun(check))
  return (env) => {
    const screens: OwnScreens = {}
    // Each test builds the screen its slot of the context is typed as.
    const build = <Slot extends CheckSlot>({ check, own }: TestOfRun<Slot>): void => {
      check.announce?.(env)
      const screen = own?.(env)
      if (screen) screens[check.slot] = screen
    }
    for (const test of tests) build(test)
    return screens
  }
}
