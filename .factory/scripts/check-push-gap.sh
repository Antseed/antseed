#!/usr/bin/env bash
# Factory self-check: in a step session's environment no push gets out, by any of the known routes.
# Usage: check-push-gap.sh [worktree]   (default: the factory worktree; any checkout whose origin is GitHub)
# Every attempt is `--dry-run` to a throwaway ref, so even a total failure of every layer writes nothing.
# Exit 0 when every attempt is refused and the pre-push hook allows exactly FACTORY_ALLOW_PUBLISH=1.
set -uo pipefail
. "$(dirname "$0")/common.sh"
wt="${1:-$FACTORY}"; real="$(git -C "$wt" remote get-url origin)"; ref="HEAD:refs/heads/factory-push-gap-test"
fail=0
attempt() { # attempt <label> <command...>: must exit non-zero and never print a push result line
  local label="$1"; shift
  out="$( ( eval "$(node "$FACTORY/lib/session-env.mjs")"; "$@" ) 2>&1 )"; st=$?
  if [ "$st" -ne 0 ] && ! grep -Eq '\[new branch\]|\[up to date\]|->' <<<"$out"; then echo "REFUSED  $label (exit $st)"; else echo "PUSHED?  $label (exit $st)"; fail=1; fi
  sed 's/^/    | /' <<<"$out" | head -4
}
echo "== step-session environment, origin $real"
attempt "git -C <wt> push" git -C "$wt" push --dry-run origin "$ref"
attempt "git push (cwd = wt)" bash -c "cd '$wt' && git push --dry-run origin '$ref'"
attempt "git push --force" git -C "$wt" push --force --dry-run origin "$ref"
attempt "git -c remote.origin.pushurl=<real> push" git -C "$wt" -c "remote.origin.pushurl=$real" push --dry-run origin "$ref"
attempt "git push <real url> --no-verify" git -C "$wt" push --no-verify --dry-run "$real" "$ref"
attempt "-c pushurl=<real> -c core.hooksPath=/dev/null --no-verify" git -C "$wt" -c "remote.origin.pushurl=$real" -c core.hooksPath=/dev/null push --no-verify --dry-run origin "$ref"
attempt "env -u GIT_CONFIG_COUNT (strip the git layers)" env -u GIT_CONFIG_COUNT git -C "$wt" push --dry-run "$real" "$ref"
echo "== pre-push hook alone"
( eval "$(node "$FACTORY/lib/session-env.mjs")"; "$FACTORY/hooks/pre-push" origin "$real" </dev/null ) 2>&1 | sed 's/^/    | /'; h1=${PIPESTATUS[0]}
( FACTORY_ALLOW_PUBLISH=1 "$FACTORY/hooks/pre-push" origin "$real" </dev/null ); h2=$?
[ "$h1" -ne 0 ] && [ "$h2" -eq 0 ] && echo "OK       hook refuses in a session (exit $h1), allows with FACTORY_ALLOW_PUBLISH=1 (exit $h2)" || { echo "BAD      hook exits $h1 / $h2"; fail=1; }
echo "== publish.sh outside a session refuses a real publish without FACTORY_ALLOW_PUBLISH=1"
o="$("$FACTORY/scripts/publish.sh" no-such-slug 2>&1)"; echo "$o" | sed 's/^/    | /' | tail -1
grep -q "real publish is disabled" <<<"$o" && echo "OK       publish.sh gate" || { echo "BAD      publish.sh gate"; fail=1; }
[ "$fail" = 0 ] && echo "PUSH_GAP OK: every route refused" || { echo "PUSH_GAP FAIL"; exit 1; }
