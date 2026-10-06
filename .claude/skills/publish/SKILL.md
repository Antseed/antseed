---
name: publish
description: Prepare an npm release — decide which @antseed/* packages need version bumps, apply them, validate the set, and open the bump PR. Publishing itself happens in CI.
---

# Prepare an npm Release (version bumps only)

Decide which public `@antseed/*` packages need a release, bump their versions, and open a PR. **This skill never runs `pnpm publish`** — actual publishing happens in the `Publish npm packages` GitHub Actions workflow (`.github/workflows/npm-publish.yml`), which the user triggers manually from the Actions tab after the bump PR merges. The committed version bumps ARE the publish decision: the workflow publishes exactly the packages whose version is not on the registry yet and skips everything else.

## Prerequisites

- Working directory is the monorepo root; `git fetch origin main` first so the analysis runs against the merged state.
- No npm login is needed — CI publishes with the `NPM_TOKEN` repo secret.

## Workflow

### 1. Find what changed since each package's last release

For every public package, list commits touching it since its version was last bumped:

```bash
for p in packages/protocol packages/api-adapter packages/buyer-core packages/node \
         packages/provider-core packages/router-core packages/ant-agent \
         packages/web-sdk plugins/* apps/cli apps/payments apps/network-stats \
         apps/ants apps/relay; do
  bump=$(git log origin/main -1 --format=%H -G'"version": ' -- $p/package.json)
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

Known chains: cli + payments + ants pin node; node pins protocol/buyer-core/api-adapter; web-sdk pins buyer-core/protocol; all provider plugins pin provider-core; router-local pins router-core; cli also pins ants, payments, api-adapter, ant-agent, provider-core.

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
- a to-be-published package whose exact-pin dependent has no bump (cascade violation), or
- a local version behind npm latest (a previous release never committed its bumps).

The PUBLISH rows must exactly match the intended set, exit code 0. The CI workflow runs this same script as a gate before publishing.

### 5. Open the bump PR

Never commit to main. Branch, commit the changed `package.json` files, push, open a PR:

```bash
git checkout -b release/npm-bump-<YYYY-MM-DD> origin/main
git add <changed package.json files>
git commit -m "chore: bump versions for npm release"
git push -u origin release/npm-bump-<YYYY-MM-DD>
```

PR body: list the bumped packages grouped as "changed directly" (with a one-line reason each) vs "cascade (exact pins)", name the skipped packages, and note that the plan script validated the set. See PR #869 as a template.

### 6. Hand off to CI — do not publish

After the PR merges, the **user** triggers the release from GitHub: Actions → `Publish npm packages` → Run workflow on `main` (optionally with `dry_run` first to see the plan in the logs). The workflow installs, re-validates the plan, bakes `ANTSEED_COMPARABLE_PRICES_URL` into the release artifacts, builds, runs the full test suite, and publishes with `pnpm publish`.

Do not run `pnpm publish`, `npm publish`, or the workflow yourself.

### 7. Verify after the workflow succeeds (read-only)

```bash
node scripts/npm-publish-plan.mjs        # should report 0 packages to publish
tmpdir=$(mktemp -d) && cd "$tmpdir" && npm install @antseed/cli@latest --ignore-scripts \
  && npm ls @antseed/node && cd - && rm -rf "$tmpdir"
```

Confirm exactly ONE `@antseed/node` version appears (the 0.1.139 incident check), no `workspace:` specs in published manifests, and — if the cli was released — that `node_modules/@antseed/cli/dist/generated/baked-defaults.js` contains the comparable-prices URL.

## Important notes

- The old flow (local `pnpm publish` from the `antseed-publish` worktree) is retired; CI owns publishing. If an emergency ever forces a local publish, it must be `pnpm publish` (never `npm publish`) and the version bumps must still land on main.
- Private packages (`e2e`, `@antseed/desktop`, `@antseed/website`, `@antseed/diem-staking`, `@antseed/ui`) are never published; pnpm skips them automatically.
- Update this skill and the workflow's `--filter` set if a new public package appears.

## Publishable packages (for reference)

```
packages/*   @antseed/node, @antseed/protocol, @antseed/buyer-core,
             @antseed/api-adapter, @antseed/ant-agent,
             @antseed/provider-core, @antseed/router-core, @antseed/web-sdk
plugins/*    provider-anthropic, provider-claude-code, provider-claude-oauth,
             provider-openai, provider-openai-responses, provider-local-llm,
             router-local
apps/*       @antseed/cli, @antseed/network-stats, @antseed/payments
             @antseed/ants, @antseed/relay
```
