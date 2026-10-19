#!/usr/bin/env bash
# Start one factory run: a lead Claude Code session that runs pstack's poteto-mode on one task, in this pane.
# Usage: .factory/start.sh <slug> --issue <n> | --task-file <file>
#        .factory/start.sh --settings <file>      write only the session settings (check-push-gap.sh uses this)
# It makes the fix worktree from origin/main, writes the task, opens pstack's orch store, writes the settings (model
# pin, no push, no GitHub writes) and starts claude with pstack and the factory's reviewer agents loaded.
# Every step is skipped when already done, so running it again after a partial start or to resume is safe.
set -euo pipefail
FACTORY="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$FACTORY")"
PSTACK="${PSTACK_DIR:-$HOME/.local/share/pstack/0.15.25}"
MODEL_URL="${FACTORY_MODEL_URL:-http://127.0.0.1:8377}"       # the operator's AntSeed buyer, used as the model endpoint
LEAD="${FACTORY_LEAD_MODEL:-claude-opus-5.5}"
GESUNDAI=983e9de990b9ac8d36d373db5d0b49a4d7f7d826
die() { echo "start.sh: $*" >&2; exit 1; }

settings() { # settings <file> [worktree run-dir]: env (model pin, git that cannot push, no GitHub token), deny rules, and
  # with a worktree the Bash sandbox: writes only to the worktree, its git data, the run dir, the pnpm store and the
  # sandbox's report dir; network only to the npm registry and localhost (the buyer, Anvil, the sandbox nodes).
  local gitdir='' common='' store=''
  if [ -n "${2:-}" ]; then
    gitdir="$(git -C "$2" rev-parse --absolute-git-dir)"; common="$(cd "$(git -C "$2" rev-parse --git-common-dir)" && pwd -P)"
    store="$(pnpm store path 2>/dev/null || true)"
  fi
  node - "$1" "$FACTORY" "$MODEL_URL" "$GESUNDAI" "$LEAD" "$gitdir" "$common" "${3:-}" "$store" <<'JS'
const [file, factory, url, peer, lead, gitdir, common, run, store] = process.argv.slice(2)
const dead = 'factory-blocked-push:///'
const git = [
  ...['https://', 'http://', 'ssh://', 'git@', 'git://', 'file://', '/'].map((p) => [`url.${dead}.pushInsteadOf`, p]),
  ['remote.origin.pushurl', dead], ['core.hooksPath', `${factory}/git-hooks`],
  ['credential.helper', ''], ['credential.https://github.com.helper', ''],
]
const env = {
  ANTHROPIC_BASE_URL: url,
  // The buyer strips credentials before a seller sees them, so a placeholder keeps the session off the operator's login.
  ANTHROPIC_AUTH_TOKEN: 'factory-buyer-strips-this',
  ANTHROPIC_CUSTOM_HEADERS: `x-antseed-system-proxy-source: claude-code\nx-antseed-pin-peer: ${peer}`,
  // Aliases (opus, sonnet, haiku, the small fast model) resolve to the lead model, so no request leaves the pin.
  ANTHROPIC_DEFAULT_MODEL: lead, ANTHROPIC_DEFAULT_OPUS_MODEL: lead, ANTHROPIC_DEFAULT_SONNET_MODEL: lead, ANTHROPIC_DEFAULT_HAIKU_MODEL: lead,
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5.1', ANTHROPIC_SMALL_FAST_MODEL: lead, CLAUDE_CODE_SUBAGENT_MODEL: lead,
  CLAUDE_CODE_AUTO_MODE_MODEL: lead, CLAUDE_CODE_BG_CLASSIFIER_MODEL: lead, CLAUDE_CODE_NO_MODEL_FALLBACK: '1', CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
  DISABLE_AUTOUPDATER: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false',
  GIT_SSH_COMMAND: '/bin/false', GH_TOKEN: 'factory-sessions-have-no-github-access', GIT_CONFIG_COUNT: String(git.length),
}
git.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v })
const deny = [
  'Bash(git push:*)', 'Bash(git push)', 'Bash(git -C * push*)', 'Bash(git * push *)', 'Bash(git * push)',
  'Bash(git remote set-url*)', 'Bash(git remote add*)', 'Bash(git -C * remote set-url*)', 'Bash(git -C * remote add*)',
  'Bash(git config *url*)', 'Bash(git -C * config *url*)', 'Bash(git config *hooksPath*)', 'Bash(git -C * config *hooksPath*)',
  'Bash(git config *credential*)', 'Bash(git -C * config *credential*)', 'Bash(git -c *)', 'Bash(git -C * -c *)', 'Bash(git * --no-verify*)',
  'Bash(gh pr:*)', 'Bash(gh issue:*)', 'Bash(gh api:*)', 'Bash(gh repo:*)', 'Bash(gh auth:*)', 'Bash(git stash:*)',
  'Bash(pnpm sandbox mainnet:*)', 'Bash(*--real-funds*)', 'Bash(*--chain mainnet*)', 'Bash(*--live*)',
  'Bash(*.antseed/*)', 'Bash(*.antseed)', 'Bash(*.antseed *)', 'Bash(security *)', 'Bash(*:8377*)',
  'Read(~/.antseed/**)', 'Edit(~/.antseed/**)', 'WebFetch', 'WebSearch',
]
const allow = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Agent', 'Skill', 'TodoWrite', 'ScheduleWakeup', 'Monitor']
const out = { env, permissions: { allow, deny } }
if (gitdir) {
  const home = require('os').homedir()
  out.sandbox = {
    enabled: true, allowUnsandboxedCommands: false,
    filesystem: { allowWrite: [gitdir, `${common}/objects`, `${common}/refs`, `${common}/logs`, `${common}/worktrees`, run, `${home}/.antseed-sandbox`, store].filter(Boolean) },
    network: { allowedDomains: ['registry.npmjs.org', 'localhost', '127.0.0.1'], allowLocalBinding: true },
  }
}
require('fs').writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
JS
}
if [ "${1:-}" = --settings ]; then settings "$2"; exit 0; fi

