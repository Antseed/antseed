#!/usr/bin/env bash
# Create (or find) the worktree and Herdr subproject for one factory task.
# Usage: .factory/scripts/factory-worktree.sh <slug> [task file]
#   New task: creates ../factory-<slug> on branch factory/<slug> from HEAD, copies this worktree's
#   uncommitted changes (tracked and untracked) and .env.local into it, writes the task to
#   .factory/current-task.md, opens it as a Herdr workspace with a "factory" tab, then runs
#   pnpm install + build on Node 24 (skipped with FACTORY_SKIP_BUILD=1, for callers that build
#   in the pane). The lead pane id is saved in .factory/lead-pane. Existing task: reuses the
#   worktree, its factory tab and that pane (never the Herdr sidebar).
#   FACTORY_BASE=<ref>: branch from <ref> instead of HEAD and copy only the factory tooling
#   (.factory, .claude/skills, e2e/sandbox, scripts/sandbox-attach.mjs), not other local changes.
# Last line of output: `WORKTREE <path> <workspace id> <factory tab root pane id>`.
set -euo pipefail
slug="$1"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "slug must be kebab-case" >&2; exit 2; }
task_file=""
if [ -n "${2:-}" ]; then
  [ -f "$2" ] || { echo "task file not found: $2" >&2; exit 2; }
  task_file="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
fi
src="$(git rev-parse --show-toplevel)"
dest="$(dirname "$src")/factory-$slug"
created=""
export PATH="${FACTORY_NODE_BIN:-$HOME/.volta/tools/image/node/24.21.0/bin}:$PATH"

if [ ! -e "$dest" ]; then
  [ -n "$task_file" ] || { echo "new task needs a task file" >&2; exit 2; }
  echo "== worktree $dest (branch factory/$slug)"
  if [ -n "${FACTORY_BASE:-}" ]; then
    git -C "$src" worktree add -b "factory/$slug" "$dest" "$FACTORY_BASE" >/dev/null
    git -C "$src" ls-files --others --exclude-standard -z -- .factory .claude/skills e2e/sandbox scripts/sandbox-attach.mjs \
      | grep -zv '^\.factory/tasks/' | (cd "$src" && xargs -0 cp --parents -t "$dest/")
    exclude="$(git -C "$src" rev-parse --git-common-dir)/info/exclude"
    for pattern in .factory/tasks/ .factory/current-task.md; do grep -qxF "$pattern" "$exclude" 2>/dev/null || echo "$pattern" >> "$exclude"; done
  else
    git -C "$src" worktree add -b "factory/$slug" "$dest" HEAD >/dev/null
    git -C "$src" diff --binary HEAD > "$dest/.git-start.patch"
    [ -s "$dest/.git-start.patch" ] && git -C "$dest" apply --whitespace=nowarn "$dest/.git-start.patch"
    mv "$dest/.git-start.patch" "/tmp/factory-$slug-start.patch"
    git -C "$src" ls-files --others --exclude-standard -z | grep -zv '^\.factory/tasks/' | (cd "$src" && xargs -0 cp --parents -t "$dest/")
  fi
  [ -f "$src/.env.local" ] && cp "$src/.env.local" "$dest/.env.local"
  cp "$task_file" "$dest/.factory/current-task.md"
  created=1
elif [ -n "$task_file" ]; then
  cp "$task_file" "$dest/.factory/current-task.md"
fi

ws="$(herdr worktree list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;console.log(r.worktrees.find(w=>w.path===process.argv[1])?.open_workspace_id??"")})' "$dest")"
if [ -z "$ws" ]; then
  parent="$(herdr worktree list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.source.source_workspace_id??""))')"
  open_json="$(herdr worktree open ${parent:+--workspace "$parent"} --path "$dest" --label "factory-$slug" --no-focus --trust-repository)"
  read -r ws tab pane < <(node -e 'const r=JSON.parse(process.argv[1]); if (!r.result) { console.error(process.argv[1]); process.exit(1) } const p=r.result.root_pane; console.log(p.workspace_id, p.tab_id, p.pane_id)' "$open_json")
  herdr tab rename "$tab" factory >/dev/null
  echo "$pane" > "$dest/.factory/lead-pane"
else
  read -r tab pane < <(node -e '
    const { execFileSync } = require("node:child_process")
    const get = (...args) => JSON.parse(execFileSync("herdr", args, { encoding: "utf8" })).result
    const ws = process.argv[1]
    let tab = get("tab", "list", "--workspace", ws).tabs.find((t) => t.label === "factory")
    if (!tab) { const made = get("tab", "create", "--workspace", ws, "--cwd", process.argv[2], "--label", "factory"); tab = made.tab }
    const panes = get("pane", "list").panes.filter((p) => p.tab_id === tab.tab_id)
    const fs = require("node:fs")
    const saved = fs.existsSync(process.argv[3]) ? fs.readFileSync(process.argv[3], "utf8").trim() : ""
    const isSidebar = (p) => Object.keys(p.tokens ?? {}).some((key) => key.startsWith("herdr-sidebar"))
    const root = panes.find((p) => p.pane_id === saved) ?? panes.find((p) => p.label === "factory lead · codex") ?? panes.find((p) => !isSidebar(p) && !/ · (claude|codex)/.test(p.label ?? "")) ?? panes.find((p) => !isSidebar(p)) ?? panes[0]
    console.log(tab.tab_id, root.pane_id)' "$ws" "$dest" "$dest/.factory/lead-pane")
  echo "$pane" > "$dest/.factory/lead-pane"
fi
if [ -n "$created" ] && [ -z "${FACTORY_SKIP_BUILD:-}" ]; then
  echo "== pnpm install + build (Node $(node --version)), log: $dest/.factory/setup.log"
  (cd "$dest" && pnpm install --frozen-lockfile --prefer-offline > "$dest/.factory/setup.log" 2>&1 && pnpm run build >> "$dest/.factory/setup.log" 2>&1) \
    || { echo "install/build failed, see $dest/.factory/setup.log" >&2; exit 1; }
fi
echo "WORKTREE $dest $ws $pane"
