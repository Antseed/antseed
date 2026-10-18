#!/usr/bin/env bash
# Publish, script only (no model): push the fix branch and open a DRAFT PR against main, then re-check.
# Usage: publish.sh <slug> --dry-run     write the PR body, print every command it would run, run the local
#                                        re-check, and stop. This round only ever runs the dry run.
#        publish.sh <slug>               real publish; refused unless FACTORY_ALLOW_PUBLISH=1
# Never force-pushes, merges, comments, or touches the issue. Refuses unless every gate passed for HEAD.
set -euo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; dry=false; [ "${2:-}" = "--dry-run" ] && dry=true
rd="$(run_dir "$slug")"; wt="$(state "$slug" worktree)"; base="$(state "$slug" base)"; branch="$(state "$slug" branch)"; issue="$(state "$slug" issue)"
$dry || [ "${FACTORY_ALLOW_PUBLISH:-}" = 1 ] || die "real publish is disabled (set FACTORY_ALLOW_PUBLISH=1 deliberately); use --dry-run"
head="$(git -C "$wt" rev-parse HEAD)"
green="$rd/gate/green-$(state "$slug" last_green).json"; vlabel="$(state "$slug" last_verify)"; judge="$rd/$(state "$slug" last_judge)"
jget() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],o); console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }
[ "$(jget "$green" passed)" = true ] && [ "$(jget "$green" head)" = "$head" ] || die "the last green gate ($green) did not pass for HEAD"
[ "$(jget "$rd/verify/$vlabel/gate.json" passed)" = true ] && [ "$(jget "$rd/verify/$vlabel/gate.json" head)" = "$head" ] || die "the last verify gate did not pass for HEAD"
grep -q "^VERIFY $slug PASS" "$rd/verify/$vlabel/verify.md" || die "the verify session did not answer VERIFY $slug PASS"
grep -Eq "^JUDGE $slug ACT_ON 0\b" "$judge" || die "the last judgment still has Act-on items: $(grep '^JUDGE' "$judge" | tail -1)"
[ -z "$(git -C "$wt" status --porcelain)" ] || die "worktree not clean"
mapfile -t cs < <(commits "$wt" "$base"); [ "${#cs[@]}" -eq 2 ] || die "need exactly 2 commits, have ${#cs[@]}"
[ "$(git -C "$wt" branch --show-current)" = "$branch" ] || die "worktree is not on $branch"
[ -z "$(remote_branch_sha "$wt" "$branch")" ] || die "remote branch $branch already exists; refusing (never force)"
[ "$(cd "$wt" && gh pr list --head "$branch" --state all --json number --jq length)" = 0 ] || die "a PR for $branch already exists"
critical="$(jget "$rd/security.json" critical)"

title="$(git -C "$wt" log --format=%s -1 "${cs[1]}")"; label_args=()
if [ "$critical" = true ]; then
  title="$(jget "$rd/security.json" pr_flag.title_prefix)$title"
  if (cd "$wt" && gh label list --limit 200 --json name --jq '.[].name') | grep -qx security-critical; then label_args=(--label security-critical)
  else echo "note: the repo has no security-critical label; the title prefix and body marker flag the PR (no label is created)"; fi
