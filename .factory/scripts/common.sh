# Shared settings for the factory's shell scripts. Source it: `. "$(dirname "$0")/common.sh"`.
FACTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${FACTORY_NODE_BIN:-/usr/local/bin}:$HOME/.foundry/bin:$PATH"
PSTACK="${PSTACK_DIR:-/root/.claude/plugins/cache/pstack-local/pstack/0.15.25}"
WT_ROOT="${FACTORY_WT_ROOT:-/root/.herdr/worktrees/antseed}"
SANDBOX_REF="${FACTORY_SANDBOX_REF:-origin/codex/sandbox-stack}"
AUDIT_URL="${FACTORY_AUDIT_URL:-http://127.0.0.1:18377}"
GESUNDAI_PEER=983e9de990b9ac8d36d373db5d0b49a4d7f7d826
# Test files: what the test commit may contain (and nothing else).
TEST_RE='(\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|/__tests__/|(^|/)tests?/|\.t\.sol$)'

die() { echo "error: $*" >&2; exit 1; }
run_dir() { echo "$FACTORY/runs/$1"; }
# state <slug> <key> [value]: read or set one key of runs/<slug>/state.json
state() {
  node -e '
    const fs = require("fs"), [file, key, value] = process.argv.slice(1)
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
    if (value === undefined) { const v = s[key]; console.log(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)); process.exit(0) }
    s[key] = value; fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n")' "$(run_dir "$1")/state.json" "$2" ${3+"$3"}
}
# commits <worktree> <base>: the task's commits, oldest first
commits() { git -C "$1" rev-list --reverse "$2..HEAD"; }
# section <file> <heading>: body of a `## heading` section, blank lines dropped
section() { awk -v h="## $2" '$0 == h { on = 1; next } on && /^## / { exit } on' "$1" | sed '/^[[:space:]]*$/d'; }
# first_code <file> <heading>: the first `backticked` text in a section
first_code() { section "$1" "$2" | grep -o '`[^`]*`' | head -1 | sed 's/^`//; s/`$//'; }
remote_branch_sha() { git -C "$1" ls-remote origin "refs/heads/$2" | awk '{print $1}'; }
# decide <slug> <phase> <decision> <why> <evidence> <result>: one show-me-your-work row
decide() { bash "$PSTACK/skills/show-me-your-work/scripts/log.sh" "$(run_dir "$1")/decisions.tsv" "$2" "$3" "$4" "$5" "$6"; }
