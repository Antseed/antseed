#!/usr/bin/env bash
# Independent re-check after publishing, from scratch: fresh worktrees, the branch's own commits.
# Usage: recheck.sh <slug> [--dry-run]
#   PR: draft, OPEN, base main, exactly 2 commits, first is the test commit, head == local HEAD (skipped in a dry run)
#   the test command fails at commit 1 for the stated reason and passes at the head, each in a fresh worktree
set -uo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; dry=false; [ "${2:-}" = "--dry-run" ] && dry=true
rd="$(run_dir "$slug")"; wt="$(state "$slug" worktree)"; base="$(state "$slug" base)"; mkdir -p "$rd/recheck"
cmd="$(first_code "$rd/test-plan.md" "Test command")"; sig="$(first_code "$rd/test-plan.md" "Red signature")"; pkg="$(first_code "$rd/test-plan.md" "Owning package")"; fail=0
mapfile -t cs < <(commits "$wt" "$base"); head="$(git -C "$wt" rev-parse HEAD)"
[ "${#cs[@]}" -eq 2 ] || { echo "RECHECK commits: ${#cs[@]}, need 2"; fail=1; }
if $dry; then
  echo "RECHECK dry run: skipped gh pr view (no PR exists); it would require isDraft=true, state=OPEN, baseRefName=main, 2 commits, commits[0]=${cs[0]:0:9}, headRefOid=${head:0:9}"
else
  pr="$(cd "$wt" && gh pr view "$(state "$slug" pr_url)" --json number,isDraft,state,baseRefName,headRefOid,commits)"
  echo "$pr" > "$rd/recheck/pr.json"
  node -e '
    const p = JSON.parse(process.argv[1]), [head, c1] = process.argv.slice(2), bad = []
    if (!p.isDraft) bad.push("not a draft"); if (p.state !== "OPEN") bad.push(`state ${p.state}`)
    if (p.baseRefName !== "main") bad.push(`base ${p.baseRefName}`); if (p.headRefOid !== head) bad.push("head differs from local HEAD")
    if (p.commits.length !== 2) bad.push(`${p.commits.length} commits`); else if (p.commits[0].oid !== c1) bad.push("first commit is not the test commit")
    console.log(bad.length ? `RECHECK pr FAIL ${bad.join(", ")}` : `RECHECK pr OK #${p.number}: draft, open, base main, 2 commits, head ${head.slice(0, 9)}`)
    process.exit(bad.length ? 1 : 0)' "$pr" "$head" "${cs[0]}" || fail=1
fi
"$FACTORY/scripts/red-green.sh" "$wt" "${cs[0]}" fail "$cmd" "$rd/recheck/red.txt" "$sig" "$pkg" || fail=1
"$FACTORY/scripts/red-green.sh" "$wt" "$head" pass "$cmd" "$rd/recheck/green.txt" "" "$pkg" || fail=1
if [ "$fail" = 0 ]; then echo "RECHECK $slug PASS"; decide "$slug" recheck "red at ${cs[0]:0:9}, green at ${head:0:9}, fresh worktrees" "independent re-check" "recheck/" "PASS"
else echo "RECHECK $slug FAIL"; exit 1; fi