fi
cmd="$(jget "$rd/gate/red.json" test_command)"
fence() { echo '```'; if [ "$(wc -l < "$1")" -gt "$2" ]; then echo "[first lines omitted; full output: $(basename "$1")]"; tail -n "$2" "$1"; else cat "$1"; fi | sed 's/```/`` `/g'; echo '```'; }
body="$rd/pr-body.md"
{
  [ -n "$issue" ] && { echo "Refs #$issue"; echo; }
  if [ "$critical" = true ]; then
    jget "$rd/security.json" pr_flag.body_marker
    echo "> **Security-critical change.** It touches: $(node -e 'const s=require(process.argv[1]); console.log([...s.paths.map(p=>"`"+p.file+"` ("+p.why+")"), ...s.markers.map(m=>"lines matching `"+m.regex+"` ("+m.why+")")].join("; "))' "$rd/security.json"). The verify-antseed keys, signing and spend caps row ran (below)."
    echo
  fi
  echo "## Summary"; echo; section "$rd/test-plan.md" "Expected behavior"; echo
  echo "## Commits"; echo
  echo "1. \`$(git -C "$wt" log --format='%h %s' -1 "${cs[0]}")\`: the failing regression test, alone."
  echo "2. \`$(git -C "$wt" log --format='%h %s' -1 "${cs[1]}")\`: the fix."; echo
  echo "## Red: the test fails on origin/main ($(git -C "$wt" rev-parse --short "$base")) with only commit 1"; echo
  echo "\`$cmd\` in a fresh worktree at commit 1:"; echo; fence "$rd/evidence/red-fresh.txt" 60; echo
  echo "## Green: it passes with the fix"; echo; echo "\`$cmd\` in a fresh worktree at the head:"; echo; fence "$rd/evidence/green.txt" 30; echo
  echo "## Verification (verify-antseed)"; echo
  node -e '
    const g = require(process.argv[1]), plan = require(process.argv[2])
    console.log(`Rows: ${plan.rows.map((r) => `${r.id} (${r.why})`).join("; ")}.\n`)
    console.log("| Where | Command | Exit |\n| --- | --- | --- |")
    for (const r of g.results.filter((r) => r.phase !== "before")) console.log(`| ${r.phase === "fix" ? "fix branch" : "sandbox scratch"} | \`${r.cmd.replace(/\|/g, "\\|")}\` | ${r.exit} |`)
    if (g.scenarios.length) { console.log("\nSandbox scenarios on a local scratch worktree (sandbox stack + origin/main + these two commits; never pushed), each without and with the fix:\n"); for (const s of g.scenarios) console.log(`- \`${s.scenario}\`: without the fix exit ${s.before}, with the fix exit ${s.after} (${s.verdict})`) }
    for (const n of g.notes) console.log(`- note: ${n}`)' "$rd/verify/$vlabel/gate.json" "$rd/verify/$vlabel/plan.json"
  for f in "$rd/verify/$vlabel"/after-*.txt; do
    [ -f "$f" ] || continue
    echo; echo "\`$(basename "$f" .txt | sed 's/^after-//')\` with the fix (checks, verbatim):"; echo
    echo '```'; grep -E '\[sandbox\] (PASS|FAIL|KNOWN|PASSED|FAILED|Error)' "$f" | sed 's/```/`` `/g'; echo '```'
  done
  echo; echo "## Review"; echo
  echo "Three independent read-only reviews (pstack interrogate), each a separate pinned Claude Code session on its own model: claude-opus-5.5, claude-fable-5.1, gpt-6-astra. Lead judgment by claude-opus-5.5 (interrogate lead-judgment). Rounds: $(state "$slug" review_round). Final verdict: \`$(grep '^JUDGE' "$judge" | tail -1)\`."
  echo; echo "Left for a human to consider:"; echo
  awk '/^### Consider/{on=1; next} on && /^### /{exit} on' "$judge" | sed '/^[[:space:]]*$/d' | head -30; echo
  echo "## Blast radius"; echo
  awk '/^## The one fact/{on=1; next} on && /^## /{exit} on' "$rd/blast-radius.md" | sed '/^[[:space:]]*$/d' | head -12; echo
  echo "---"
  echo "Draft opened by the local Claude factory: every step a pinned Claude Code session via AntSeed peer GesundAI, every gate a script. Needs a human review before it is marked ready."
} > "$body"

push=(git -C "$wt" push -u origin "HEAD:refs/heads/$branch")
create=(gh pr create --draft --base main --head "$branch" --title "$title" --body-file "$body" "${label_args[@]}")
if $dry; then
  echo "DRY RUN: nothing is pushed and no PR is opened. It would run, in this order:"
  printf '  1.'; printf ' %q' "${push[@]}"; echo
  printf '  2. (cd %q &&' "$wt"; printf ' %q' "${create[@]}"; echo ')'
  echo "  3. scripts/recheck.sh $slug   (gh pr view: isDraft, OPEN, base main, exactly the 2 commits, head == $head; red at commit 1, green at the head)"
  echo "PR title: $title"
  echo "PR body: $body ($(wc -l < "$body") lines)"
  decide "$slug" publish "dry run: wrote the PR body, printed the push and draft-PR commands, ran nothing remote" "this round never pushes" "pr-body.md" "DRY RUN"
  "$FACTORY/scripts/recheck.sh" "$slug" --dry-run
  exit $?
fi
"${push[@]}"
url="$(cd "$wt" && "${create[@]}")"
state "$slug" pr_url "$url"
decide "$slug" publish "pushed $branch and opened draft PR" "all gates passed" "$url" "PR opened"
echo "PR $url"
"$FACTORY/scripts/recheck.sh" "$slug"
