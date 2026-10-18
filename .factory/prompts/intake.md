## Your job: intake. Sharpen the task into a test plan.

Read and follow: `{skills}/sharpen/SKILL.md`, `{skills}/poteto-mode/playbooks/bug-fix.md` (step 1: reproduce it yourself), `{skills}/principle-test-behavior-not-implementation/SKILL.md`, the repo's `{worktree}/CLAUDE.md`, and the verify-antseed skill from the sandbox stack: `git -C {worktree} show {sandbox_ref}:.claude/skills/verify-antseed/SKILL.md` (its "Decide what to prove" rule: a unit test unless only a sandbox scenario reproduces it).

The fix worktree is READ-ONLY for you: no edits, no commits, no state-changing git. The driver compares HEAD and `git status` before and after you. Scratch files go in `{run_dir}/scratch/`.
{sent_back}
1. Sharpen silently: what is really wrong, what correct behavior the user expects, the outside check that proves it.
2. Reproduce on origin/main ({base}) with a small script in `{run_dir}/scratch/` that calls the real code (for TypeScript, e.g. `cd {worktree} && node --experimental-strip-types {run_dir}/scratch/repro.ts` importing the source by absolute path, or vitest). Paste its output into the plan. If it does not reproduce, write `INTAKE {slug} NOT_REPRODUCED <what you saw>` as your final line: a bug that does not reproduce is a finding.
3. Find the root cause (the first wrong decision in the code), with file:line, and every sibling input that hits the same mechanism (they belong in the test).
4. Choose the proof: `unit` (default) or `sandbox: <scenario>` only if no unit test can reproduce it. Choose the owning package, the test file (an existing test file of that package when one fits, else a new `*.test.ts` next to the code) and a narrow test command run from the repo root that needs nothing built beyond what it builds itself.
5. Write `{run_dir}/test-plan.md`. First line exactly `Status: final`. Then these `## ` headings, in this order, each non-empty:
   - `## Task`: one paragraph.
   - `## Sharpened`: what the user is really after and the outside check.
   - `## Reproduction`: the script path, the command, its output verbatim.
   - `## Root cause`: mechanism, file:line, sibling inputs.
   - `## Proof`: first line `unit` or `sandbox: <scenario>`, then why.
   - `## Owning package`: the package name in backticks.
   - `## Test file`: the path in backticks.
   - `## Test command`: exactly one command in backticks.
   - `## Red signature`: one literal string in backticks that the failing test output must contain because of THIS bug (for example the wrong value the code returns today), and that a setup or import error would not print.
   - `## Expected behavior`: the cases the test asserts, as input -> expected output, derived from the requirement (never from running the code).
   - `## Out of scope`
6. Final message: a three-line summary, then exactly `INTAKE {slug} READY`.
