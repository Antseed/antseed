#!/usr/bin/env bash
# Run a command with a hard deadline and, when it passes, kill everything the command started.
# Usage: run-bounded.sh <seconds> <dir> <command>      exit: the command's status, or 124 on timeout
# `timeout` alone signals only its direct child; a setsid'd or reparented grandchild (Xvfb, an Electron helper)
# survives. So every process started here carries FACTORY_RUN_ID=<unique id> in its environment, which children
# inherit even after reparenting, and on timeout every process with that marker gets SIGTERM, then SIGKILL.
set -uo pipefail
secs="$1"; dir="$2"; cmd="$3"
run_id="bounded-$$-$(date +%s%N)"   # set only in the child's environment, so this script's own helpers do not match
marked() { grep -lsz "^FACTORY_RUN_ID=$run_id\$" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 || true; }
echo "[run-bounded] run id $run_id (every process of this run carries FACTORY_RUN_ID=$run_id)" >&2
(cd "$dir" && FACTORY_RUN_ID="$run_id" exec setsid bash -c "$cmd") &
child=$!
deadline=$(( $(date +%s) + secs ))
while kill -0 "$child" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[run-bounded] ${secs}s deadline passed: stopping every process of this run ($(marked | wc -l) marked)" >&2
    pids="$(marked)"; [ -n "$pids" ] && kill -TERM $pids 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(marked)" ] && break; sleep 1; done
    pids="$(marked)"; [ -n "$pids" ] && { echo "[run-bounded] SIGKILL: $(echo $pids)" >&2; kill -KILL $pids 2>/dev/null; }
    wait "$child" 2>/dev/null
    left="$(marked)"; [ -n "$left" ] && echo "[run-bounded] still alive after SIGKILL: $(echo $left)" >&2 || echo "[run-bounded] no process of this run is left" >&2
    exit 124
  fi
  sleep 1
done
wait "$child"; status=$?
# The command ended on its own; anything it left running in the background is still ours to stop.
pids="$(marked)"; if [ -n "$pids" ]; then echo "[run-bounded] command exited $status but left $(echo $pids | wc -w) process(es); stopping them" >&2; kill -TERM $pids 2>/dev/null; sleep 3; pids="$(marked)"; [ -n "$pids" ] && kill -KILL $pids 2>/dev/null; fi
exit "$status"
