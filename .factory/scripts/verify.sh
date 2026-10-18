#!/usr/bin/env bash
# Verify, deterministic half: run what the verify-antseed table requires and record every exit code.
# Usage: verify.sh <slug> [label]       (label names this pass, e.g. r1; results go to runs/<slug>/verify/<label>/)
#   1. verify-plan.mjs: rows from the diff (+ the keys row for security-critical changes) and owning packages
#   2. sandbox rows only: scratch worktree (exit 3 = merge conflicts for the merge-resolve session), doctor FIRST
#   3. fix worktree: rebuild changed packages, run every unit command
#   4. sandbox rows only: baseline scenarios on the scratch without the fix (once per scratch base), then the
#      fix cherry-picked, rebuilt, doctor again, the same scenarios, pnpm sandbox down
#   5. verify-gate.mjs decides; nothing here interprets results
set -uo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; label="${2:-r1}"; rd="$(run_dir "$slug")"; out="$rd/verify/$label"; mkdir -p "$out"
wt="$(state "$slug" worktree)"; scratch="$WT_ROOT/scratch-$slug"
results="$out/results.tsv"; : > "$results"
node "$FACTORY/scripts/security-check.mjs" "$slug" | tee "$out/security.txt"
node "$FACTORY/scripts/verify-plan.mjs" "$slug" | tee "$out/plan.txt" || exit 1
cp "$rd/verify/plan.json" "$out/plan.json"
# run <phase> <kind> <id> <dir> <command>: output to <id>.txt, one results row
run() {
  local phase="$1" kind="$2" id="$3" dir="$4" cmd="$5" started status
  started=$(date +%s)
  echo "== [$phase] $cmd (in $dir)"
  (cd "$dir" && timeout 1800 bash -c "$cmd") > "$out/$id.txt" 2>&1; status=$?
  printf '\n# %s (in %s) -> exit %s\n' "$cmd" "$dir" "$status" >> "$out/$id.txt"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$phase" "$kind" "$id" "$status" "$(( $(date +%s) - started ))" "$cmd" "$out/$id.txt" >> "$results"
  echo "   exit $status ($(( $(date +%s) - started ))s) -> $out/$id.txt"
}
sandbox="$(node -e 'const p=require(process.argv[1]); console.log(p.sandbox ? "yes" : "no")' "$out/plan.json")"
doctor=".claude/skills/verify-antseed/scripts/doctor.mjs"
evidence=".claude/skills/verify-antseed/scripts/run-with-evidence.mjs"

if [ "$sandbox" = yes ]; then
  if [ ! -e "$scratch" ]; then
    "$FACTORY/scripts/sandbox-scratch.sh" "$slug" setup; st=$?
    [ "$st" = 3 ] && exit 3; [ "$st" = 0 ] || exit 1
  elif [ -z "$(state "$slug" scratch_base)" ]; then
    "$FACTORY/scripts/sandbox-scratch.sh" "$slug" setup --continue || exit 1
  fi
  sbase="$(state "$slug" scratch_base)"
  mapfile -t scenarios < <(node -e '
    const fs = require("fs"), p = require(process.argv[1]), dir = process.argv[2] + "/e2e/sandbox/scenarios"
    for (const s of p.sandbox.scenarios) {
      if (!s.includes("*")) { console.log(s); continue }
      const re = new RegExp("^" + s.replace("*", ".*") + "\\.mjs$")
      for (const f of fs.readdirSync(dir).filter((f) => re.test(f)).sort()) console.log(f.replace(/\.mjs$/, ""))
    }' "$out/plan.json" "$scratch")
  xvfb="$(node -e 'console.log(require(process.argv[1]).sandbox.xvfb ? "xvfb-run -a " : "")' "$out/plan.json")"
  baseline="$rd/verify/baseline-${sbase:0:12}"
  if [ ! -f "$baseline/done" ]; then
    mkdir -p "$baseline"
    "$FACTORY/scripts/sandbox-scratch.sh" "$slug" base || exit 1
    run before doctor doctor-before "$scratch" "node $doctor"
    for s in "${scenarios[@]}"; do run before scenario "before-$s" "$scratch" "${xvfb}node $evidence $s --chain local"; done
    run before down down-before "$scratch" "pnpm sandbox down"
    cp "$results" "$baseline/results.tsv"; cp "$out"/*before*.txt "$baseline/" 2>/dev/null; touch "$baseline/done"
  else
    echo "== baseline for scratch base ${sbase:0:12} already recorded: $baseline"
    while IFS= read -r line; do printf '%s\n' "$line" >> "$results"; done < "$baseline/results.tsv"
  fi
  "$FACTORY/scripts/sandbox-scratch.sh" "$slug" pick || exit 1
  run after doctor doctor-after "$scratch" "node $doctor"
fi

while IFS= read -r c; do [ -n "$c" ] && run fix build "build-$(echo "$c" | tr -c 'a-zA-Z0-9' '-' | cut -c1-60)" "$wt" "$c"; done \
  < <(node -e 'for (const c of require(process.argv[1]).build) console.log(c)' "$out/plan.json")
i=0
while IFS= read -r c; do [ -n "$c" ] || continue; i=$((i + 1)); run fix unit "unit-$i" "$wt" "$c"; done \
  < <(node -e 'for (const u of require(process.argv[1]).unit) console.log(u.cmd)' "$out/plan.json")

if [ "$sandbox" = yes ]; then
  for s in "${scenarios[@]}"; do run after scenario "after-$s" "$scratch" "${xvfb}node $evidence $s --chain local"; done
  run after down down-after "$scratch" "$FACTORY/scripts/sandbox-scratch.sh $slug down"
fi
node "$FACTORY/scripts/verify-gate.mjs" "$slug" "$label"
