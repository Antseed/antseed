#!/usr/bin/env bash
# Start the factory run for a task in its own worktree and Herdr subproject.
# Usage: .factory/scripts/factory-start.sh [--force] <slug> [task file]
#   With a task file and no worktree yet: creates it (scripts/factory-worktree.sh) and runs.
#   After scripts/factory-shape.sh: reuses that worktree; the plan step reads the shaped brief
#   (.factory/tasks/<slug>/brief.md, with your answers under "Decisions") and the chosen mockup.
# Starts Prime in the factory tab's lead pane and sends the run instruction.
# A watcher in the lead's kernel (scripts/factory_run.py) logs every event to tasks/<slug>/events.jsonl and,
# when the run ends, fails or pauses, writes tasks/<slug>/outcome.md and sends a Herdr notification.
# When the run is done: .factory/scripts/factory-finish.sh <slug> prints the task's patch.
set -euo pipefail
force=false
if [ "${1:-}" = "--force" ]; then force=true; shift; fi
slug="$1"
here="$(cd "$(dirname "$0")" && pwd)"
line="$("$here/factory-worktree.sh" "$@" | tee /dev/stderr | tail -1)"
read -r _ dest ws pane <<< "$line"
brief="$dest/.factory/tasks/$slug/brief.md"
if [ -f "$brief" ] && [ "$force" = false ]; then
  last="$(grep -v '^[[:space:]]*$' "$brief" | tail -1)"
  case "$last" in
    "SHAPE $slug READY 0") ;;
    "SHAPE $slug READY "*) echo "brief has OPEN decisions ($last). Answer them in the shape pane, or run with --force to build anyway." >&2; exit 1 ;;
    *) echo "shaping isn't finished (last line: ${last:-empty}). Finish the interview in the shape pane, or run with --force." >&2; exit 1 ;;
  esac
fi
if ! grep -q '^Factory slug:' "$dest/.factory/current-task.md"; then
  {
    echo
    echo "Factory slug: $slug"
    [ -f "$brief" ] && echo "Shaped brief: .factory/tasks/$slug/brief.md (the human's answers under \"Decisions\" override the brief's defaults; mockups in .factory/tasks/$slug/design/)"
  } >> "$dest/.factory/current-task.md"
fi
herdr pane rename "$pane" "factory lead · prime" >/dev/null
herdr pane run "$pane" "prime-agent" >/dev/null
for _ in $(seq 1 30); do
  herdr pane get "$pane" | grep -q '"agent":"prime-agent"' && break
  sleep 1
done
sleep 3
herdr pane send-text "$pane" 'Run the factory: in ipython run `exec(open(".factory/scripts/factory_run.py").read()); print(await factory_go())`. It starts the run and a watcher that notifies the human and writes the outcome by itself, so do not set up your own periodic checks. Report one line per milestone until it finishes.' >/dev/null
herdr pane send-keys "$pane" Enter >/dev/null
echo "started: workspace $ws, lead pane $pane, worktree $dest"
