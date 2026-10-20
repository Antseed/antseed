# AntSeed factory

Tooling on branch `tooling/claude-factory`. It takes one GitHub issue or task file to a local branch that is ready for a PR. It is pstack, run as is, plus what only AntSeed knows.

```
.factory/start.sh <slug> --issue <n>        # or --task-file <file>; run it again to resume
```

Run it inside Herdr, in a pane on this repo. It makes `fix-<slug>` next to this worktree from `origin/main`, writes `runs/<slug>/task.md`, opens pstack's orch store at `runs/<slug>/orch`, and starts one Claude Code session with `RUN.md` as its first message. You watch that pane. The session stops at ready, and you push. After the PR merges, remove the run's worktrees (`fix-<slug>`, `runs/<slug>/scratch`) per pstack's `playbooks/worktree-cleanup.md`.

## The process: pstack's steps, our dispatcher

- **pstack owns the steps.** The playbooks at `$PSTACK_DIR/skills/poteto-mode/playbooks/` are referenced, never copied.
- **We own the dispatcher.** `orchestrator.md` replaces poteto-mode's Playbooks section. It routes the task to a playbook (an architecture change goes to figure-it-out). It adds the overlays that apply to every run: area rules, high blast radius, and user-visible. It adds AntSeed's steps to named playbook steps. It owns verification and done (one swarm at the code-ready head, per Autopilot-full step 4) and how subagents are briefed (Orchestrate's brief, standing orders, a lead that keeps only summaries).
- **Changing the process.** Refine the factory process in `orchestrator.md`. Propose a change to a playbook's own steps upstream to pstack.

```
task ─► RUN.md ─► orchestrator.md (ours): route ─► pstack playbook steps ─► + our additions/overlays
                                                       │ reads area CLAUDE.md, verify-antseed
                                                       ▼
                                          orch ledger + gates ─► pr.md ─► operator pushes
```

## What is pstack and what is ours

pstack does the work. The factory is glue: it says where things are, maps pstack's Cursor names to Claude Code, and adds what only AntSeed knows.

| Piece | From | What it does |
| --- | --- | --- |
| poteto-mode, its playbooks and principles | pstack | Routes the task to a playbook (Bug fix, Feature, Refactoring, or figure-it-out for large work), runs it as an autonomous run, delegates to fresh subagents |
| interrogate, swarm, arena, architect, how, reflect, show-me-your-work | pstack | Review, verification lanes, design exploration, the decision trail, the retro |
| orch | pstack | The ledger (a verdict per head SHA) and the gates (questions for you, each with a default) |
| `RUN.md` | ours | The first message: the task, the exit condition, where AntSeed's files are, the Claude Code mapping |
| `orchestrator.md` | ours | The dispatcher: routing, overlays, AntSeed additions per playbook step, verification and done |
| `pstack-models.md` | ours | pstack's per-role model table (`pstack-models.mdc` in Cursor): opus writes code, astra verifies, panels mix opus, fable, astra and sol |
| `plugin/agents/` | ours | `astra` and `sol` pin a role to `gpt-6-astra` or `gpt-6.1-sol`. `reviewer`, `astra-reviewer` and `sol-reviewer` are the read-only versions (pstack's `readonly: true`). Opus is the parent model, fable is `model: "fable"` |
| `start.sh` | ours | Worktree, task file, orch store, session settings (model pin, no push, Bash sandbox), then `claude` with pstack and this plugin. `FACTORY_RESUME=<session id>` reopens a run's session with the current settings |
| `.claude/skills/verify-antseed` | ours | pstack's verification skill shape: what to run per changed path, the `features/` map, what counts as proof, high blast radius paths, `prove.sh` |
| root `CLAUDE.md` Design principles and Invariants, `packages/*/CLAUDE.md`, `apps/*/CLAUDE.md`, `plugins/CLAUDE.md` | ours | The architecture knowledge: the philosophy and repo-wide rules once, then per area only what is specific to it (what it owns, why, its rules, what to ask first) |

## Where each rule lives

- **Must hold.** A script or a setting enforces it. Session settings (`start.sh`): every model request goes to the AntSeed buyer pinned to GesundAI; Bash runs in Claude Code's sandbox; git cannot push; GitHub writes, mainnet, `--real-funds`, `--live` and `~/.antseed` are denied. `prove.sh` decides red and green mechanically.
- **You want a say.** An area's "Ask first" line. The session parks an orch gate with its default, keeps working, and wakes when you answer: `bun <pstack>/skills/poteto-mode/scripts/orch/orch.ts --store runs/<slug>/orch gate resolve <id> --answer "<answer>"`, or type into the session.
- **Preference.** pstack's principles and the area guides. The lead puts a broken principle or rule in Act on.

## Files

- `start.sh`, `RUN.md`, `orchestrator.md`, `pstack-models.md`
- `plugin/`: a Claude Code plugin (its own folder: a plugin dir is read-only to the session, and `runs/` must stay writable)
- `git-hooks/pre-push`
- `sandbox-run.sh`: one `--chain local` scenario run, outside the Bash sandbox
- `check-push-gap.sh`: pushes to a local fixture and proves every known route is refused under the session settings
- `runs/<slug>/` (gitignored): `task.md`, `settings.json`, `orch/` (`ledger.tsv`, `gates.md`, `preferences.md` with the standing orders start.sh seeds), and what the session writes (`todo.md`, `decisions.tsv`, `verify-<sha>.md`, `pr.md`, `reflect.md`, `resume.md`)

Environment: `PSTACK_DIR` (default `~/.local/share/pstack/0.15.25`), `FACTORY_MODEL_URL` (default `http://127.0.0.1:8377`, the AntSeed buyer), `FACTORY_LEAD_MODEL` (default `claude-opus-5.5`). Needs `claude`, `bun`, `gh` (read only) and Node 24.

## Known limits

- Bash runs in Claude Code's sandbox (`sandbox` in the session settings): writes go only to the worktree, its git data, the run dir, the pnpm store and `~/.antseed-sandbox`, and the network reaches only the npm registry and localhost. Checked by hand on 2.1.303: a write to `~` failed, a commit in the worktree and `registry.npmjs.org` worked, and `api.github.com` was blocked. `sandbox-run.sh` is the one command in `sandbox.excludedCommands`: forge panics inside the macOS sandbox, so a `--chain local` scenario run goes outside it. It refuses `--live`, `--real-funds` and mainnet. Checked on 2.1.305: `payment-flow` passed through it from a headless session, while a plain `run-with-evidence.mjs` call in the same session failed with forge SIGABRT.
- localhost is open, so a command could still reach the operator's buyer on 8377 and spend from it. The deny rule `Bash(*:8377*)` catches the plain case only. `~/.antseed` and the keychain are guarded by deny rules and the sandbox write list, not by a read block.
- The git no-push env is a speed bump. `check-push-gap.sh` shows that `env -u GIT_CONFIG_COUNT` removes it. With no GitHub credentials in the session and GitHub off the network list, a push still has nowhere to go.
- Only a separate OS user or a VM is a full boundary.
- The model pin is set once for the whole session. Nothing audits it per request.
