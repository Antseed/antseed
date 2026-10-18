#!/usr/bin/env bash
# Intake, deterministic half: a GitHub issue (read only) or a task file becomes runs/<slug>/task.md.
# Usage: intake.sh <slug> --issue <number> | --task-file <file>
# It only ever runs `gh issue view`: never comments on, edits, labels or closes an issue.
set -euo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; mode="$2"; ref="$3"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "slug must be kebab-case"
rd="$(run_dir "$slug")"; mkdir -p "$rd"
[ -e "$rd/task.md" ] && die "$rd/task.md exists; pick a new slug or resume with --from"
case "$mode" in
  --issue)
    json="$(cd "$FACTORY" && gh issue view "$ref" --json number,title,state,url,body,labels)"
    node -e '
      const i = JSON.parse(process.argv[1])
      const labels = i.labels.map((l) => l.name).join(", ") || "none"
      process.stdout.write(`# Task: ${i.title}\n\nSource: ${i.url} (issue #${i.number}, ${i.state}, labels: ${labels}). Read only: never comment on, edit or close it.\n\n## Issue text (verbatim)\n\n${i.body.trim()}\n`)' "$json" > "$rd/task.md"
    [ "$(node -e 'console.log(JSON.parse(process.argv[1]).state)' "$json")" = OPEN ] || echo "warning: issue #$ref is not OPEN" >&2
    state "$slug" issue "$ref"; state "$slug" branch "fix/$ref-$slug" ;;
  --task-file)
    [ -f "$ref" ] || die "no task file $ref"
    cp "$ref" "$rd/task.md"; state "$slug" issue ""; state "$slug" branch "fix/$slug" ;;
  *) die "usage: intake.sh <slug> --issue <n> | --task-file <file>" ;;
esac
state "$slug" slug "$slug"
decide "$slug" intake "task.md from ${mode#--} $ref" "intake input, read only" "$rd/task.md" "written"
echo "TASK $rd/task.md branch $(state "$slug" branch)"
