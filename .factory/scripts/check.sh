#!/usr/bin/env bash
# Deterministic review checks for a factory task, on Node 24. No model involved.
# Usage: check.sh <slug>
# Reads .factory/tasks/<slug>/build.md (test_command, source_files, test_files) and plan.md
# (Gate commands), then writes .factory/tasks/<slug>/checks.json:
#   scope: only files the build lists changed against baseline.patch
#   tests_are_real: prove-tests-fail.sh prints RED_CHECK_OK
#   gate: every gate command exits 0
#   choices: choices.md exists with at least one `- ` entry (`- none` counts)
# Exit 0 when all four pass.
set -uo pipefail
slug="$1"
repo="$(git rev-parse --show-toplevel)"
cd "$repo"
export PATH="${FACTORY_NODE_BIN:-$HOME/.volta/tools/image/node/24.21.0/bin}:$PATH"
task=".factory/tasks/$slug"
out="$task/checks"
mkdir -p "$out"

field() { awk -v key="$1" '
  $0 ~ "^[- ]*"key":" { sub("^[- ]*"key":[ ]*", ""); if ($0 != "") print; grab=1; next }
  grab && /^[ ]+- / { sub(/^[ ]+- /, ""); print; next }
  grab && /^- / { grab=0 }
  grab { grab=0 }' "$task/build.md" | tr -d '`' | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^\[\]$' | grep -v '^$'; }

listed="$( (field source_files; field test_files; field scenario_files) | sort -u)"
test_cmd="$(awk '/^[- ]*test_command:/ { sub(/^[- ]*test_command:[ ]*/, ""); print; exit }' "$task/build.md" | sed 's/^`//; s/`$//')"

changed="$( { git diff --name-only; git ls-files --others --exclude-standard; } | grep -v '^\.factory/' | sort -u)"
base_files="$(grep '^diff --git' "$task/baseline.patch" 2>/dev/null | awk '{print substr($3,3)}' | sort -u)"
base_untracked="$(cat "$task/baseline.untracked" 2>/dev/null)"
task_files=""
for file in $changed; do
  if echo "$base_untracked" | grep -qx "$file" && ! echo "$listed" | grep -qx "$file"; then continue; fi
  if echo "$base_files" | grep -qx "$file"; then
    git diff -- "$file" | grep -v '^index ' > "$out/now.diff"
    awk -v f="$file" '/^diff --git/ { keep = ($3 == "a/" f) } keep' "$task/baseline.patch" | grep -v '^index ' > "$out/base.diff"
    cmp -s "$out/now.diff" "$out/base.diff" && continue
  fi
  task_files="$task_files $file"
done
unexpected=""
for file in $task_files; do echo "$listed" | grep -qx "$file" || unexpected="$unexpected $file"; done
scope_ok=true; [ -n "$unexpected" ] && scope_ok=false

sources="$(field source_files | grep -v -E '\.(test|spec)\.' | grep -v '^CHANGELOG.md$' | tr '\n' ' ')"
red_ok=false
if [ -n "$test_cmd" ] && [ -n "$sources" ]; then
  "$repo/.factory/scripts/prove-tests-fail.sh" "$slug" "$test_cmd" $sources > "$out/red.txt" 2>&1 && grep -q RED_CHECK_OK "$out/red.txt" && red_ok=true
fi

gate_ok=true
awk '/^## Gate commands/ { on=1; next } /^## / { on=0 } on' "$task/plan.md" > "$out/gate-section.md"
{
  awk '/^```/ { fence = !fence; next } fence' "$out/gate-section.md"
  awk '/^```/ { fence = !fence; next } !fence' "$out/gate-section.md" | grep -oE '`[^`]+`' | tr -d '`'
} | sed 's/^[0-9]*\. *//; s/^\$ *//' | grep -E '^(cd |pnpm |node |npx |forge |bash )' | awk '!seen[$0]++' > "$out/gate-commands.txt"
: > "$out/gate.txt"
while IFS= read -r cmd; do
  echo "\$ $cmd" >> "$out/gate.txt"
  if ! (bash -c "$cmd") >> "$out/gate.txt" 2>&1; then gate_ok=false; echo "FAILED: $cmd" >> "$out/gate.txt"; fi
done < "$out/gate-commands.txt"
[ -s "$out/gate-commands.txt" ] || { gate_ok=false; echo "no gate commands found in plan.md" >> "$out/gate.txt"; }

choices_ok=false
choices_count=0
if [ -f "$task/choices.md" ] && grep -q '^- ' "$task/choices.md"; then
  choices_ok=true
  choices_count="$(grep '^- ' "$task/choices.md" | grep -vc '^- none$' || true)"
fi

node -e '
const [scope, red, gate, unexpected, files, nodeVersion, out, choices, choicesCount] = process.argv.slice(1)
const result = {
  passed: scope === "true" && red === "true" && gate === "true" && choices === "true",
  node: nodeVersion,
  scope: { passed: scope === "true", task_files: files.trim().split(/\s+/).filter(Boolean), unexpected: unexpected.trim().split(/\s+/).filter(Boolean) },
  tests_are_real: { passed: red === "true", log: `${out}/red.txt` },
  gate: { passed: gate === "true", log: `${out}/gate.txt` },
  choices: { passed: choices === "true", entries: Number(choicesCount), file: `${out.replace(/checks$/, "")}choices.md` },
}
require("fs").writeFileSync(`${out}.json`, JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
' "$scope_ok" "$red_ok" "$gate_ok" "$unexpected" "$task_files" "$(node --version)" "$out" "$choices_ok" "$choices_count"
[ "$scope_ok" = true ] && [ "$red_ok" = true ] && [ "$gate_ok" = true ] && [ "$choices_ok" = true ]
