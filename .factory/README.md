# Agent factory

How agents build changes in this repo. Prime Agent runs the workflow; each step is a sub-agent with its own model and a fixed list of skills.

## Run it

One task, one worktree, one Herdr subproject. Two commands, with you in between:

```
.factory/scripts/factory-shape.sh <slug> "a vague idea in one sentence"   # interview -> brief.md
.factory/scripts/factory-start.sh <slug>                                   # plan -> build -> review -> verify
```

**Shape (the interview).** The task can be one vague sentence. The shaper (Claude Code, opus, `.agents/skills/explore-unknowns` adapted from dzhng/skills) first researches on its own: the code (`how`), what happens today (it runs it), prior art, what could break (`blast-radius`), and for anything visible a sandbox screenshot plus 2-3 mockups (`ui-mockup`). Then it interviews you in its pane in the task's `factory` tab. Herdr notifies you and marks the pane as waiting. It asks one question at a time, with lettered options and its recommendation, so you can answer with a letter (or `ok`). It goes through four stages: what's settled, open questions, your unstated taste, and landmines. After about five answers it offers to answer the rest for you, based on the preferences it has seen. It only does that if you say yes, and each such answer is labeled. Type `defaults`, `skip to map` or `stop` at any time. It writes `tasks/<slug>/brief.md` with acceptance criteria in your words and a decision ledger (each decision, why, and who made it). You can leave and come back; the pane waits. `factory-shape.sh --auto` skips the questions and decides with its recommendations. For small, clear tasks skip shaping: `factory-start.sh <slug> <task file>`.

`factory-start` refuses to build while the interview isn't finished or has OPEN decisions (`--force` overrides).

**Your wishes all the way through.** The plan quotes every acceptance criterion from the task and brief word for word. The builder logs every decision the plan didn't settle in `tasks/<slug>/choices.md` with its confidence; `check.sh` fails without it. Review audits each choice (`ok`, `question`, `contradicts` = blocking, plus `unlogged` choices it finds in the diff). Verify checks your criteria and decisions as you wrote them, not the plan's version. `verify.md` opens with "Your wishes" (✓/✗ per wish with evidence) and "Choices the agents made for you" (least confident first), and the notification says how many wishes were met and how many choices to look at.

Both commands use `scripts/factory-worktree.sh`: the first one creates `../factory-<slug>` on branch `factory/<slug>`, copies this worktree's uncommitted changes and `.env.local` into it, opens it as its own Herdr workspace with a `factory` tab, then installs and builds on Node 24; the second reuses it. `factory-start` then starts Prime in that tab and starts the run. Tasks in different worktrees run in parallel.

**When something goes wrong, you hear about it.** `factory-start` runs the factory through `scripts/factory_run.py`, which also starts a watcher in the lead's kernel. It logs every run event to `tasks/<slug>/events.jsonl`. When the run ends, fails or pauses, it writes `tasks/<slug>/outcome.md` (PASS / FAILED / PAUSED plus the reason) and sends a Herdr notification. A run only counts as PASS when verify answered `VERIFY <slug> PASS`; "finished" with nothing built is FAILED.

**Plan can't lose its work.** The planner writes a draft `plan.md` (`Status: draft`, `TODO:` where unknown) in its first few tool calls and rewrites it after each finding. Scouts write to `tasks/<slug>/scouts/<area>-<model>.md`, and existing reports are reused instead of re-scouted. After plan, `plan-check` (`scripts/plan-check.mjs`) reads `plan.md` from disk, not the planner's reply: `Status: final`, no TODO and all required sections go to build. Otherwise plan runs once more and continues from its draft. This covers the empty replies and worker crashes that killed earlier runs.

When it finishes:

```
.factory/scripts/factory-finish.sh <slug>                # writes /tmp/factory-<slug>.patch with only the task's changes
git apply /tmp/factory-<slug>.patch                       # in whichever worktree should get the change
```

Nothing is committed. Remove the worktree with `herdr worktree remove` when you are done.

Manual run in the current worktree: put the task in `.factory/current-task.md`, then in Prime: `from rlm.factory import import_machine; import_machine(".factory/machines/tdd-factory/MACHINE.md"); await rlm.factory.run("tdd-factory")`.

Watch: every native step opens a pane next to the Prime lead, labelled `<step> <round> · <agent> · <model>` (e.g. `build 1 · codex · gpt-6.1-sol·medium`). The previous step's pane closes when the next one opens. herdr-radar marks each pane working, waiting on you (`?`) or done. `tasks/<slug>/sessions.jsonl` lists every session with its resume command (`codex resume <id>` / `claude --resume <id>`).

Prerequisites: the AntSeed buyer on 8377 with GesundAI reachable, the `gesundai` provider in `~/.prime/agent/models.json` (see `models.md`), `claude` and `codex` on PATH, Node 24 under Volta.

## Workflow

