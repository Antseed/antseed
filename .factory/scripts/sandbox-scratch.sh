#!/usr/bin/env bash
# The scratch worktree for sandbox runs: the sandbox stack, origin/main merged in, then the fix commits.
# Local only: branch scratch/<slug>, no upstream, never pushed; the fix branch and the PR never see it.
# Usage: sandbox-scratch.sh <slug> setup               create from the sandbox stack, merge origin/main, install, build
#        sandbox-scratch.sh <slug> setup --continue    after merge conflicts were resolved and committed
#        sandbox-scratch.sh <slug> base                 reset to the merged base (no fix), rebuild what changed
#        sandbox-scratch.sh <slug> pick                 reset to the merged base, cherry-pick test + fix, rebuild
#        sandbox-scratch.sh <slug> down                 pnpm sandbox down, list, confirm nothing is on the remote
# setup exits 3 on merge conflicts (the driver hands them to a merge-resolve session).
set -uo pipefail
. "$(dirname "$0")/common.sh"
slug="$1"; action="$2"; rd="$(run_dir "$slug")"; out="$rd/verify"; mkdir -p "$out"
wt="$(state "$slug" worktree)"; base="$(state "$slug" base)"
scratch="$WT_ROOT/scratch-$slug"; sbranch="scratch/$slug"
note() { printf '%s\t%s\t%s\n' "$(date -Iseconds)" "$1" "$2" >> "$out/scratch.tsv"; echo "SCRATCH $1: $2"; }
plan_list() { node -e 'const p=require(process.argv[1]); for (const c of (process.argv[2]==="build"?p.build:(p.sandbox?.scratch_build??[]))) console.log(c)' "$out/plan.json" "$1"; }
build_full() {
  (cd "$scratch" && git submodule update --init packages/contracts/lib/forge-std && pnpm install --frozen-lockfile --prefer-offline && pnpm run build) > "$out/scratch-build-$1.log" 2>&1 || return 1
  while IFS= read -r c; do [ -n "$c" ] && { (cd "$scratch" && bash -c "$c") >> "$out/scratch-build-$1.log" 2>&1 || return 1; }; done < <(plan_list scratch)
}
# Rebuild the packages the fix changes (and the row's extra builds), so dist matches src for the doctor.
build_changed() {
  : > "$out/scratch-build-$1.log"
  while IFS= read -r c; do [ -n "$c" ] && { (cd "$scratch" && bash -c "$c") >> "$out/scratch-build-$1.log" 2>&1 || return 1; }; done < <(plan_list build; plan_list scratch)
}
finish_setup() {
  [ -z "$(git -C "$scratch" diff --name-only --diff-filter=U)" ] && ! git -C "$scratch" rev-parse -q --verify MERGE_HEAD >/dev/null || die "merge still unresolved in $scratch"
  git -C "$scratch" merge-base --is-ancestor origin/main HEAD || die "origin/main is not merged into $scratch"
  git -C "$scratch" merge-base --is-ancestor "$SANDBOX_REF" HEAD || die "$SANDBOX_REF is not in $scratch"
  state "$slug" scratch_base "$(git -C "$scratch" rev-parse HEAD)"
  note merged "$SANDBOX_REF $(git -C "$scratch" rev-parse --short "$SANDBOX_REF") + origin/main $(git -C "$scratch" rev-parse --short origin/main) = $(git -C "$scratch" rev-parse --short HEAD)"
  build_full setup || die "scratch install/build failed, see $out/scratch-build-setup.log"
  note built "pnpm install + pnpm run build ok"
  echo "SCRATCH_READY $scratch"
}
case "$action" in
  setup)
    if [ "${3:-}" = "--continue" ]; then finish_setup; exit $?; fi
    [ -e "$scratch" ] && die "$scratch exists; use setup --continue, base or pick"
    git -C "$wt" fetch -q origin
    git -C "$wt" worktree add -q --no-track -b "$sbranch" "$scratch" "$SANDBOX_REF" || die "worktree add failed"
    state "$slug" scratch "$scratch"; state "$slug" scratch_branch "$sbranch"
    if ! git -C "$scratch" merge-base --is-ancestor origin/main HEAD; then
      if ! git -C "$scratch" merge --no-edit origin/main > "$out/merge.log" 2>&1; then
        note conflict "$(git -C "$scratch" diff --name-only --diff-filter=U | tr '\n' ' ')"
        echo "SCRATCH_MERGE_CONFLICT $scratch: resolve, commit, then: $0 $slug setup --continue"; exit 3
      fi
    fi
    finish_setup ;;
  base|pick)
    sb="$(state "$slug" scratch_base)"; [ -n "$sb" ] || die "no scratch_base; run setup first"
    git -C "$scratch" reset -q --hard "$sb"
    if [ "$action" = pick ]; then
      mapfile -t cs < <(commits "$wt" "$base")
      git -C "$scratch" cherry-pick "${cs[@]}" > "$out/pick.log" 2>&1 || { git -C "$scratch" cherry-pick --abort; die "cherry-pick of the fix commits failed, see $out/pick.log"; }
    fi
    build_changed "$action" || die "rebuild failed, see $out/scratch-build-$action.log"
    note "$action" "$(git -C "$scratch" log --oneline -1) (rebuilt: $(plan_list build | tr '\n' ';'))"
    echo "SCRATCH_AT $action $(git -C "$scratch" rev-parse HEAD)" ;;
  down)
    (cd "$scratch" && pnpm sandbox down) > "$out/down.log" 2>&1; st=$?
    (cd "$scratch" && pnpm sandbox list) >> "$out/down.log" 2>&1
    git -C "$scratch" rev-parse -q --verify "@{u}" >/dev/null 2>&1 && die "scratch branch has an upstream"
    [ -z "$(remote_branch_sha "$scratch" "$sbranch")" ] || die "scratch branch is on the remote"
    note down "pnpm sandbox down exit $st; $sbranch has no upstream and is not on the remote"
    exit $st ;;
  *) die "unknown action $action" ;;
esac
