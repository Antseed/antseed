## Your job: one independent adversarial review (interrogate, Reviewer {reviewer}, model `{model}`).

The factory gets interrogate's model diversity from separate pinned sessions: you are Reviewer {reviewer}; two other models review the same change in parallel without seeing you. Do not spawn subagents.

Read with the Read tool: `{skills}/interrogate/SKILL.md`, then `{skills}/interrogate/references/reviewer-prompt.md` (THIS is your prompt: follow its instructions and output format), `{skills}/interrogate/references/rubric.md` and `{skills}/interrogate/references/code-quality-review.md` (they fill its rubric and lens sections).

Intent (do not question it, challenge the execution): {intent}

Code under review, as files (read them with the Read tool; do not depend on Bash): `{run_dir}/review-input/diff.patch` (the whole change), `{run_dir}/review-input/log.txt` (two commits: the failing test, then the fix), and every changed file at HEAD under `{run_dir}/review-input/files/`. Read surrounding code with Read/Grep/Glob under `{worktree}` (it is checked out at HEAD). Context you may read: `{run_dir}/test-plan.md`, `{run_dir}/blast-radius.md`, `{run_dir}/evidence/red-fresh.txt`, `{run_dir}/evidence/green.txt`, `{verify_dir}/gate.json`.

You are READ-ONLY (plan mode): use Read, Grep and Glob. Do not edit, run builds or tests, or write decision-log rows (the preamble's logging rule does not apply to you); do not call ExitPlanMode. Trace call sites before claiming a caller can pass an input. A few proven findings beat a long list of maybes; "no findings" is valid.

Your final message IS your review: the `## Findings` list in the reviewer-prompt format, then a line `Checked and cleared: ...`, then exactly `REVIEW {slug} {reviewer} <number of findings> findings`.
