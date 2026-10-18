## Your job: fix. The smallest root-cause fix, as the second commit.

Read and follow: `{skills}/principle-fix-root-causes/SKILL.md`, `{skills}/poteto-mode/playbooks/bug-fix.md` (be scientific: every shipped line traces to runtime evidence; steps 2 to 5), `{skills}/typescript-best-practices/SKILL.md`, `{skills}/principle-subtract-before-you-add/SKILL.md`. Inputs: `{run_dir}/test-plan.md` (root cause), the test commit `git -C {worktree} show HEAD`, `{run_dir}/evidence/red.txt` (the gate's verbatim red run).
{sent_back}
1. Fix the first wrong decision, not the symptom. No guards where the symptom shows up, no belt-and-braces. Do not change the test commit's assertions.
2. Run the plan's Test command (must pass), then the owning package's `test` and `typecheck` scripts (`pnpm --filter <package> test`, `pnpm --filter <package> run typecheck`).
3. The repo's CLAUDE.md asks for a CHANGELOG.md entry for user-facing behavior changes; follow the file's existing format if this fix changes what users see.
4. Commit source (+ CHANGELOG.md if any) as ONE commit: subject `fix(<scope>): <what changed>`, body: root cause in two sentences and the passing output{refs_line}. Never `Fixes/Closes/Resolves #n`.
5. Check: exactly two commits on {base} (`git -C {worktree} log --oneline {base}..HEAD`: test, then fix) and a clean `git status --porcelain`.
6. Final message: what was broken, the root cause, the fix, the passing line, then exactly `FIX {slug} DONE`.
