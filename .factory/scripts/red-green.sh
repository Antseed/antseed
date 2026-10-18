#!/usr/bin/env bash
# Run the test command at one commit in a fresh throwaway worktree with its own pnpm install, never in
# the task worktree, so the result cannot depend on local leftovers.
# Usage: red-green.sh <repo> <commit> fail|pass "<command>" <output file> [red signature] [owning package]
# Workspace packages resolve each other through their gitignored dist/, so after `pnpm install` the fresh
# tree builds the owning package's workspace dependencies (`pnpm --filter '<pkg>^...' run build`, what a
# developer or CI has before running one package's tests), never the owning package itself.
# Exit 0 when the result matches. For `fail`, the output must contain the red signature (the stated
# reason) and none of the setup-error markers (a red that fails to load is not a red).
set -uo pipefail
. "$(dirname "$0")/common.sh"
repo="$1"; commit="$2"; expect="$3"; cmd="$4"; out="$5"; signature="${6:-}"; pkg="${7:-}"
scratch="$(mktemp -d /tmp/factory-rg-XXXXXX)"; tree="$scratch/tree"
cleanup() { git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1; rm -rf "$scratch"; }
trap cleanup EXIT
git -C "$repo" worktree add -q --detach "$tree" "$commit" || exit 2
(cd "$tree" && pnpm install --frozen-lockfile --prefer-offline > "$scratch/install.log" 2>&1) || { cat "$scratch/install.log" > "$out"; echo "RG_SETUP_FAILED pnpm install ($out)"; exit 2; }
if [ -n "$pkg" ]; then
  (cd "$tree" && pnpm --filter "$pkg^..." run build > "$scratch/deps.log" 2>&1) || { cat "$scratch/deps.log" > "$out"; echo "RG_SETUP_FAILED building the workspace dependencies of $pkg ($out)"; exit 2; }
fi
(cd "$tree" && bash -c "$cmd") > "$out" 2>&1
status=$?
printf '\n# %s at %s (fresh worktree: pnpm install%s) -> exit %s\n' "$cmd" "$(git -C "$repo" log --format='%h %s' -1 "$commit")" "${pkg:+, pnpm --filter '$pkg^...' run build}" "$status" >> "$out"
"$FACTORY/scripts/red-reason.sh" "$expect" "$status" "$out" "$signature"
