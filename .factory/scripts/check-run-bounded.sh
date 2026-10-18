#!/usr/bin/env bash
# Factory self-check: run-bounded.sh kills a hung tree that `timeout` would leave behind: a background
# child, a setsid'd grandchild reparented to init, and an xvfb-run'd sleeper (Xvfb itself included).
# The leftover scan looks only for processes carrying this run's own FACTORY_RUN_ID (from /proc/*/environ),
# so other Xvfb or sleep processes on the machine never make it fail.
set -uo pipefail
. "$(dirname "$0")/common.sh"
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
hung="sleep 1000 & (setsid sleep 1001 &) ; xvfb-run -a sleep 1002 & sleep 1003"
echo "== hung tree: $hung"
start=$(date +%s)
"$FACTORY/scripts/run-bounded.sh" 6 /tmp "$hung" 2> >(tee "$log" >&2); st=$?
sleep 1
id="$(grep -o 'run id [^ ]*' "$log" | head -1 | cut -d' ' -f3)"
[ -n "$id" ] || { echo "RUN_BOUNDED FAIL: run-bounded.sh printed no run id"; exit 1; }
left="$(grep -lsz "^FACTORY_RUN_ID=$id\$" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 | while read -r p; do ps -o pid=,args= -p "$p"; done)"
echo "== exit $st after $(( $(date +%s) - start ))s; processes still carrying FACTORY_RUN_ID=$id: ${left:-none}"
[ "$st" = 124 ] && [ -z "$left" ] && echo "RUN_BOUNDED OK: deadline hit, every process of this run is gone" || { echo "RUN_BOUNDED FAIL"; exit 1; }
