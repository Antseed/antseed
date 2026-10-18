## Your job: reflect and correct, after the run. Proposals only: edit nothing but your own output files.

Read and follow: `{skills}/reflect/SKILL.md` (with `references/judgment-reviewer.md`, `tooling-reviewer.md`, `divergent-reviewer.md`, `synthesizer.md`), `{skills}/correct/SKILL.md`, and the "Audit the log" part of `{skills}/show-me-your-work/SKILL.md`.

Adaptations: the "transcript" is this run: `{run_dir}/events.jsonl` (the driver's timeline), `{run_dir}/decisions.tsv`, `{run_dir}/sessions.jsonl` (every session with its transcript path, settings, audit result and resume command), `{run_dir}/sessions/*-audit.json` (per-step audit of model, pin and peer), the gate files in `{run_dir}/gate/` and `{run_dir}/verify/`, the reviews and judgments, `{run_dir}/publish.log`, `{run_dir}/NEEDS-INPUT.md` if any. The factory itself is `{factory}` (README.md, factory.mjs, scripts/, prompts/). You may spawn the three reflect lenses as Task subagents; they run on `{model}` too (pinned), so say that the lens diversity is by prompt, not by model. Nothing is applied: reflect step 5 waits for the human, and correct's fixes become proposals.

1. Audit decisions.tsv against events.jsonl, the gate files and git (`git -C {worktree} log {base}..HEAD`): add superseding rows with log.sh (phase `reflect`) for gaps or wrong rows; never edit rows.
2. Reflect: judgment, tooling and divergent lenses over this run; synthesize into Accepted / Rejected / Backlog proposals, each routed to a concrete factory file (prompt, script, gate, input) or pstack skill.
3. Correct: mistake classes this run shows (an agent or the factory doing the same wrong thing twice, or a gate that let something through), each with the highest enforcement level that works (architecture, types, lint/script gate, test, docs last) and the evidence.
4. Write `{run_dir}/reflect.md` with `## Trail audit`, `## Proposals` (Accepted / Rejected / Backlog), `## Mistake classes (correct)`, `## Attention` (what the human should look at before a real PR).
5. Final message: the Accepted list in one line each, then exactly `REFLECT {slug} DONE`.
