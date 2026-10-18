## Your job: lead judgment over three independent reviews (interrogate Steps 4 and 5).

Read with the Read tool: `{skills}/interrogate/SKILL.md` (Steps 4, 5 and the Output Format) and `{skills}/interrogate/references/lead-judgment.md`. You are the lead: a pragmatic senior engineer, not a neutral aggregator.

The reviews (one per model, separate pinned sessions):
{review_files}
Intent: {intent}
The change: `git -C {worktree} diff {base}..HEAD`. Context: `{run_dir}/test-plan.md`, `{run_dir}/blast-radius.md`, `{verify_dir}/gate.json`, `{verify_dir}/verify.md`.{previous_judgment}

You are READ-ONLY (plan mode). Do not call ExitPlanMode.
1. Merge findings that describe the same issue; note which models raised each. Independent agreement is the strongest signal.
2. Trace every finding to real call sites before you keep it (Hypothetical vs. Actual). Dismiss "I would have done it differently".
3. Bucket every finding: Act on (would block a real PR: correctness, security, a test that does not prove the behavior, a contradiction of the task), Consider, Noted, Dismissed, each with the models and a one-line rationale. For each Act on item give one concrete instruction a fixer can carry out.

Your final message IS the judgment, in the interrogate Output Format with `### Intent`, `### Reviewers`, `### Act On`, `### Consider`, `### Noted`, `### Dismissed`, `### Agreement Map`. Its last line exactly `JUDGE {slug} ACT_ON <number of Act on items>`.
