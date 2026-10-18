#!/usr/bin/env bash
# Prototype: run the whole factory as one Codex lead with its own sub-agents.
# Usage: .factory/codex/run.sh <slug> "<task sentence>" | <task file>
#   Creates ../factory-<slug> (scripts/factory-worktree.sh), writes the task, and starts Codex
#   (gpt-6.1-sol on GesundAI) in the task's Herdr "factory" tab with FACTORY.md as its instructions.
#   A new worktree's pnpm install + build runs visibly in that pane first; Codex starts after it.
#   FACTORY_BASE=<ref> branches from <ref> (e.g. a PR branch) instead of this worktree's HEAD.
set -euo pipefail
slug="$1"; task="$2"
here="$(cd "$(dirname "$0")" && pwd)"
task_file="$(mktemp -t "factory-$slug.XXXXXX")"
if [ -f "$task" ]; then cp "$task" "$task_file"; else printf '# Task\n\n%s\n' "$task" > "$task_file"; fi
line="$(FACTORY_SKIP_BUILD=1 "$here/../scripts/factory-worktree.sh" "$slug" "$task_file" | tail -1)"
read -r _ dest ws pane <<< "$line"
mkdir -p "$dest/.factory/tasks/$slug"
cp "$task_file" "$dest/.factory/tasks/$slug/task.md"
sed "s/{slug}/$slug/g" "$here/FACTORY.md" > "$dest/.factory/tasks/$slug/FACTORY.md"
catalog="$dest/.factory/tasks/$slug/models.json"
PATH="$HOME/.volta/tools/image/node/24.21.0/bin:$PATH" node "$here/models.mjs" "$catalog" >/dev/null
peer=983e9de990b9ac8d36d373db5d0b49a4d7f7d826
node24="$HOME/.volta/tools/image/node/24.21.0/bin"
herdr pane rename "$pane" "factory lead · codex" >/dev/null
setup="true"
[ -f "$dest/node_modules/.modules.yaml" ] || setup="pnpm install --frozen-lockfile --prefer-offline && pnpm run build"
herdr pane run "$pane" "cd '$dest' && export PATH='$node24':\$PATH && $setup && GESUNDAI_KEY=antseed codex --model gpt-6.1-sol -c model_provider=gesundai -c 'model_providers.gesundai={name=\"GesundAI\",base_url=\"http://localhost:8377/v1\",wire_api=\"responses\",env_key=\"GESUNDAI_KEY\",http_headers={\"x-antseed-pin-peer\"=\"$peer\"}}' -c model_catalog_json='$catalog' -c model_reasoning_effort=medium -c features.multi_agent=true --dangerously-bypass-approvals-and-sandbox 'Read .factory/tasks/$slug/FACTORY.md and run the factory for this task, step by step.'" >/dev/null
echo "started: workspace $ws, lead pane $pane, worktree $dest"
