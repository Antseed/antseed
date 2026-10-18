# Models

Every session is Claude Code, pinned to the AntSeed peer GesundAI (`983e9de990b9ac8d36d373db5d0b49a4d7f7d826`) through the local audit proxy. There is no fallback: if GesundAI or a model is down, preflight fails and the run does not start. Codex and Prime are not used. The source of truth is `inputs/models.json`; this page explains it.

| Stage | Model | Effort | Mode | Timeout |
| --- | --- | --- | --- | --- |
| intake | claude-opus-5.5 | high | writer, read-only gate on the fix worktree | 30 min |
| red | claude-opus-5.5 | high | writer | 40 min |
| fix | claude-opus-5.5 | high | writer | 45 min |
| merge-resolve (only on scratch merge conflicts) | claude-opus-5.5 | high | writer, scratch worktree only | 30 min |
| verify | claude-opus-5.5 | medium | writer, read-only gate on the fix worktree | 60 min |
| blast-radius | claude-opus-5.5 | high | writer, read-only gate on the fix worktree | 40 min |
| review A / B / C | claude-opus-5.5 / claude-fable-5.1 / gpt-6-astra | high | reader (plan mode) | 40 min |
| judge | claude-opus-5.5 | high | reader (plan mode) | 30 min |
| act-on | claude-opus-5.5 | high | writer | 45 min |
| no-comments | claude-opus-5.5 | medium | writer | 30 min |
| reflect | claude-opus-5.5 | medium | writer (its own files only) | 40 min |

## Why the three reviewers are separate sessions

pstack `interrogate` gets its adversarial signal from model diversity. Subagents inherit their parent's model (here `CLAUDE_CODE_SUBAGENT_MODEL` is pinned to the session model on purpose), so three subagents of one session would be one model three times. The review stage therefore starts three sessions, each with its own settings file and its own model, in parallel panes of a review tab. `gpt-6-astra` is served by GesundAI on the Anthropic Messages API through the buyer, so Claude Code drives it unchanged.

Other pstack skills that ask for several model families (reflect's lenses, show-me-your-work's cross-model trail review, blast-radius's arena) run inside one session here, on that session's model. The prompts say so instead of pretending otherwise.

## How the pin is enforced and checked

`scripts/native-step.mjs` writes one `--settings` file per session:

- `ANTHROPIC_BASE_URL` = the audit proxy (`FACTORY_AUDIT_URL`, default `http://127.0.0.1:18377`), which forwards to the buyer on 8377 and logs one JSON line per request (`step`, `pin`, `model`, `status`, `peer`, `service`) to `FACTORY_AUDIT_LOG` (default `/root/.herdr/sandbox-verify-skill-pin.jsonl`).
- `ANTHROPIC_CUSTOM_HEADERS`: `x-antseed-system-proxy-source: claude-code`, `x-antseed-pin-peer: <GesundAI>`, `x-factory-step: <slug>/<stage>-r<n>.<id>` (unique per session).
- `ANTHROPIC_MODEL` and every alias (`ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) = the session's model, so no request and no subagent can drift. `DISABLE_AUTOUPDATER=1`.
- A settings file is needed because `~/.claude/settings.json` sets its own `env`; `--settings` has higher precedence. The user's settings file is never edited.

After each session the step's audit rows are checked: at least one `/v1/messages` request, every row on the session's model with the GesundAI pin and source `claude-code`, every answered message request answered by GesundAI. A violation fails the run (native-step exit 2). `count_tokens` rows are answered locally by the buyer and carry no peer; that is expected. Non-200 rows are counted and reported, not failed: Claude Code's plan-mode safety classifier gets a 400 from `gpt-6-astra` (seen in the smoke test), which only means that reviewer cannot run unlisted Bash commands. `scripts/audit-summary.mjs <slug>` prints the per-tag table. `scripts/pin-proxy.py` is a copy of the proxy for when 18377 is not running (`python3 .factory/scripts/pin-proxy.py 18377 <log>`).
