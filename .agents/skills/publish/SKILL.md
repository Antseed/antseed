---
name: publish
description: Release Antseed — decide which @antseed/* packages need version bumps, apply them, validate the set, cut the CHANGELOG release section, and open the bump PR (publishing happens in CI); after a CLI release, pin and publish the TEE seller image and release the desktop app.
disable-model-invocation: true
---

# Release Antseed (npm packages, TEE image, desktop)

Decide which public `@antseed/*` packages need a release, bump their versions, and open a PR. **This skill never runs `pnpm publish`** — actual publishing happens in the `Publish npm packages` GitHub Actions workflow (`.github/workflows/npm-publish.yml`), which the user triggers manually from the Actions tab after the bump PR merges. The committed version bumps ARE the publish decision: the workflow publishes exactly the packages whose version is not on the registry yet and skips everything else.

## Prerequisites

- Working directory is the monorepo root; `git fetch origin main` first so the analysis runs against the merged state.
- No npm login is needed — CI publishes with the `NPM_TOKEN` repo secret.

## Workflow

### 1. Find what changed since each package's last release

For every public package, list commits touching it since its version was last bumped:

```bash
for f in $(git ls-files 'packages/*/package.json' 'plugins/*/package.json' 'apps/*/package.json'); do
  node -e "process.exit(require('./$f').private ? 1 : 0)" || continue
  p=$(dirname $f)
  bump=$(git log origin/main -1 --format=%H -G'"version": ' -- $f)
  echo "=== $p"
  git log --oneline --no-merges $bump..origin/main -- $p
done
```

Judgment call per package: test-only and docs-only commits don't warrant a release on their own (the cascade below may still force the package). Runtime behavior changes do.

### 2. Compute the bump set (direct changes + pin cascade)

pnpm resolves `workspace:*` **regular dependencies** to exact versions at publish time. If a package is republished but a public dependent that pins it is not, npm installs of the dependent keep the old version and the fix silently never ships. So the bump set is the closure:

1. Start with the packages that changed (step 1).
2. Add every public dependent that declares one of them as a regular `workspace:` dependency, recursively.
3. Peer dependencies with ranges (e.g. provider-core/router-core/ant-agent declare `@antseed/node >=0.1.0`) do NOT cascade.

Known chains: cli + payments + ants pin node; node pins protocol/buyer-core/api-adapter; web-sdk pins buyer-core/protocol; all provider plugins pin provider-core; router-local pins router-core; cli also pins ants, gateway-console, payments, api-adapter, ant-agent, provider-core, connected-apps, telemetry; connected-apps pins protocol.

**Build-time bundles (not visible to the plan script):** `@antseed/gateway-console` compiles the ants web UI into its own bundle (`apps/gateway-console/vite.config.ts` aliases `@antseed/ants-web` → `apps/ants/web/src`). Any release-worthy change under `apps/ants/web/` therefore also requires a `@antseed/gateway-console` bump (which then cascades to cli), or the gateway's Staking page keeps the old UI. Before bumping, check for other such aliases: `grep -n "path.resolve(__dirname, '../" apps/*/vite.config.ts`.

Don't compute this by hand and hope — step 4 validates it mechanically.

### 3. Bump versions

Use a patch bump by default for every package, including packages with feature changes. Only use a minor or major bump when the user explicitly requests it. Bump only the computed set:

```bash
pnpm --filter @antseed/protocol \
     --filter @antseed/node \
     --filter @antseed/cli \
  exec npm version <patch|minor|major> --no-git-tag-version
```

Sanity-check which apps are public vs private if unsure (the set occasionally changes):

```bash
for d in apps/*/; do node -e "const p=require('./$d/package.json'); console.log((p.private?'[PRIV]':'[PUB] ')+p.name+'@'+p.version)"; done
```

### 4. Validate the set

```bash
node scripts/npm-publish-plan.mjs
```

This prints local vs registry versions with a PUBLISH/skip verdict per package and **hard-fails** on:
- a to-be-published package whose exact-pin dependent has no bump (cascade violation),
- a to-be-published package that pins a dependency whose source changed since its last bump (the dependent would ship against code npm doesn't have), or
- a local version behind npm latest (a previous release never committed its bumps).

The PUBLISH rows must exactly match the intended set, exit code 0. The CI workflow runs this same script as a gate before publishing.

### 5. Cut the changelog section

Every release moves what it ships out of `## Unreleased` in `CHANGELOG.md`, in the bump PR itself, so `## Unreleased` only ever holds what is not released yet. Never open a bump PR without this step.

