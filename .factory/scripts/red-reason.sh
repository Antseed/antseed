#!/usr/bin/env bash
# Decide whether a test run is the red or green the gate wants.
# Usage: red-reason.sh fail|pass <exit status> <output file> [red signature]
# fail: non-zero exit, the red signature (literal text) present, no setup-error marker.
# pass: exit 0.
set -uo pipefail
expect="$1"; status="$2"; out="$3"; signature="${4:-}"
SETUP_ERRORS='Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|Transform failed|No test files found|error TS[0-9]+|Failed to load url|is not a function|ReferenceError'
if [ "$expect" = pass ]; then
  [ "$status" -eq 0 ] && { echo "RG_OK pass, exit 0 ($out)"; exit 0; }
  tail -25 "$out"; echo "RG_MISMATCH expected pass, exit $status ($out)"; exit 1
fi
[ "$status" -ne 0 ] || { tail -25 "$out"; echo "RG_MISMATCH expected a failure, exit 0: the test does not reproduce the bug ($out)"; exit 1; }
if grep -Eq "$SETUP_ERRORS" "$out"; then
  grep -En "$SETUP_ERRORS" "$out" | head -5; echo "RG_MISMATCH failed for a setup reason, not the bug ($out)"; exit 1
fi
if [ -n "$signature" ] && ! grep -Fq -- "$signature" "$out"; then
  tail -25 "$out"; echo "RG_MISMATCH failed, but not for the stated reason: no \`$signature\` in the output ($out)"; exit 1
fi
echo "RG_OK fail, exit $status, reason \`$signature\` present ($out)"
