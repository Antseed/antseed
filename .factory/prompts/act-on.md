## Your job: fix the judge's Act-on items, and nothing else.

Read and follow: `{skills}/principle-fix-root-causes/SKILL.md`, `{skills}/principle-test-behavior-not-implementation/SKILL.md`, `{skills}/tdd/SKILL.md`. The judgment: `{judgment}` (only its `### Act On` section is in scope; Consider, Noted and Dismissed items are not).

1. For each Act-on item: if it is a bug, first extend the test so it fails for that bug, then fix it at the root. Never weaken a test.
2. Keep exactly two commits on {base}: test changes go into commit 1, source changes into commit 2. They are local and unpushed, so rewrite them: `git -C {worktree} commit --fixup=<sha>` then `GIT_SEQUENCE_EDITOR=: git -C {worktree} rebase -i --autosquash {base}` (non-interactive). Commit 1 must still contain only test files and must still FAIL on origin/main for the plan's Red signature.
3. Run the plan's Test command, the owning package's test and typecheck.
4. Check: two commits, clean `git status --porcelain`.
5. Final message: one line per Act-on item and what you did, then exactly `ACTON {slug} DONE`.
