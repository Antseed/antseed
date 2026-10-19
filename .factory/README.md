# AntSeed factory

Local tooling on branch `tooling/claude-factory`, never pushed. It takes one GitHub issue or task file to a local branch that is ready for a PR. It is pstack, run as is, plus what only AntSeed knows.

```
.factory/start.sh <slug> --issue <n>        # or --task-file <file>; run it again to resume
```

Run it inside Herdr, in a pane on this repo. It makes `fix-<slug>` next to this worktree from `origin/main`, writes `runs/<slug>/task.md`, opens pstack's orch store at `runs/<slug>/orch`, and starts one Claude Code session with `RUN.md` as its first message. You watch that pane. The session stops at ready, and you push.

## What is pstack and what is ours

pstack does the work. The factory is glue: it says where things are, maps pstack's Cursor names to Claude Code, and adds what only AntSeed knows.

| Piece | From | What it does |
| --- | --- | --- |
| poteto-mode, its playbooks and principles | pstack | Routes the task to a playbook (Bug fix, Feature, Refactoring, or figure-it-out for large work), runs it as an autonomous run, delegates to fresh subagents |
| interrogate, swarm, arena, architect, how, reflect, show-me-your-work | pstack | Review, verification lanes, design exploration, the decision trail, the retro |
| orch | pstack | The ledger (a verdict per head SHA) and the gates (questions for you, each with a default) |
| `RUN.md` | ours | The first message: the task, the exit condition, where AntSeed's files are, the Claude Code mapping |
| `pstack-models.md` | ours | pstack's per-role model table (`pstack-models.mdc` in Cursor): opus writes code, astra verifies, panels mix opus, fable, astra and sol |
| `agents/astra.md`, `agents/sol.md` | ours | Two general agents pinned to `gpt-6-astra` and `gpt-6.1-sol`, so a role can run on an OpenAI model. Opus is the parent model, fable is `model: "fable"` |
| `start.sh` | ours | Worktree, task file, orch store, session settings (model pin, no push, Bash sandbox), then `claude` with pstack and this plugin |
| `.claude/skills/verify-antseed` | ours | pstack's verification skill shape: what to run per changed path, the `features/` map, what counts as proof, security-critical paths, `prove.sh` |
| `packages/*/CLAUDE.md`, `apps/*/CLAUDE.md` | ours | Per area: what it owns, its boundaries, its invariants and what enforces each, what to ask first |

## Where each rule lives

- **Must hold.** A script or a setting enforces it. Session settings (`start.sh`): every model request goes to the AntSeed buyer pinned to GesundAI; Bash runs in Claude Code's sandbox; git cannot push; GitHub writes, mainnet, `--real-funds`, `--live` and `~/.antseed` are denied. `prove.sh` decides red and green mechanically.
- **You want a say.** An area's "Ask first" line. The session parks an orch gate with its default, keeps working, and wakes when you answer: `bun <pstack>/skills/poteto-mode/scripts/orch/orch.ts --store runs/<slug>/orch gate resolve <id> --answer "<answer>"`, or type into the session.
- **Preference.** pstack's principles and the area guides. The lead puts a broken Boundary or Invariant in Act on.

## Files

- `start.sh`, `RUN.md`, `pstack-models.md`
- `.claude-plugin/plugin.json` and `agents/`: this folder is a Claude Code plugin
- `git-hooks/pre-push`
- `check-push-gap.sh`: pushes to a local fixture and proves every known route is refused under the session settings
- `proposed-invariants.md`: the `## Invariants` section proposed for the root `CLAUDE.md`
- `runs/<slug>/` (gitignored): `task.md`, `settings.json`, `orch/` (`ledger.tsv`, `gates.md`), and what the session writes (`todo.md`, `decisions.tsv`, `verify-<sha>.md`, `pr.md`, `reflect.md`, `resume.md`)

Environment: `PSTACK_DIR` (default `~/.local/share/pstack/0.15.25`), `FACTORY_MODEL_URL` (default `http://127.0.0.1:8377`, the AntSeed buyer), `FACTORY_LEAD_MODEL` (default `claude-opus-5.5`). Needs `claude`, `bun`, `gh` (read only) and Node 24.

## Known limits

- Bash runs in Claude Code's sandbox (`sandbox` in the session settings): writes go only to the worktree, its git data, the run dir, the pnpm store and `~/.antseed-sandbox`, and the network reaches only the npm registry and localhost. Checked by hand on 2.1.303: a write to `~` failed, a commit in the worktree and `registry.npmjs.org` worked, and `api.github.com` was blocked.
- localhost is open, so a command could still reach the operator's buyer on 8377 and spend from it. The deny rule `Bash(*:8377*)` catches the plain case only. `~/.antseed` and the keychain are guarded by deny rules and the sandbox write list, not by a read block.
- The git no-push env is a speed bump. `check-push-gap.sh` shows that `env -u GIT_CONFIG_COUNT` removes it. With no GitHub credentials in the session and GitHub off the network list, a push still has nowhere to go.
- Only a separate OS user or a VM is a full boundary.
- The model pin is set once for the whole session. Nothing audits it per request.
