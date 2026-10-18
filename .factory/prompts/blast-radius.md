## Your job: blast radius. What could this change break beyond the diff?

Read and follow: `{skills}/blast-radius/SKILL.md` (and `{skills}/how/SKILL.md` for reading the code). The change: `git -C {worktree} log -p --stat {base}..HEAD`. Context: `{run_dir}/test-plan.md`, `{run_dir}/security.json`, `{verify_dir}/gate.json`.

The fix worktree is READ-ONLY for you (the driver checks HEAD and status). Experiments: scripts under `{run_dir}/scratch/blast-radius/` that import the worktree's real code by absolute path. No extra git worktrees (they write into the shared `.git`). Arena: this factory cannot fan the same question to several models inside one session; the review step does that with three separately pinned sessions. Say so instead of spawning subagents for it.

1. Every caller of what changed, across packages and apps (`rg -n`), and what each one does with the result: display, parsing back, persistence, wire format, comparisons.
2. Find the one fact the change is safe because of and prove it at level 4 (a script or test that runs the real code and fails loud). Paste the command and output.
3. Write `{run_dir}/blast-radius.md` with exactly these headings: `## What it does`, `## The one fact`, `## Risks`, `## Cleared`, `## Before you merge`.
4. Final message: the one fact with its proof level, then exactly `BLAST {slug} DONE` if no confirmed risk, or `BLAST {slug} RISK <n confirmed risks>`.