slug="${1:-}"; mode="${2:-}"; ref="${3:-}"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "usage: start.sh <kebab-slug> --issue <n> | --task-file <file>"
[ "$mode" != --issue ] || [[ "$ref" =~ ^[1-9][0-9]*$ ]] || die "--issue takes an issue number"
[ -f "$PSTACK/skills/poteto-mode/SKILL.md" ] || die "pstack not found at $PSTACK (set PSTACK_DIR)"
for f in CLAUDE.md .claude/skills/verify-antseed/SKILL.md .claude/skills/verify-antseed/scripts/prove.sh; do
  [ -f "$REPO/$f" ] || die "$REPO/$f is missing: run from the tooling checkout"
done
for c in claude bun gh node; do command -v "$c" >/dev/null || die "$c is required"; done
models="$(curl -fsS -m 10 "$MODEL_URL/v1/models")" || die "the AntSeed buyer at $MODEL_URL does not answer"
for m in "$LEAD" claude-fable-5.1 gpt-6-astra gpt-6.1-sol; do
  printf '%s' "$models" | node -e 'const [m,p]=process.argv.slice(1);const d=JSON.parse(require("fs").readFileSync(0,"utf8"))
process.exit(d.data.some(x=>x.id===m&&x.peers.some(q=>q.peerId===p))?0:1)' "$m" "$GESUNDAI" || die "GesundAI does not serve $m right now"
done
run="$FACTORY/runs/$slug"; wt="$(dirname "$REPO")/fix-$slug"; branch="fix/$slug"
orch() { bun "$PSTACK/skills/poteto-mode/scripts/orch/orch.ts" --store "$run/orch" "$@"; }

mkdir -p "$run/briefs" "$run/replies"
if [ ! -s "$run/task.md" ]; then
  case "$mode" in
    --issue) (cd "$REPO" && gh issue view "$ref" --json number,title,url,body \
               --jq '"# \(.title)\n\nIssue #\(.number): \(.url) (read only: never comment on, edit or close it)\n\n\(.body)"') > "$run/task.md.tmp"
             echo "$ref" > "$run/issue" ;;
    --task-file) cp "$ref" "$run/task.md.tmp" ;;
    *) die "usage: start.sh <slug> --issue <n> | --task-file <file>" ;;
  esac
  mv "$run/task.md.tmp" "$run/task.md"
fi
if [ ! -s "$run/base" ]; then git -C "$REPO" fetch -q origin; git -C "$REPO" rev-parse origin/main > "$run/base"; fi
[ -d "$wt" ] || git -C "$REPO" worktree add -q --no-track -b "$branch" "$wt" "$(cat "$run/base")"
[ -f "$run/orch/ledger.tsv" ] || orch init >/dev/null
key=1; [ -f "$run/issue" ] && key="$(cat "$run/issue")"
settings "$run/settings.json" "$wt" "$run"

prompt="$(node -e 'const fs=require("fs");const [f,...kv]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8")
for(let i=0;i<kv.length;i+=2)s=s.split("{"+kv[i]+"}").join(kv[i+1]);process.stdout.write(s)' "$FACTORY/RUN.md" \
  slug "$slug" run "$run" worktree "$wt" branch "$branch" base "$(cat "$run/base")" key "$key" pstack "$PSTACK" \
  factory "$FACTORY" tools "$REPO")"
flags=(--model "$LEAD" --settings "$run/settings.json" --setting-sources project,local --strict-mcp-config
  --plugin-dir "$PSTACK" --plugin-dir "$FACTORY/plugin" --add-dir "$run" --add-dir "$PSTACK" --add-dir "$REPO"
  --permission-mode acceptEdits -n "factory $slug")
cd "$wt"
# FACTORY_RESUME=<session id> reopens a run's session with today's settings and flags (after a restart or a fix here).
if [ -n "${FACTORY_RESUME:-}" ]; then
  exec claude "${flags[@]}" --resume "$FACTORY_RESUME" "The factory restarted this session with updated settings. Continue the run where you left off."
fi
echo "Task ($run/task.md):"; sed -n 1,15p "$run/task.md"; read -r -p "Start the run? [Enter] " _
exec claude "${flags[@]}" "$prompt"
