#!/usr/bin/env bash
# Run one test command at one commit in a fresh throwaway worktree and say whether it is the red or green you expect.
# Usage: prove.sh <commit> fail|pass "<test command>" [red signature] [owning package]
#   fail: the commit changes only test files and sits directly on origin/main (or $PROVE_BASE). The command exits
#         non-zero (not 127, not a signal or timeout), prints the red signature (the bug's own words, required), and
#         shows no setup error. A test that fails to load is not a red.
#   pass: exits 0.
# The fresh worktree gets `pnpm install`, the forge-std submodule when the command runs forge, and a build of the owning
# package's workspace dependencies, nothing else, so leftovers in your working tree cannot fake a result.
# Prints PROVE OK or PROVE MISMATCH with the reason and the log path. Exit 0 when the result is the one expected,
# 1 when not, 2 when the setup broke. Logs are kept in $PROVE_LOGS (default: a temporary directory).
set -uo pipefail
commit="${1:-}"; expect="${2:-}"; cmd="${3:-}"; signature="${4:-}"; pkg="${5:-}"
usage() { echo "usage: prove.sh <commit> fail|pass \"<test command>\" [red signature] [owning package]" >&2; exit 2; }
[ -n "$cmd" ] || usage
case "$expect" in fail) [ -n "$signature" ] || { echo "PROVE MISMATCH fail mode needs the red signature"; exit 2; } ;; pass) ;; *) usage ;; esac
repo="$(git rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "$commit^{commit}")" || exit 2
TESTS='(\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|/__tests__/|(^|/)tests?/|\.t\.sol$|^e2e/sandbox/scenarios/issue-[^/]+\.mjs$)'
if [ "$expect" = fail ]; then
  base="$(git -C "$repo" rev-parse --verify "${PROVE_BASE:-origin/main}^{commit}")" || exit 2
  parent="$(git -C "$repo" rev-parse "$sha^")"
  [ "$parent" = "$base" ] || { echo "PROVE MISMATCH the red commit's parent ${parent:0:9} is not the base ${base:0:9}"; exit 1; }
  other="$(git -C "$repo" diff-tree --no-commit-id --name-only -r "$sha" | grep -Ev "$TESTS" || true)"
  [ -z "$other" ] || { echo "$other" | head -5; echo "PROVE MISMATCH the red commit changes more than tests"; exit 1; }
fi
logs="${PROVE_LOGS:-$(mktemp -d)}"; mkdir -p "$logs"; tmp="$(mktemp -d)"; tree="$tmp/tree"
out="$logs/${sha:0:9}-$expect.out.txt"; setup="$logs/${sha:0:9}-$expect.setup.txt"
trap 'git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1' EXIT
git -C "$repo" worktree add -q --detach "$tree" "$sha" || exit 2
(cd "$tree" && pnpm install --frozen-lockfile --prefer-offline >"$setup" 2>&1) || { tail -20 "$setup"; echo "PROVE SETUP_FAILED pnpm install ($setup)"; exit 2; }
if [[ "$cmd" == *forge* ]]; then
  (cd "$tree" && git submodule update --init packages/contracts/lib/forge-std >>"$setup" 2>&1) || { tail -20 "$setup"; echo "PROVE SETUP_FAILED forge-std submodule ($setup)"; exit 2; }
fi
if [ -n "$pkg" ]; then
  (cd "$tree" && pnpm --filter "$pkg^..." run build >>"$setup" 2>&1) || { tail -20 "$setup"; echo "PROVE SETUP_FAILED building the dependencies of $pkg ($setup)"; exit 2; }
fi
(cd "$tree" && bash -c "$cmd") >"$out" 2>&1; status=$?
at="$(git -C "$repo" log --format='%h %s' -1 "$sha")"
if [ "$expect" = pass ]; then
  [ "$status" -eq 0 ] && { echo "PROVE OK pass at $at ($out)"; exit 0; }
  tail -25 "$out"; echo "PROVE MISMATCH expected pass at $at, exit $status ($out)"; exit 1
fi
[ "$status" -ne 0 ] || { tail -25 "$out"; echo "PROVE MISMATCH expected a failure at $at, exit 0: the test does not reproduce the bug ($out)"; exit 1; }
[ "$status" -ne 127 ] && [ "$status" -lt 124 -o "$status" -gt 255 ] || { tail -25 "$out"; echo "PROVE MISMATCH exit $status at $at is a missing command, a timeout or a signal, not a red ($out)"; exit 1; }
# Load and compile errors are not a red. ReferenceError and "is not a function" count too: a bug with that symptom
# needs a test that asserts on the behavior instead.
SETUP_ERRORS='Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|Transform failed|No test files found|error TS[0-9]+|Failed to load url|is not a function|ReferenceError|Source "[^"]*" not found|Compiler run failed'
if grep -Eq "$SETUP_ERRORS" "$out"; then grep -En "$SETUP_ERRORS" "$out" | head -5; echo "PROVE MISMATCH failed at $at for a setup reason, not the bug ($out)"; exit 1; fi
grep -Fq -- "$signature" "$out" || { tail -25 "$out"; echo "PROVE MISMATCH failed at $at, but without \`$signature\` ($out)"; exit 1; }
grep -Fn -- "$signature" "$out" | head -5
echo "PROVE OK fail at $at, exit $status, \`$signature\` present ($out)"
