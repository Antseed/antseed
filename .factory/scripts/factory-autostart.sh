#!/usr/bin/env bash
# Wait for a shaped brief to be finished, then start the factory run on its own.
# Usage: .factory/scripts/factory-autostart.sh <slug> <worktree>
#   Started in the background by factory-shape.sh. Polls .factory/tasks/<slug>/brief.md every 10 s.
#   `SHAPE <slug> READY 0`  -> runs factory-start.sh <slug> and exits.
#   `SHAPE <slug> READY <n>` -> notifies once that n decisions are still OPEN and keeps waiting.
#   Gives up after 24 h. Log: .factory/tasks/<slug>/autostart.log
set -uo pipefail
slug="$1"; dest="$2"
brief="$dest/.factory/tasks/$slug/brief.md"
log="$dest/.factory/tasks/$slug/autostart.log"
mkdir -p "$(dirname "$log")"
echo "$(date '+%F %T') waiting for $brief" >> "$log"
warned=""
for _ in $(seq 1 8640); do
  if [ -f "$brief" ]; then
    last="$(grep -v '^[[:space:]]*$' "$brief" | tail -1)"
    case "$last" in
      "SHAPE $slug READY 0")
        echo "$(date '+%F %T') brief ready, starting the factory" >> "$log"
        herdr notification show "factory: $slug building" --body "brief accepted, plan -> build -> review -> verify started" --sound done >/dev/null 2>&1 || true
        cd "$dest" && exec .factory/scripts/factory-start.sh "$slug" >> "$log" 2>&1
        ;;
      "SHAPE $slug READY "*)
        if [ "$warned" != "$last" ]; then
          warned="$last"
          echo "$(date '+%F %T') $last: waiting for OPEN decisions" >> "$log"
          herdr notification show "factory: $slug has open decisions" --body "answer them in the shape pane; the build starts by itself when none are left" --sound request >/dev/null 2>&1 || true
        fi
        ;;
    esac
  fi
  sleep 10
done
echo "$(date '+%F %T') gave up after 24 h" >> "$log"