```
(shape: brief + mockups, you answer)
   │
plan ──> build ──> review ──(pass)──> verify ──(pass)──> done: notification + report/video
           ^          │                   │
           └─(fail)───┴───────(fail)──────┘   at most 3 builds
```

| Step | Plain meaning | Model | Must use these skills | Writes |
|---|---|---|---|---|
| shape (before the run, interview) | What does the user really want? How do others do it, what could it look like? | Claude Code, opus (in a Herdr pane, talks to you) | `explore-unknowns`, `how`, `blast-radius`, `ui-mockup` (UI), `unslop` | `brief.md` (acceptance criteria, decision ledger), `design/` |
| plan (read-only) | What changes, what exactly does the user see, and how will we know it works? | Prime, opus | `how`, `blast-radius`, `principle-model-the-domain`, `principle-subtract-before-you-add` | `plan.md` with user-facing copy, gate commands, acceptance checks and visual target |
| plan-check | Is plan.md really finished? | script (`plan-check.mjs`), sonnet low runner | none | `PLAN <slug> …` to build, or `PLAN_MISSING` back to plan (once) |
| build | Failing test first, then the smallest fix | Codex, gpt-6.1-sol (in a Herdr pane) | `tdd`, `typescript-best-practices`, `principle-type-system-discipline`, `principle-test-behavior-not-implementation`, `principle-fix-root-causes` | code, tests, scenarios, `build.md`, `choices.md` |
| review (fresh, no edits) | Is the code right? | `scripts/check.sh`, then Claude Code, opus (in a Herdr pane) | `principle-prove-it-works`, `unslop`, interrogate's rubric | `checks.json`, `review.json` (incl. choice verdicts), `review.md` |
| verify (fresh, no edits) | Does it work for a user, and does it make sense? | Claude Code, opus (in a Herdr pane) | `verify-feature`, `sandbox-test`, `principle-prove-it-works`, `unslop` | `verify.json` (incl. wishes), `verify.md` (wishes and choices first), sandbox report + video |

- Review: first `scripts/check.sh <slug>` runs the checks that need no judgment, on Node 24, and writes `checks.json`: scope (only the build's files changed against the baseline), tests are real (`scripts/prove-tests-fail.sh` checks the new tests fail without the fix in a throwaway worktree, never `git stash`), and every gate command. Then one reviewer (Claude, so a different family from the GPT builder) reads the diff and tries to reproduce bugs. A concrete bug with a repro blocks; taste notes do not. Text that matches the plan's user-facing copy is not a finding.
- Verify runs the plan's acceptance checks against the real thing: sandbox scenarios (`pnpm sandbox`, mocks only, never `--live`), the built CLI against the sandbox buyer, or desktop scenarios with screenshots and video. For UI tasks it screenshots the changed screen and has a vision model compare before, mockup and after (`scripts/describe-image.mjs`).

Models and fallbacks: `models.md`.

## Native steps

`scripts/native-step.mjs` runs one step in a native harness: `--agent codex` (build) or `--agent claude` (review, verify). It fills the step's template from `prompts/<step>.md` into `tasks/<slug>/<step>.prompt.md`, splits a pane next to the Prime lead, starts the agent pinned to GesundAI with Node 24 on its shell PATH and no permission prompts, sends the prompt, waits until the agent is idle (it keeps waiting if you move the pane), records the session in `sessions.jsonl`, and prints `ANSWER <line>` from the last result line of the step's file (`build.md`, `review.md`, `verify.md`), only if the step rewrote that file. The Prime state for each native step is a thin runner: one command, then it repeats the ANSWER line. It also keeps the Mac awake while a step runs. If an agent stops to ask something, you get a Herdr notification.

## Output size limit

Prime keeps only about 160 characters of each step's final answer and passes that to the next step. So each step ends with one line (`PLAN <slug> <path>`, `BUILD <slug> GREEN`, `REVIEW <slug> PASS`, `VERIFY <slug> PASS`, or a `*_FAIL` form that loops back to build) and writes everything else to `.factory/tasks/<slug>/`.

## Where things live

| Layer | Place | Answers |
|---|---|---|
| Workflow | `machines/tdd-factory/MACHINE.md` | which step runs when, which model, when to loop |
| Step role | `prompts/<step>.md` for native steps; the plan prompt in the machine | what this step does, its limits, its output |
| Method | `.agents/skills/<name>/SKILL.md` | how to do one technique |
| Shared rules | `CLAUDE.md` / `AGENTS.md` | rules for every session |
| Task state | `tasks/<slug>/` (gitignored) | plan, build notes, review and verify reports, evidence |

## After a run

Run the `correct` skill when agents keep repeating the same mistake. It turns the mistake into a type, lint or test so it can't happen again.

pstack skills are adapted from cursor/plugins (MIT, Lauren Tan). See `.agents/skills/PSTACK-LICENSE`. `explore-unknowns` is from dzhng/skills (MIT, David Zhang), license in its folder.
