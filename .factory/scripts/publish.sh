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
body="$rd/pr-body.md"; sig="$(jget "$rd/gate/red.json" red_signature)"
node "$FACTORY/scripts/pr-body.mjs" "$slug" > "$body" || die "pr-body.mjs failed"
# The body is for a human reviewer: no machine paths, no factory-internal files, the red signature present,
# a short main part and at most one collapsed evidence block. Any miss refuses the publish.
leaks="$(grep -nE '/root/|/tmp/|/home/|~/|\.factory|\.antseed-sandbox|test-plan\.md|decisions\.tsv|runs/'"$slug" "$body" || true)"
[ -z "$leaks" ] || die "pr-body.md leaks local paths or factory-internal references: $(echo "$leaks" | head -3 | tr '\n' ' ')"
grep -Fq -- "$sig" "$body" || die "pr-body.md does not show the red signature \`$sig\`"
main_lines="$(awk '/<details>/{exit} {n++} END{print n+0}' "$body")"
[ "$main_lines" -le 60 ] || die "pr-body.md main part is $main_lines lines (max 60); move evidence into the <details> block"
[ "$(grep -c '<details>' "$body")" -le 1 ] || die "pr-body.md has more than one <details> block"

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
