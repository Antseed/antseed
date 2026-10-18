#!/usr/bin/env bash
# Gate after every change to the branch (fix, act-on, no-comments). No model involved.
# Usage: gate-green.sh <slug> <label>    writes runs/<slug>/gate/green-<label>.json
#   clean      no uncommitted or untracked files in the fix worktree
#   history    exactly two commits on origin/main, no merges: test files only, then a fix that touches source
#   wording    no `Fixes/Closes/Resolves #n` (the factory never closes an issue)
#   red        the test command FAILS at commit 1 for the stated reason, in a fresh worktree
#   green      the test command PASSES at HEAD, in a fresh worktree
#   tripwire   the branch is not on the remote and has no PR
set -uo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; label="$2"; rd="$(run_dir "$slug")"; mkdir -p "$rd/gate" "$rd/evidence"
wt="$(state "$slug" worktree)"; base="$(state "$slug" base)"; branch="$(state "$slug" branch)"; plan="$rd/test-plan.md"
cmd="$(first_code "$plan" "Test command")"; sig="$(first_code "$plan" "Red signature")"; pkg="$(first_code "$plan" "Owning package")"
rows="$rd/gate/green-$label.tsv"; : > "$rows"
record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$rows"; echo "$2 $1: $3"; }

[ -z "$(git -C "$wt" status --porcelain)" ] && record clean pass "worktree clean" || record clean fail "uncommitted: $(git -C "$wt" status --porcelain | head -5 | tr '\n' ' ')"
mapfile -t cs < <(commits "$wt" "$base"); c1="${cs[0]:-}"; c2="${cs[1]:-}"
merges="$(git -C "$wt" rev-list --merges "$base..HEAD" | wc -l)"
if [ "${#cs[@]}" -ne 2 ] || [ "$merges" -ne 0 ]; then
  record history fail "${#cs[@]} commits and $merges merges on origin/main; need exactly 2 (test, then fix)"
else
  nontest="$(git -C "$wt" diff-tree --no-commit-id --name-only -r "$c1" | grep -Ev "$TEST_RE" || true)"
  src="$(git -C "$wt" diff-tree --no-commit-id --name-only -r "$c2" | grep -Ev "$TEST_RE" | grep -v '^CHANGELOG.md$' || true)"
  if [ -n "$nontest" ]; then record history fail "test commit touches non-test files: $(echo $nontest)"
  elif [ -z "$src" ]; then record history fail "fix commit changes no source file"
  else record history pass "test $(git -C "$wt" log --format='%h %s' -1 "$c1") | fix $(git -C "$wt" log --format='%h %s' -1 "$c2")"; fi
fi
git -C "$wt" log --format=%B "$base..HEAD" | grep -Eiq '\b(fix(e[sd])?|close[sd]?|resolve[sd]?) #[0-9]+' \
  && record wording fail "a commit message would auto-close an issue; use Refs #n" || record wording pass "no auto-close keywords"
if [ -z "$cmd" ] || [ -z "$c1" ]; then record red fail "no test command or no test commit"; record green fail "skipped"
else
  r="$("$FACTORY/scripts/red-green.sh" "$wt" "$c1" fail "$cmd" "$rd/evidence/red-fresh.txt" "$sig" "$pkg" 2>&1)" \
    && record red pass "$(echo "$r" | tail -1)" || record red fail "$(echo "$r" | tail -1)"
  g="$("$FACTORY/scripts/red-green.sh" "$wt" HEAD pass "$cmd" "$rd/evidence/green.txt" "" "$pkg" 2>&1)" \
    && record green pass "$(echo "$g" | tail -1)" || record green fail "$(echo "$g" | tail -1)"
fi
[ -z "$(remote_branch_sha "$wt" "$branch")" ] && [ "$(cd "$wt" && gh pr list --head "$branch" --state all --json number --jq length)" = 0 ] \
  && record tripwire pass "branch not on the remote, no PR" || record tripwire fail "branch $branch is on the remote or has a PR"
node -e '
  const fs = require("fs"), rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => l.split("\t"))
  const failed = rows.filter((r) => r[1] !== "pass").map((r) => `${r[0]}: ${r[2]}`)
  fs.writeFileSync(process.argv[2], JSON.stringify({ passed: failed.length === 0, head: process.argv[3], failed, checks: Object.fromEntries(rows.map(([n, r, d]) => [n, { result: r, detail: d }])) }, null, 2) + "\n")
  process.exit(failed.length ? 1 : 0)' "$rows" "$rd/gate/green-$label.json" "$(git -C "$wt" rev-parse HEAD)"
ok=$?
if [ "$ok" = 0 ]; then
  decide "$slug" "gate-$label" "two commits, red at ${c1:0:9}, green at $(git -C "$wt" rev-parse --short HEAD)" "gate-green in fresh worktrees" "gate/green-$label.json" "GREEN_GATE PASS"
  echo "GREEN_GATE $slug $label PASS"
else
  decide "$slug" "gate-$label" "green gate failed" "$(grep -v $'\tpass\t' "$rows" | head -1 | tr '\t' ' ')" "gate/green-$label.json" "GREEN_GATE FAIL"
  echo "GREEN_GATE $slug $label FAIL $(grep -v $'\tpass\t' "$rows" | cut -f1,3 | tr '\t\n' ': ')"; exit 1
fi
