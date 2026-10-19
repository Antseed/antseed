#!/usr/bin/env bash
# Self-check of the no-push layers, against a local bare repo, so a network failure cannot pass for a refusal.
# Usage: .factory/check-push-gap.sh
# A positive control first pushes to the fixture without the session settings: it must land. Then every route runs
# with the session env, and must not land.
# This proves the env layers and deny rules, not a boundary: a session with Bash can unset the env (README, Known limits).
set -uo pipefail
FACTORY="$(cd "$(dirname "$0")" && pwd)"; fail=0
tmp="$(mktemp -d)"; s="$tmp/settings.json"; remote="$tmp/remote.git"; wt="$tmp/wt"
git init -q --bare "$remote"; git init -q "$wt"; git -C "$wt" commit -q --allow-empty -m fixture
git -C "$wt" remote add origin "$remote"; git -C "$wt" remote add fx "file://$remote"
"$FACTORY/start.sh" --settings "$s"
landed() { git -C "$remote" rev-parse -q --verify "refs/heads/$1" >/dev/null; }
git -C "$wt" push -q origin HEAD:refs/heads/control 2>/dev/null
landed control && echo "CONTROL  plain push lands on the fixture" || { echo "CONTROL FAILED  the fixture refuses a plain push, so nothing below proves anything"; exit 1; }

envs=(); while IFS= read -r -d '' kv; do envs+=("$kv"); done < <(node -e 'for (const [k, v] of Object.entries(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).env)) process.stdout.write(`${k}=${v}\0`)' "$s")
env "${envs[@]}" env -u GIT_CONFIG_COUNT git -C "$wt" -c core.hooksPath=/dev/null push -q "$remote" HEAD:refs/heads/envcontrol 2>/dev/null
landed envcontrol && echo "CONTROL  the session env runs git, and a push with the git layers removed lands" || { echo "CONTROL FAILED  git does not run under the session env"; exit 1; }
n=0
attempt() { # attempt <label> <git args...>: run with the session env; the ref must not land
  local label="$1"; shift; n=$((n + 1)); local ref="t$n"
  env "${envs[@]}" "$@" "HEAD:refs/heads/$ref" >/dev/null 2>&1
  if landed "$ref"; then echo "PUSHED   $label"; fail=1; else echo "REFUSED  $label"; fi
}
attempt "git push" git -C "$wt" push origin
attempt "git push --force" git -C "$wt" push --force origin
attempt "file:// remote" git -C "$wt" push fx
attempt "-c remote.origin.pushurl=<fixture>" git -C "$wt" -c "remote.origin.pushurl=$remote" push origin
attempt "<path> --no-verify" git -C "$wt" push --no-verify "$remote"
attempt "-c pushurl -c core.hooksPath=/dev/null --no-verify" git -C "$wt" -c "remote.origin.pushurl=$remote" -c core.hooksPath=/dev/null push --no-verify origin
echo "EXPOSED  env -u GIT_CONFIG_COUNT (shown by the second control: the env is a speed bump, see README Known limits)"
for rule in 'Bash(git push:*)' 'Bash(git -c *)' 'Bash(gh pr:*)' 'Bash(*--real-funds*)' 'Bash(*.antseed/*)' 'Bash(security *)'; do
  grep -qF "\"$rule\"" "$s" && echo "DENIED   $rule" || { echo "MISSING  $rule"; fail=1; }
done
[ "$fail" = 0 ] && echo "PUSH_GAP OK" || { echo "PUSH_GAP FAIL"; exit 1; }
