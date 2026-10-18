## Your job: red. A failing regression test, committed alone.

Read and follow: `{skills}/tdd/SKILL.md`, `{skills}/principle-test-behavior-not-implementation/SKILL.md`, `{skills}/principle-sequence-verifiable-units/SKILL.md`. The plan is `{run_dir}/test-plan.md`; it is the contract.
{sent_back}
1. Write the test(s) in the plan's Test file for every case in `## Expected behavior`. Expected values come from the requirement. Follow the package's existing test style. Test only through the public behavior.
2. Run the plan's Test command in `{worktree}` on unmodified source. (The gate also runs it in a fresh worktree after `pnpm install` and building the owning package's workspace dependencies. If you were sent back because it only fails or only loads in this worktree, make the test self-contained; if the Test command itself is the problem, you may correct only the `## Test command` line of the plan, and log why.) It must FAIL, by an assertion about the behavior, and the output must contain the Red signature. A failure from an import, syntax or setup error is not a red: fix the test. If no honest failing test is possible, stop and end with `RED {slug} NO_RED <why>` (that is a finding, not a pass).
3. Change NO source file. Commit only the test file(s): `git -C {worktree} add <test files> && git -C {worktree} commit` with subject `test(<scope>): <the behavior>` and a body that pastes the failing lines you saw{refs_line}. Never write `Fixes`, `Closes` or `Resolves` with an issue number.
4. Check: `git -C {worktree} log --oneline {base}..HEAD` shows exactly one commit and `git -C {worktree} status --porcelain` is empty.
5. Final message: the commit sha and the failing assertion line, then exactly `RED {slug} DONE`.
