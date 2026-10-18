#!/usr/bin/env bash
# The only way a verify session runs an extra sandbox scenario: bounded, recorded, torn down.
# Usage: run-scenario.sh <slug> <label> <scenario> [--xvfb] [--timeout <seconds, default 900>]
# Runs `node .claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> --chain local` in the scratch
# worktree through run-bounded.sh (hard deadline, kills the whole process tree), then `pnpm sandbox down`, and
# appends an `extra` row to runs/<slug>/verify/<label>/results.tsv. Exit: the scenario's, 124 on timeout.
set -uo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; label="$2"; scenario="$3"; shift 3
xvfb=""; secs=900
while [ $# -gt 0 ]; do case "$1" in --xvfb) xvfb="xvfb-run -a "; shift ;; --timeout) secs="$2"; shift 2 ;; *) die "unknown option $1" ;; esac; done
[[ "$scenario" =~ ^[a-z0-9-]+$ ]] || die "scenario must be a plain name"
out="$(run_dir "$slug")/verify/$label"; mkdir -p "$out"; scratch="$WT_ROOT/scratch-$slug"
[ -d "$scratch" ] || die "no scratch worktree $scratch"
id="extra-$scenario"; cmd="${xvfb}node .claude/skills/verify-antseed/scripts/run-with-evidence.mjs $scenario --chain local"
started=$(date +%s)
"$FACTORY/scripts/run-bounded.sh" "$secs" "$scratch" "$cmd" > "$out/$id.txt" 2>&1; status=$?
(cd "$scratch" && pnpm sandbox down) >> "$out/$id.txt" 2>&1
printf '\n# %s (in %s, deadline %ss) -> exit %s%s\n' "$cmd" "$scratch" "$secs" "$status" "$([ "$status" = 124 ] && echo ' TIMEOUT: process tree killed, sandbox torn down')" >> "$out/$id.txt"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' extra scenario "$id" "$status" "$(( $(date +%s) - started ))" "$cmd" "$out/$id.txt" >> "$out/results.tsv"
grep -E '\[sandbox\] (PASS|FAIL|KNOWN|PASSED|FAILED|Error)|\[run-bounded\]' "$out/$id.txt" | tail -15
echo "SCENARIO $scenario exit $status ($out/$id.txt)"
exit "$status"
