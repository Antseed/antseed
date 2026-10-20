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
retry() { local i; for i in 1 2 3; do "$@" && return 0; echo "start.sh: retrying ($i/3): $*" >&2; sleep 5; done; return 1; }
export GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=30   # a stalled GitHub transfer fails fast and gets retried

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
  // agent-browser keeps its daemon socket and state under ~/.agent-browser by default, which the sandbox can't write.
  // prove.sh makes its throwaway worktree here; the default temp folder is outside what the sandbox can write.
  ...(run ? { PROVE_TMP: `${run}/prove` } : {}),
  ...(run ? { AGENT_BROWSER_SOCKET_DIR: `${run}/agent-browser`, AGENT_BROWSER_STATE: `${run}/agent-browser/state.json` } : {}),
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
    // agent-browser's daemon talks over a Unix socket in the run dir; only that folder is allowed.
    network: { allowedDomains: ['registry.npmjs.org', 'localhost', '127.0.0.1'], allowLocalBinding: true, allowUnixSockets: [`${run}/agent-browser`] },
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
process.exit(d.data.some(x=>(x.id===m||(x.aliases||[]).includes(m))&&x.peers.some(q=>q.peerId===p))?0:1)' "$m" "$GESUNDAI" ||
    die "GesundAI does not serve $m right now"   # the buyer's canonical id flips between 5.5 and 5-5, so match aliases too
done
run="$FACTORY/runs/$slug"; wt="$(dirname "$REPO")/fix-$slug"; branch="fix/$slug"
orch() { bun "$PSTACK/skills/poteto-mode/scripts/orch/orch.ts" --store "$run/orch" "$@"; }

mkdir -p "$run/briefs" "$run/replies"
if [ ! -s "$run/task.md" ]; then
  case "$mode" in
    --issue) (cd "$REPO" && retry gh issue view "$ref" --json number,title,url,body \
               --jq '"# \(.title)\n\nIssue #\(.number): \(.url) (read only: never comment on, edit or close it)\n\n\(.body)"') > "$run/task.md.tmp"
             echo "$ref" > "$run/issue" ;;
    --task-file) cp "$ref" "$run/task.md.tmp" ;;
    *) die "usage: start.sh <slug> --issue <n> | --task-file <file>" ;;
  esac
  mv "$run/task.md.tmp" "$run/task.md"
fi
if [ ! -s "$run/base" ]; then retry git -C "$REPO" fetch -q origin main || die "cannot fetch origin/main"; git -C "$REPO" rev-parse origin/main > "$run/base"; fi
[ -d "$wt" ] || git -C "$REPO" worktree add -q --no-track -b "$branch" "$wt" "$(cat "$run/base")"
[ -f "$run/orch/ledger.tsv" ] || orch init >/dev/null

# Prepare outside the session's sandbox, where GitHub and the shared .git are reachable: the session can't fetch
# submodules or register worktrees there. The scratch worktree is the sandbox branch with origin/main merged in
# (verify-antseed's red-to-green layout); the session brings the fix into it. Each step is skipped when done.
SANDBOX_BRANCH="${FACTORY_SANDBOX_BRANCH:-codex/sandbox-stack}"
scratch="$run/scratch"
# Native modules (better-sqlite3) build for the Node that installs them, so install with the repo's pinned Node.
pin="$(cat "$REPO/.nvmrc")"; pinned="$HOME/.volta/tools/image/node/$pin/bin"
[ -x "$pinned/node" ] || die "Node $pin (.nvmrc) is not installed: volta install node@$pin"
prep() { # prep <tree>: forge-std, install, build
  [ -f "$1/packages/contracts/lib/forge-std/src/Script.sol" ] ||
    retry git -C "$1" submodule update --init -q packages/contracts/lib/forge-std || die "forge-std init failed in $1"
  local mark="$run/prepared-$(basename "$1")"
  [ "$(cat "$mark" 2>/dev/null)" = "$(git -C "$1" rev-parse HEAD)" ] && return
  echo "Preparing $1 (install and build, a few minutes)"
  (cd "$1" && export PATH="$pinned:$PATH" && pnpm install --frozen-lockfile >"$run/prep-$(basename "$1").log" 2>&1 &&
    pnpm run build >>"$run/prep-$(basename "$1").log" 2>&1) || die "install or build failed in $1: see $run/prep-$(basename "$1").log"
  git -C "$1" rev-parse HEAD > "$mark"
}
if [ ! -d "$scratch" ]; then
  retry git -C "$REPO" fetch -q origin "$SANDBOX_BRANCH" || die "cannot fetch origin/$SANDBOX_BRANCH"
  git -C "$REPO" worktree add -q -b "scratch/$slug" "$scratch" "origin/$SANDBOX_BRANCH"
  git -C "$scratch" merge -q --no-edit "$(cat "$run/base")" || die "origin/main does not merge cleanly into $SANDBOX_BRANCH; resolve it in $scratch"
fi
prep "$wt"; prep "$scratch"
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
