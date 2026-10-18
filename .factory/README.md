# Claude bug-fix factory

Local tooling on branch `tooling/claude-factory` (never pushed). It takes one GitHub issue (read only) or a task file to a local `fix/<issue>-<slug>` branch that is ready for a **draft** PR against `main`: a failing test commit, a fix commit, verify-antseed evidence, three-model review, and a PR body with the verbatim red and green output. Every judgment step is a fresh Claude Code session pinned to the AntSeed peer GesundAI, in its own Herdr pane. Every gate is a script. No model decides whether a gate passed.

It replaces the codex/Prime factory imported in the first commit of this branch (codex/, machines/, the shape interview, mockups and verify-feature are gone). The Claude-only draft in `/root/.herdr/factory-draft` was the starting point for the scripts; see "What changed from the draft".

## Run it

From a Herdr pane in this worktree:

```
node .factory/factory.mjs run --slug <slug> --issue <n>              # or --task-file <file>
node .factory/factory.mjs run --slug <slug> --from verify             # resume at a stage (state in runs/<slug>/)
node .factory/factory.mjs run --slug <slug> --from red --until fix     # a range of stages
node .factory/factory.mjs status --slug <slug>
```

Each run lives in its own Herdr workspace: `--workspace <label>`, default `bug-<issue>` (or `<slug>` for a task file). The driver creates it, records its id in the run state, and reuses it on resume. It refuses a label that belongs to someone else's workspace. Every stage pane, the reviewers and the judge spawn there, and no other workspace is touched (`scripts/check-workspace.mjs` proves it). The run tab is `factory <slug>`. Its left pane follows `runs/<slug>/events.jsonl`; each session gets a pane next to it (the review round gets its own tab with three panes plus the judge). A pane closes when its session finished and passed its audit; a failed one stays open for inspection. `runs/<slug>/sessions.jsonl` has every session's settings file, transcript path, audit result and `claude --resume` command.

Publish is always a dry run: `publish.sh` refuses a real publish unless `--publish` is passed and `FACTORY_ALLOW_PUBLISH=1` is set, and nothing in this round sets either.

## Stages

| # | Stage | Who | pstack / repo skills (read by path) | Gate (script) | Launch command |
| --- | --- | --- | --- | --- | --- |
| 0 | preflight | `scripts/preflight.sh` | none | inside Herdr; claude, Node 24, Foundry, gh auth; the pstack skills exist; the sandbox stack has verify-antseed; every model in `inputs/models.json` answers a pinned ping through the audit proxy from GesundAI; the branch is not on the remote and has no PR | `scripts/preflight.sh <slug>` (run by `intake`) |
| 1 | intake | `scripts/intake.sh` (`gh issue view`, read only) + `scripts/worktree.sh` (fresh `origin/main`, `--no-track`, install, build) + Claude opus-5.5 | sharpen; poteto-mode bug-fix playbook (reproduce); principle-test-behavior-not-implementation; repo CLAUDE.md; verify-antseed "Decide what to prove" (unit unless only a sandbox scenario reproduces it) | fix worktree unchanged (HEAD and status); `test-plan.md` starts `Status: final`, has all 11 sections, a backticked Test command and Red signature, Proof `unit` or `sandbox: <scenario>`; `NOT_REPRODUCED` pauses (a finding). One retry. | `factory.mjs run --slug S --issue N --until intake` |
| 2 | red | Claude opus-5.5 | tdd; principle-test-behavior-not-implementation; principle-sequence-verifiable-units | `gate-red.sh`: exactly one commit, test files only, clean tree, no auto-close keyword; the Test command fails, the output contains the Red signature and no setup-error marker; output saved verbatim as `evidence/red.txt`. `NO_RED` pauses. One retry. | `--from red --until red` |
| 3 | fix | Claude opus-5.5 | principle-fix-root-causes; poteto-mode bug-fix playbook; typescript-best-practices; principle-subtract-before-you-add | `gate-green.sh fix`: clean; exactly two commits, no merges, commit 1 test-only, commit 2 touches source; no auto-close; red at commit 1 and green at HEAD, each in a fresh throwaway worktree with its own `pnpm install` (`red-green.sh`); tripwire. One retry. | `--from fix --until fix` |
| 4 | verify | `scripts/verify.sh` (+ merge-resolve session on scratch conflicts) then Claude opus-5.5 | verify-antseed (the only path -> scenario map, read from this branch) + sandbox-test (how to run); principle-prove-it-works; principle-explain-the-number | `verify-plan.mjs` maps the diff to the verify-antseed table (`inputs/verify-rows.json`), adds the keys/signing/spend-caps row for security-critical changes and the owning packages' test + typecheck; for sandbox rows: scratch worktree (sandbox stack + `origin/main` + the two commits), doctor first, every scenario without the fix (baseline, once per base) and with it, rebuild before each, `pnpm sandbox down`. `verify-gate.mjs`: all unit commands exit 0, doctor exit 0, each scenario exit 0 with the fix or failing identically without it (pre-existing, reported), torn down. Plus the session's `VERIFY <slug> PASS`. A failure pauses. | `--from verify --until verify` |
| 5 | blast radius | Claude opus-5.5 | blast-radius; how | fix worktree unchanged; `blast-radius.md`; answer `BLAST <slug> DONE` or `RISK <n>` (risks go to the reviewers) | `--from blast-radius --until blast-radius` |
| 6 | review | three Claude Code sessions in plan mode, read only, in parallel: claude-opus-5.5, claude-fable-5.1, gpt-6-astra; then a judge (opus-5.5, plan mode) | interrogate SKILL.md + references/reviewer-prompt.md, rubric.md, code-quality-review.md (reviewers); interrogate Steps 4-5 + references/lead-judgment.md (judge) | fix worktree unchanged; each reviewer answered; every session's audit on its own model; judge answers `JUDGE <slug> ACT_ON <n>`. n > 0: an act-on writer session fixes only the Act-on items, `gate-green.sh act-on-r<n>`, verify again, review again; at most 2 rounds, then pause. | `--from review --until review` |
| 7 | no-comments | Claude opus-5.5 (spawns `pstack:comment-sicko`, pinned) | no-comments; agents/comment-sicko.md | if the tree changed: `gate-green.sh no-comments` and verify again (label `nc`) | `--from no-comments --until no-comments` |
| 8 | publish | `scripts/publish.sh` (no model) | none | refuses unless the last green gate, verify gate, verify session and judgment (Act on 0) all hold for HEAD, the tree is clean, two commits, branch not on the remote, no PR. Writes `pr-body.md` (verbatim red and green, verify table and sandbox checks, review summary, blast-radius fact, security marker). Dry run prints the push and `gh pr create --draft --base main` commands and stops; `recheck.sh --dry-run` re-runs red at commit 1 and green at HEAD in fresh worktrees and prints the `gh pr view` checks it would make. | `--from publish --until publish` |
| 9 | reflect | Claude opus-5.5 | reflect (+ its references); correct; show-me-your-work audit | never blocks; runs after every run, failed or paused too. Writes `reflect.md`: proposals (Accepted / Rejected / Backlog) and mistake classes, nothing applied. | `--from reflect` |

