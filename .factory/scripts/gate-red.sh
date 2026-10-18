#!/usr/bin/env bash
# Gate after the red stage: the failing test, committed alone, fails on origin/main for the stated reason.
# Usage: gate-red.sh <slug>      writes runs/<slug>/gate/red.json and evidence/red.txt (verbatim run)
set -uo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; rd="$(run_dir "$slug")"; mkdir -p "$rd/gate" "$rd/evidence"
wt="$(state "$slug" worktree)"; base="$(state "$slug" base)"; plan="$rd/test-plan.md"
cmd="$(first_code "$plan" "Test command")"; sig="$(first_code "$plan" "Red signature")"
fails=()
mapfile -t cs < <(commits "$wt" "$base")
[ "${#cs[@]}" -eq 1 ] || fails+=("need exactly 1 commit on origin/main, have ${#cs[@]}")
[ -z "$(git -C "$wt" status --porcelain)" ] || fails+=("worktree not clean: $(git -C "$wt" status --porcelain | head -3 | tr '\n' ' ')")
if [ "${#cs[@]}" -ge 1 ]; then
  nontest="$(git -C "$wt" diff-tree --no-commit-id --name-only -r "${cs[0]}" | grep -Ev "$TEST_RE" || true)"
  [ -z "$nontest" ] || fails+=("test commit touches non-test files: $(echo $nontest)")
  git -C "$wt" log --format=%B -1 "${cs[0]}" | grep -Eiq '\b(fix(e[sd])?|close[sd]?|resolve[sd]?) #[0-9]+' && fails+=("commit message would auto-close an issue")
fi
[ -n "$cmd" ] || fails+=("test-plan.md has no Test command")
[ -n "$sig" ] || fails+=("test-plan.md has no Red signature")
if [ -n "$cmd" ]; then
  (cd "$wt" && bash -c "$cmd") > "$rd/evidence/red.txt" 2>&1; status=$?
  printf '\n# %s at %s -> exit %s\n' "$cmd" "$(git -C "$wt" log --format='%h %s' -1)" "$status" >> "$rd/evidence/red.txt"
  reason="$("$FACTORY/scripts/red-reason.sh" fail "$status" "$rd/evidence/red.txt" "$sig")" || fails+=("$(echo "$reason" | tail -1)")
fi
node -e '
  const [file, cmd, sig, ...fails] = process.argv.slice(1)
  require("fs").writeFileSync(file, JSON.stringify({ passed: fails.length === 0, test_command: cmd, red_signature: sig, failed: fails }, null, 2) + "\n")' \
  "$rd/gate/red.json" "$cmd" "$sig" "${fails[@]}"
if [ "${#fails[@]}" -eq 0 ]; then
  decide "$slug" red "test commit ${cs[0]:0:9} fails on origin/main for the stated reason" "gate-red: red before any fix" "evidence/red.txt" "RED_GATE PASS"
  echo "RED_GATE $slug PASS"
else
  decide "$slug" red "red gate failed" "${fails[0]}" "gate/red.json" "RED_GATE FAIL"
  printf 'RED_GATE %s FAIL %s\n' "$slug" "$(IFS='|'; echo "${fails[*]}")"; exit 1
fi
