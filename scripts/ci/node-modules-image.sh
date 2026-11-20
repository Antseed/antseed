#!/usr/bin/env bash
# CI only. Keeps the installed node_modules as one compressed, read-only squashfs image, so a job
# mounts it in well under a second instead of extracting ~270k files (7-8s on a hosted runner).
# Each node_modules directory is mounted through an overlay, so writes into it (vitest's results
# cache, vite's cache) land in a writable layer outside the image.
#
#   node-modules-image.sh save  <image>   pack every node_modules of the workspace into <image>
#   node-modules-image.sh mount <image>   mount <image> over the checkout, one overlay per directory
#
# Any failure fails the job: a half-mounted tree must not run tests.
set -euo pipefail

cmd="${1:?usage: node-modules-image.sh save|mount <image>}"
image="${2:?usage: node-modules-image.sh save|mount <image>}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

# The directories pnpm creates. Listed by the workspace globs, so a new package is covered.
list_dirs() {
  ls -d node_modules apps/*/node_modules packages/*/node_modules plugins/*/node_modules e2e/node_modules 2>/dev/null
}

case "$cmd" in
  save)
    command -v mksquashfs >/dev/null || { sudo apt-get install -y -qq squashfs-tools >/dev/null; }
    stage="$(mktemp -d "${RUNNER_TEMP:-/tmp}/node-modules-stage.XXXXXX")"
    # Hard links: the stage costs no copy. Paths in the image are relative to the repository root.
    while read -r dir; do
      mkdir -p "$stage/$(dirname "$dir")"
      cp -al "$dir" "$stage/$dir"
    done < <(list_dirs)
    rm -f "$image"
    mksquashfs "$stage" "$image" -comp zstd -Xcompression-level 15 -b 1M -processors "$(nproc)" -quiet
    rm -rf "$stage"
    ls -l "$image"
    ;;
  mount)
    lower="$RUNNER_TEMP/node-modules-image"
    upper="$RUNNER_TEMP/node-modules-upper"
    mkdir -p "$lower" "$upper"
    sudo mount -t squashfs -o loop,ro "$image" "$lower"
    count=0
    while read -r dir; do
      count=$((count + 1))
      mkdir -p "$dir" "$upper/$count/data" "$upper/$count/work"
      sudo mount -t overlay overlay \
        -o "lowerdir=$lower/$dir,upperdir=$upper/$count/data,workdir=$upper/$count/work" "$dir"
    done < <(cd "$lower" && find . -name node_modules -type d -prune | sed 's|^\./||' | sort)
    echo "mounted $count node_modules directories from $image"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 2
    ;;
esac
