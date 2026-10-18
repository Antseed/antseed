#!/usr/bin/env bash
# Refuse to start unless every prerequisite holds. Writes runs/<slug>/preflight.txt.
# Usage: preflight.sh <slug>
# Each model the run uses must answer one pinned ping through the audit proxy, from GesundAI.
set -uo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; rd="$(run_dir "$slug")"; out="$rd/preflight.txt"; : > "$out"
fail=0
ok() { echo "ok   $*" | tee -a "$out"; }
bad() { echo "FAIL $*" | tee -a "$out"; fail=1; }
[ "${HERDR_ENV:-}" = 1 ] && ok "inside Herdr (workspace ${HERDR_WORKSPACE_ID:-?})" || bad "not inside a Herdr pane"
v="$(claude --version 2>&1)" && ok "claude $v" || bad "claude not runnable: $v"
n="$(node --version)"; [[ "$n" == v24.* ]] && ok "node $n" || bad "node $n (need 24)"
command -v anvil >/dev/null && ok "foundry on PATH" || bad "anvil missing (Foundry)"
gh auth status >/dev/null 2>&1 && ok "gh authenticated (the factory only reads with it)" || bad "gh not authenticated"
missing=""
for s in sharpen tdd principle-test-behavior-not-implementation principle-fix-root-causes poteto-mode principle-prove-it-works \
         principle-explain-the-number blast-radius interrogate no-comments reflect correct show-me-your-work principle-never-block-on-the-human; do
  [ -f "$PSTACK/skills/$s/SKILL.md" ] || missing="$missing $s"
done
[ -f "$PSTACK/agents/comment-sicko.md" ] || missing="$missing agents/comment-sicko"
[ -z "$missing" ] && ok "pstack skills present ($PSTACK)" || bad "pstack missing:$missing"
git -C "$FACTORY" fetch -q origin 2>/dev/null
if git -C "$FACTORY" cat-file -e "$SANDBOX_REF:.claude/skills/verify-antseed/SKILL.md" 2>/dev/null; then
  ok "sandbox stack $SANDBOX_REF $(git -C "$FACTORY" rev-parse --short "$SANDBOX_REF") has verify-antseed"
else bad "$SANDBOX_REF has no .claude/skills/verify-antseed/SKILL.md"; fi
models="$(node -e 'const m=require(process.argv[1]).stages; console.log([...new Set(Object.values(m).flatMap((s)=>s.models??[s.model]))].join(" "))' "$FACTORY/inputs/models.json")"
for model in $models; do
  hdr="$(mktemp)"; body="$(mktemp)"
  code="$(curl -s -m 120 -o "$body" -D "$hdr" -w '%{http_code}' "$AUDIT_URL/v1/messages" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
    -H 'x-api-key: antseed' -H 'x-antseed-system-proxy-source: claude-code' -H "x-antseed-pin-peer: $GESUNDAI_PEER" -H "x-factory-step: $slug/preflight-$model" \
    -d "{\"model\":\"$model\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"reply ok\"}]}")"
  peer="$(grep -i '^x-antseed-peer-id:' "$hdr" | tr -d '\r' | awk '{print $2}')"
  [ "$code" = 200 ] && [ "$peer" = "$GESUNDAI_PEER" ] && ok "$model answered by GesundAI through the audit proxy $AUDIT_URL" \
    || bad "$model ping: http $code peer '${peer:-none}' $(head -c 160 "$body")"
  rm -f "$hdr" "$body"
done
branch="$(state "$slug" branch)"
if [ -n "$branch" ]; then
  [ -z "$(remote_branch_sha "$FACTORY" "$branch")" ] && ok "remote branch $branch does not exist" || bad "remote branch $branch already exists"
  [ "$(cd "$FACTORY" && gh pr list --head "$branch" --state all --json number --jq length 2>/dev/null)" = 0 ] && ok "no PR for $branch" || bad "a PR for $branch exists (or gh failed)"
fi
if [ "$fail" = 0 ]; then echo "PREFLIGHT $slug OK" | tee -a "$out"; else echo "PREFLIGHT $slug FAIL" | tee -a "$out"; exit 1; fi
