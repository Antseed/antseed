#!/usr/bin/env bash
# Prove the new tests fail without the fix, without touching the working tree.
# Usage: prove-tests-fail.sh <slug> "<test command>" <source file>...
# Copies the repo state into a throwaway worktree, puts the listed source files
# back to their baseline (HEAD plus baseline.patch), keeps the new tests, and
# runs the test command there. Exit 0 = tests failed as they should.
set -euo pipefail
slug="$1"; test_cmd="$2"; shift 2
[ "$#" -gt 0 ] || { echo "usage: prove-tests-fail.sh <slug> <test command> <source file>..." >&2; exit 2; }
repo="$(git rev-parse --show-toplevel)"
baseline="$repo/.factory/tasks/$slug/baseline.patch"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/factory-red-XXXXXX")"
tree="$scratch/tree"
cleanup() { git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$repo" worktree add --detach "$tree" HEAD >/dev/null 2>&1
git -C "$repo" diff --binary HEAD > "$scratch/current.patch"
[ -s "$scratch/current.patch" ] && git -C "$tree" apply --whitespace=nowarn "$scratch/current.patch"
git -C "$repo" ls-files --others --exclude-standard -z | (cd "$repo" && xargs -0 -I{} rsync -R "{}" "$tree/") 2>/dev/null || true

for file in "$@"; do
  git -C "$tree" checkout HEAD -- "$file" 2>/dev/null || rm -f "$tree/$file"
done
if [ -s "$baseline" ]; then
  for file in "$@"; do git -C "$tree" apply --whitespace=nowarn --include="$file" "$baseline" 2>/dev/null || true; done
fi

ln -s "$repo/node_modules" "$tree/node_modules" 2>/dev/null || true
for dir in "$repo"/packages/*/node_modules "$repo"/apps/*/node_modules "$repo"/plugins/*/node_modules; do
  [ -d "$dir" ] || continue
  rel="${dir#$repo/}"; [ -e "$tree/$rel" ] || ln -s "$dir" "$tree/$rel"
done
for dist in "$repo"/packages/*/dist "$repo"/plugins/*/dist; do
  [ -d "$dist" ] || continue
  rel="${dist#$repo/}"; [ -e "$tree/$rel" ] || cp -R "$dist" "$tree/$rel"
done

echo "red-check worktree: $tree (sources reset: $*)"
set +e
(cd "$tree" && bash -c "$test_cmd") > "$scratch/out.txt" 2>&1
status=$?
set -e
tail -40 "$scratch/out.txt"
if [ "$status" -eq 0 ]; then
  echo "RED_CHECK_FAILED: tests passed without the fix, so they do not prove anything"
  exit 1
fi
echo "RED_CHECK_OK: tests fail without the fix (exit $status)"
