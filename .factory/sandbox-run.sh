#!/usr/bin/env bash
# sandbox-run.sh <scratch worktree> <scenario> [run-with-evidence args]: one sandbox scenario run with the pinned Node
# and Foundry. start.sh lists this script in the session's sandbox.excludedCommands, because forge panics inside the
# macOS sandbox. It accepts only --chain local; the session's deny rules still apply to the command.
set -uo pipefail
dir="${1:?scratch worktree}"; scenario="${2:?scenario}"; shift 2
case " $* " in *" --chain local "*) ;; *) echo "sandbox-run.sh: pass --chain local" >&2; exit 2 ;; esac
case " $* " in *--live*|*--real-funds*|*mainnet*) echo "sandbox-run.sh: local chain only" >&2; exit 2 ;; esac
cd "$dir" || exit 1
export PATH="$HOME/.volta/tools/image/node/$(cat .nvmrc)/bin:$HOME/.foundry/bin:$PATH"
tools="$(cd "$(dirname "$0")/.." && pwd)"
node "$tools/.claude/skills/verify-antseed/scripts/run-with-evidence.mjs" "$scenario" "$@"
