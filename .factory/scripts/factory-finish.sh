#!/usr/bin/env bash
# Print where a finished factory task left its work, and write its patch.
# Usage: .factory/scripts/factory-finish.sh <slug>
#   Writes /tmp/factory-<slug>.patch with only the task's changes (the files the build
#   listed), relative to the state factory-start copied in. Apply it in any worktree with
#   `git apply <patch>`. Nothing is committed or merged.
set -euo pipefail
slug="$1"
src="$(git rev-parse --show-toplevel)"
dest="$(dirname "$src")/factory-$slug"
task="$dest/.factory/tasks/$slug"
[ -d "$task" ] || task="$(ls -d "$dest"/.factory/tasks/*/ | head -1)"
checks="$task/checks.json"
[ -f "$checks" ] || { echo "no checks.json in $task: run review first" >&2; exit 1; }
files="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).scope.task_files.join(" "))' "$checks")"
out="/tmp/factory-$slug.patch"
scratch="$(mktemp -d)"
git -C "$dest" worktree add --detach "$scratch/base" HEAD >/dev/null 2>&1
start="/tmp/factory-$slug-start.patch"
[ -s "$start" ] && git -C "$scratch/base" apply --whitespace=nowarn "$start"
: > "$out"
for file in $files; do
  (cd "$scratch" && diff -uN --label "a/$file" --label "b/$file" "base/$file" "$dest/$file" >> "$out") || true
done
git -C "$dest" worktree remove --force "$scratch/base" >/dev/null 2>&1 || true
echo "task:    $task"
echo "result:  $(tail -1 "$task/verify.md" 2>/dev/null || echo 'no verify.md yet')"
echo "patch:   $out ($(grep -c '^+++ ' "$out") files)"
echo "apply:   git apply $out"
