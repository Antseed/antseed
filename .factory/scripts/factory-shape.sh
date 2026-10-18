#!/usr/bin/env bash
# Shape a task before the factory runs. The task can be one vague sentence.
# Usage: .factory/scripts/factory-shape.sh [--auto] <slug> <task file | "task in one sentence">
#   Creates the task's worktree and Herdr subproject (scripts/factory-worktree.sh) and starts the
#   shaper (Claude Code, opus) in a pane of its factory tab. It researches first (code, today's
#   behavior, prior art, mockups for UI), then:
#     default  interview: asks you one question at a time in that pane (Herdr notifies you and
#              marks the pane as waiting). Type answers there; `defaults`, `skip to map`, `stop` work.
#     --auto   no questions: decides with its recommendations and writes the brief.
#   Result: .factory/tasks/<slug>/brief.md, ending `SHAPE <slug> READY <open>`.
#   When the brief is READY with no OPEN decisions, the factory run starts by itself
#   (scripts/factory-autostart.sh). --no-build stops after the brief instead.
set -euo pipefail
mode=interview
autobuild=true
while [ "${1:-}" = "--auto" ] || [ "${1:-}" = "--no-build" ]; do
  [ "$1" = "--auto" ] && mode=auto
  [ "$1" = "--no-build" ] && autobuild=false
  shift
done
slug="${1:-}"
[ -n "$slug" ] && [ -n "${2:-}" ] || { echo "usage: factory-shape.sh [--auto] <slug> <task file | \"task in one sentence\">" >&2; exit 2; }
task="$2"
if [ ! -f "$task" ]; then
  file="$(mktemp -t "factory-$slug").md"
  printf '# Task\n\n%s\n\n(Unspecified on purpose: the shaper finds out the rest with the human.)\n' "$task" > "$file"
  task="$file"
fi
here="$(cd "$(dirname "$0")" && pwd)"
line="$("$here/factory-worktree.sh" "$slug" "$task" | tee /dev/stderr | tail -1)"
read -r _ dest ws pane <<< "$line"
herdr pane rename "$pane" "factory lead · shape ($mode)" >/dev/null
flags=(--step shape --slug "$slug" --agent claude --model claude-opus-5.5 --effort high
  --template .factory/prompts/shape.md --var "mode=$mode" --answer-file ".factory/tasks/$slug/brief.md")
if [ "$mode" = interview ]; then flags+=(--interactive); else flags+=(--timeout-min 40); fi
herdr pane run "$pane" "cd '$dest' && HERDR_WORKSPACE_ID=$ws node .factory/scripts/native-step.mjs ${flags[*]}" >/dev/null
if [ "$mode" = interview ]; then
  echo "interview starting in workspace $ws (factory tab). It researches first, then asks you questions there; Herdr notifies you."
else
  echo "shaping (auto) in workspace $ws; you get a notification when $dest/.factory/tasks/$slug/brief.md is ready."
fi
if [ "$autobuild" = true ]; then
  nohup "$here/factory-autostart.sh" "$slug" "$dest" >/dev/null 2>&1 &
  disown
  echo "when the brief is ready the build starts by itself (log: $dest/.factory/tasks/$slug/autostart.log)"
else
  echo "then: .factory/scripts/factory-start.sh $slug"
fi