After every session: the audit check (model, pin, peer per step tag) and a tripwire (`git ls-remote` and `gh pr list` for the branch). Throughout: `runs/<slug>/decisions.tsv` (show-me-your-work, written by the driver, the scripts and every session through pstack's `log.sh`), `events.jsonl`, `sessions.jsonl`, `audit-summary.md`, `outcome.md`.

## Sessions

`scripts/native-step.mjs` starts one session: `herdr agent start <name> --kind claude --pane <pane> -- claude --model <m> --settings <file> --session-id <uuid> --effort <e> --permission-mode <mode> --allowedTools ... --disallowedTools ... --add-dir <run dir> ...`, then `herdr agent prompt` with "Read <prompt file> and follow it". The prompt file is `prompts/_preamble.md` (the hard rules) plus the stage prompt, rendered into `runs/<slug>/prompts/`.

- **Writers**: `--permission-mode acceptEdits --allowedTools Bash Edit Write Read Glob Grep TodoWrite Task` (root refuses `--dangerously-skip-permissions`).
- **Readers** (reviewers, judge): `--permission-mode plan --allowedTools Read Grep Glob 'Bash(git diff:*)' 'Bash(git log:*)' 'Bash(git show:*)'`; Edit, Write, NotebookEdit, ExitPlanMode and Task disallowed. Their review is their final message, which the driver reads from the session transcript (`~/.claude/projects/<cwd>/<session-id>.jsonl`).
- **No push, by any route** (`lib/session-env.mjs`, proven by `scripts/check-push-gap.sh`). Five independent layers, each refusing alone: (1) permission deny rules for `git push` in every form (`git -C * push*`, `git * push *`), remote rewrites (`git remote set-url|add`, `git config *url*`), hooks and credentials config, inline `git -c`, `--no-verify`, every GitHub write in `gh` and `gh auth`; (2) `url.factory-blocked-push:///.pushInsteadOf` for `https://`, `http://`, `ssh://` and `git@`, so every push URL of every remote, even an inline `-c remote.origin.pushurl=<real>`, goes to a dead helper; (3) `remote.origin.pushurl` dead; (4) `core.hooksPath=.factory/hooks`, whose `pre-push` refuses unless `FACTORY_ALLOW_PUBLISH=1`; (5) no credentials: the github.com credential helpers are reset, `GH_TOKEN` is unusable, prompts and ssh are disabled. Also denied: `gh pr|issue|api|repo`, `pnpm sandbox mainnet`, `git stash`, AskUserQuestion, EnterPlanMode, WebFetch, WebSearch. Residual risk, stated plainly: a root session that deliberately runs `env -u GIT_CONFIG_COUNT -u GH_TOKEN git push` from a wrapper the deny patterns do not match (for example `bash -c`) would get the user's gh token from `~/.config/gh`; the tripwire after every step (`git ls-remote` plus `gh pr list`) would catch the result, not prevent it. Only a network namespace or a separate user would close that.
- **Model pin**: see `models.md`.
- **Folder trust**: a new worktree shows Claude Code's trust dialog, whose default is "No, exit". native-step selects "Yes, I trust this folder" because the factory created that folder.
- **Permission prompts never hang a session.** Claude Code asks before any write under the project's `.claude/` even in acceptEdits mode, and in 2.1.302 no allow rule (settings file or `--allowedTools`, absolute or `Edit(/.claude/**)`) satisfies that check. native-step detects prompts from the transcript (a Write/Edit without a tool_result, or Herdr `blocked`), not from the screen. Exactly one kind is answered: a file under the session's own write root's `.claude/` (stages that write product files: red, fix, act-on, no-comments, merge-resolve), with Claude Code's session grant (option 2). Every other prompt is refused with Escape and fails the step (native-step exit 5, a `permission prompt in <tag>` outcome). The stall nudge never presses Enter while a tool call is pending.
- **Completion**: Herdr reports idle or done twice in a row and the transcript ends with a finished assistant message.
- **Stalls**: if a session is not idle, makes no audit-log request and its transcript does not grow for `stall_min` (6) minutes, and no tool call is in flight, native-step saves the screen and presses Enter once (a notice overlay can hold a session). A second stall fails the step with a notification. Long builds or sandbox runs are tool calls in flight and do not count.

## Inputs (factory files, never committed to the repo or the sandbox branch)

- `inputs/models.json`: model, effort, mode and timeout per stage; stall minutes; review rounds.
- `inputs/verify-rows.json`: the verify-antseed table as data. `node scripts/verify-plan.mjs --audit` checks that every command still appears verbatim in the skill on the sandbox stack.
- `inputs/security-critical-paths.json`: 16 globs and 3 content markers (keys, signing, identity, payments, spend caps, contracts), each with a reason. A match forces the keys/signing/spend-caps row and flags the PR: `[security-critical] ` title prefix, a body marker, and the `security-critical` label if the repo has one (the factory never creates labels or edits issues). `node scripts/security-check.mjs --audit` checks every glob still matches a file on `origin/main`.
- `inputs/claude-md-invariants.md`: the proposed `## Invariants` section for the repo's CLAUDE.md, each invariant with what enforces it.

## NEEDS INPUT

When a stage hits something that is the human's call, or a finding (a bug that does not reproduce, a red that does not fail, a verify failure, Act-on items left after two rounds), the driver appends it to `runs/<slug>/NEEDS-INPUT.md`, sends a Herdr notification, stops the blocked stages, and still runs reflect. Sessions may append their own items and keep working on what is not blocked.

## Files

`factory.mjs` (driver), `lib/common.mjs`, `scripts/` (common.sh, intake.sh, preflight.sh, worktree.sh, native-step.mjs, gate-red.sh, gate-green.sh, red-green.sh, red-reason.sh, security-check.mjs, verify-plan.mjs, verify.sh, sandbox-scratch.sh, verify-gate.mjs, publish.sh, recheck.sh, audit-summary.mjs, pin-proxy.py), `prompts/` (\_preamble plus one per session kind), `inputs/`, `models.md`. Run state: `runs/<slug>/` (gitignored). A run's deliberate scope decisions go in `runs/<slug>/scope.json` (`decided_by`, `decision`, `left_unchanged[]` with `path`, `what`, `source`, and `reason`). The PR body states them under `## Fix` and fails if a listed path does not exist at HEAD.

Environment: `FACTORY_AUDIT_URL`, `FACTORY_AUDIT_LOG`, `FACTORY_WT_ROOT` (default `/root/.herdr/worktrees/antseed`), `FACTORY_SANDBOX_REF` (default `origin/codex/sandbox-stack`), `FACTORY_NODE_BIN`, `PSTACK_DIR`, `FACTORY_ALLOW_PUBLISH`.

## What changed from the draft

- Stages follow the brief: intake (sharpen into a test plan) replaces plan; red and fix are separate sessions with separate gates instead of one build step; blast radius is its own stage; no-comments and reflect are added.
- Review uses three models in separate sessions (the draft had three lenses on one model) and a reader permission mode; reviews come from the transcript, not from files the reviewer writes.
- The shared audit proxy on 18377 is used instead of a per-run proxy, and its log is checked per step tag; preflight pings every model, not only opus.
- Verify is a script first (rows from the table as data, doctor first, baseline without the fix, the rest with it) and a judging session second. The draft let a session drive the sandbox and trusted its report.
- Red has a "stated reason": the plan's Red signature must appear in the failing output, and setup errors do not count.
- The trust dialog, stall detection, unusable push URL and GitHub token, and the security-critical inputs are new.
