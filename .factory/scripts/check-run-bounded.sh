#!/usr/bin/env bash
# Factory self-check: run-bounded.sh kills a hung tree that `timeout` would leave behind: a background
# child, a setsid'd grandchild reparented to init, and an xvfb-run'd sleeper (Xvfb itself included).
set -uo pipefail
. "$(dirname "$0")/common.sh"
tag="factory-hang-probe-$$"
hung="sleep 1000 & (setsid sleep 1001 &) ; xvfb-run -a sleep 1002 & sleep 1003; : $tag"
echo "== hung tree: $hung"
start=$(date +%s)
"$FACTORY/scripts/run-bounded.sh" 6 /tmp "$hung"; st=$?
echo "== exit $st after $(( $(date +%s) - start ))s"
sleep 1
left="$(pgrep -af 'sleep 100[0-3]|Xvfb' | grep -v pgrep || true)"
echo "== left over: ${left:-none}"
[ "$st" = 124 ] && [ -z "$left" ] && echo "RUN_BOUNDED OK: deadline hit, every process of the tree is gone" || { echo "RUN_BOUNDED FAIL"; exit 1; }
