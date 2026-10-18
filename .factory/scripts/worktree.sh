#!/usr/bin/env bash
# The task's fix worktree, from a freshly fetched origin/main, on a local branch with no upstream.
# Usage: worktree.sh <slug>     (branch from runs/<slug>/state.json)
# Holds product code only; factory tooling and run state stay in the factory worktree.
set -euo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; rd="$(run_dir "$slug")"
branch="$(state "$slug" branch)"; [ -n "$branch" ] || die "no branch in state.json"
dest="$WT_ROOT/$(echo "$branch" | tr '/' '-')"
[ -e "$dest" ] && die "$dest already exists"
git -C "$FACTORY" fetch -q origin
base="$(git -C "$FACTORY" rev-parse origin/main)"
git -C "$FACTORY" worktree add -q --no-track -b "$branch" "$dest" "$base"
git -C "$dest" rev-parse -q --verify "@{u}" >/dev/null 2>&1 && die "$branch has an upstream"
echo "== $dest on $branch from origin/main $(git -C "$dest" rev-parse --short HEAD); pnpm install + build (node $(node --version))"
started=$(date +%s)
(cd "$dest" && pnpm install --frozen-lockfile --prefer-offline > "$rd/setup.log" 2>&1 && pnpm run build >> "$rd/setup.log" 2>&1) \
  || die "install/build failed, see $rd/setup.log"
state "$slug" worktree "$dest"; state "$slug" base "$base"
decide "$slug" worktree "fix worktree $dest on $branch from origin/main ${base:0:9}" "every fix starts from the current main" "$rd/setup.log" "installed and built in $(( $(date +%s) - started ))s"
echo "WORKTREE $dest $branch $base"
