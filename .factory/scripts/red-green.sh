#!/usr/bin/env bash
# Run the test command at one commit in a fresh throwaway worktree with its own pnpm install, never in
# the task worktree, so the result cannot depend on local leftovers.
# Usage: red-green.sh <repo> <commit> fail|pass "<command>" <output file> [red signature]
# Exit 0 when the result matches. For `fail`, the output must contain the red signature (the stated
# reason) and none of the setup-error markers (a red that fails to load is not a red).
set -uo pipefail
. "$(dirname "$0")/common.sh"
repo="$1"; commit="$2"; expect="$3"; cmd="$4"; out="$5"; signature="${6:-}"
scratch="$(mktemp -d /tmp/factory-rg-XXXXXX)"; tree="$scratch/tree"
cleanup() { git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1; rm -rf "$scratch"; }
trap cleanup EXIT
git -C "$repo" worktree add -q --detach "$tree" "$commit" || exit 2
(cd "$tree" && pnpm install --frozen-lockfile --prefer-offline > "$scratch/install.log" 2>&1) || { cat "$scratch/install.log" > "$out"; echo "RG_SETUP_FAILED pnpm install ($out)"; exit 2; }
(cd "$tree" && bash -c "$cmd") > "$out" 2>&1
status=$?
printf '\n# %s at %s (fresh worktree) -> exit %s\n' "$cmd" "$(git -C "$repo" log --format='%h %s' -1 "$commit")" "$status" >> "$out"
"$FACTORY/scripts/red-reason.sh" "$expect" "$status" "$out" "$signature"