1. Under `## Unreleased`, add a section for the release, newest first, in the format the file already uses:

   ```markdown
   ## Unreleased

   ## <YYYY-MM-DD> — CLI <cli version>, Node <node version>

   ### Packages

   - `@antseed/cli@<version>`
   - `@antseed/node@<version>`

   ### Added
   ...
   ```

   Name only the versions this release publishes (leave Node out when it isn't bumped). A second npm release the same day goes into a new section of its own above the first.
2. Move every entry from `## Unreleased` into it, keeping its subsection (`### Added`, `### Changed`, `### Fixed`, ...) and its text unchanged. Everything merged to main is in this release, so `## Unreleased` ends up empty; keep the heading.
3. Check that nothing was lost: the sorted bullet lines of the file are the same before and after, apart from the `### Packages` lines you added (`bullets() { grep '^ *- ' | grep -v '^- `@antseed/[a-z-]*@[0-9.]*`$' | sort; }; diff <(git show origin/main:CHANGELOG.md | bullets) <(bullets < CHANGELOG.md)` prints nothing).

A desktop release does the same in its bump PR (`apps/desktop/package.json`): add `### Desktop` with `` - `@antseed/desktop@<version>` `` to that day's section (adding `, Desktop <version>` to its heading), or open a `## <YYYY-MM-DD> — Desktop <version>` section when no npm release went out that day, and move any desktop entries still under `## Unreleased` into it.

### 6. Open the bump PR

Never commit to main. Branch, commit the changed `package.json` files and `CHANGELOG.md`, push, open a PR:

```bash
git checkout -b release/npm-bump-<YYYY-MM-DD> origin/main
git add <changed package.json files> CHANGELOG.md
git commit -m "chore: bump versions for npm release"
git push -u origin release/npm-bump-<YYYY-MM-DD>
```

PR body: say the changelog section was cut, list the bumped packages grouped as "changed directly" (with a one-line reason each) vs "cascade (exact pins)", name the skipped packages, and note that the plan script validated the set. See PR #869 as a template.

### 7. Merge and publish through CI

The bump PR needs no review (AGENTS.md, Maintainers only): merge it with a merge commit once CI passes. Then confirm main has the new versions (`git show origin/main:apps/cli/package.json`) and run the `Publish npm packages` workflow on main: `gh workflow run npm-publish.yml --ref main` (with `-f dry_run=true` first to see the plan, if in doubt). Run it only when the user gave the go for this release. The workflow installs, re-validates the plan, bakes `ANTSEED_COMPARABLE_PRICES_URL` into the release artifacts, builds, runs the full test suite, publishes with `pnpm publish`, and creates the `cli-v<version>` GitHub release with notes from `scripts/github-release-notes.mjs` (packages, pull requests, Thanks).

Never run `pnpm publish` or `npm publish` yourself.

### 8. Verify after the workflow succeeds (read-only)

```bash
node scripts/npm-publish-plan.mjs        # should report 0 packages to publish
tmpdir=$(mktemp -d) && cd "$tmpdir" && npm install @antseed/cli@latest --ignore-scripts \
  && npm ls @antseed/node && cd - && rm -rf "$tmpdir"
```

Confirm exactly ONE `@antseed/node` version appears (the 0.1.139 incident check), no `workspace:` specs in published manifests, and — if the cli was released — that `node_modules/@antseed/cli/dist/generated/baked-defaults.js` contains the comparable-prices URL.

### 9. Release the TEE seller image (when `@antseed/cli` was released)

The TEE seller image (`deploy/tee-seller`) installs an exact CLI from a committed lockfile and never updates itself, so TEE sellers get a release only through a new image. After every release that includes a new `@antseed/cli`:

1. Wait until the new CLI installs from the registry: a fresh `npm install @antseed/cli@<version> --prefer-online` must succeed (the registry can serve the manifest minutes before every tarball).
2. Pin the lock to it and check it:

   ```bash
   git checkout -b feat/tee-seller-lock-<version> origin/main
   node deploy/tee-seller/update-lock.mjs <version>   # pins the CLI and the verifier it pins
   tmp=$(mktemp -d) && cp deploy/tee-seller/{package.json,package-lock.json,check-lock.mjs} "$tmp" \
     && (cd "$tmp" && npm ci --ignore-scripts && node check-lock.mjs) && rm -rf "$tmp"
   ```

3. Commit `deploy/tee-seller/package.json` and `package-lock.json`, open the PR and merge it right away, like the bump PR: it only pins published versions, and `check-lock.mjs` gates the image build.
4. Run the **Publish TEE seller image** workflow on main: `gh workflow run tee-seller-image.yml --ref main`. It builds, pushes and signs the image; its run summary shows the digest.
5. Verify the image before announcing it:
   - its build record verifies with the verifier the CLI pins: `verifyImageBuild(await imageBuildRecord(<digest>))` must list the digest (or `gh attestation verify oci://ghcr.io/antseed/tee-seller@<digest> --repo Antseed/antseed`). The package's exports don't include `dist/image-provenance.js`, so import it by file path from an install of the lock:

     ```bash
     tmp=$(mktemp -d) && cp deploy/tee-seller/{package.json,package-lock.json} "$tmp" \
       && (cd "$tmp" && npm ci --ignore-scripts && node --input-type=module -e '
         const { imageBuildRecord, verifyImageBuild } = await import("./node_modules/@antseed/antseed-verifier/dist/image-provenance.js")
         console.log(JSON.stringify(await verifyImageBuild(await imageBuildRecord(process.argv[1])), null, 2))' sha256:<digest>) \
       && rm -rf "$tmp"
     ```
   - it pulls without logging in (GHCR answers the manifest anonymously);
   - its config still exposes `6882/tcp` and `6881/udp` (Google Confidential Space opens only exposed ports).
6. Report the digest so TEE sellers can move to it (docs: "Upgrade to a new image"). No approval PR is needed: buyers accept images the workflow builds from main by their build record.

### 10. Release the desktop app (when `@antseed/cli` was released)

The desktop bundles the CLI from the repository, so every CLI release ships in a desktop release too.

1. Bump `apps/desktop/package.json` (patch) on a `chore/desktop-<version>` branch from the merged main, and cut the changelog as in step 5: add `### Desktop` with `` - `@antseed/desktop@<version>` `` to the day's section and `, Desktop <version>` to its heading. Open `chore(desktop): Bump to <version>` (body: the CLI it bundles and the main PRs) and merge it once CI passes, like the npm bump PR.
2. Confirm the merge landed: `git show origin/main:apps/desktop/package.json` must show the new version. The workflow builds whatever main says, so a run started before the merge rebuilds and overwrites the previous release's files.
3. Run `gh workflow run release-desktop.yml --ref main -f platforms=all`. It creates the draft `v<version>` with notes from `scripts/github-release-notes.mjs --desktop` (pull requests since the previous desktop bump, and Thanks for outside authors of desktop changes), builds and signs every platform, and publishes the release as latest once all of them uploaded.
4. Check the published release: not a draft, marked latest, notes present, and the assets for macOS (dmg, zip, `desktop-mac.yml` and the bridge `latest-mac.yml`), Windows (exe, `latest.yml`) and Linux (AppImage, deb, `latest-linux*.yml`). A failed platform leaves the draft unpublished: rerun the failed job, and the release publishes when it passes.

Reviewant posts each release's thank-yous on its own (step 7 for npm, here for desktop): when a release with a Thanks section is published, every credited PR gets a comment from the maintainer who merged it.

## Important notes

- The old flow (local `pnpm publish` from the `antseed-publish` worktree) is retired; CI owns publishing. If an emergency ever forces a local publish, it must be `pnpm publish` (never `npm publish`) and the version bumps must still land on main.
- Private packages (`e2e`, `@antseed/desktop`, `@antseed/website`, `@antseed/ui`) are never published; pnpm skips them automatically.
- Update this skill and the workflow's `--filter` set if a new public package appears.

## Publishable packages (for reference)

```
packages/*   @antseed/node, @antseed/protocol, @antseed/buyer-core,
             @antseed/api-adapter, @antseed/ant-agent,
             @antseed/provider-core, @antseed/router-core, @antseed/web-sdk
plugins/*    provider-anthropic, provider-claude-code, provider-claude-oauth,
             provider-openai, provider-openai-responses, provider-local-llm,
             provider-typesafe, provider-venice-video, provider-fal-video,
             provider-fal-image, provider-alibaba-video, provider-irp-router,
             provider-free-model-router, router-local
apps/*       @antseed/cli, @antseed/network-stats, @antseed/payments
             @antseed/ants, @antseed/relay, @antseed/gateway-console
```
