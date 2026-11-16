# Contributing to Antseed

This guide is for people who want to change this repository, and for AI agents working for
them. Read it before you open an issue, a discussion or a pull request (PR).

## Read this first

- Antseed is maintained by a very small team with limited review time. Opening a PR does not
  oblige maintainers to review or merge it.
- Most likely to be accepted: focused bug fixes, reliability fixes and performance fixes.
- Least likely to be accepted: features nobody agreed to, rewrites, and unrelated cleanup.
  Feature requests and feature PRs that do not fit are closed with a one-line reason. That is
  normal and not personal. Asking in an issue before you build saves you the work.
- This software moves real user funds on Base mainnet (payment channels, deposits, staking).
  A mistake in payment code can lose money, so payment code gets the strictest review.
- Ask questions in [Q&A discussions](https://github.com/Antseed/antseed/discussions/categories/q-a), not in issues.

<a id="lanes"></a>
## Where to start

| You want to | Start with | Before you open a PR |
|---|---|---|
| Fix a bug ([what counts](#feature)), a typo or a docs error | A PR with [evidence](#evidence). Link the [bug report](https://github.com/Antseed/antseed/issues/new/choose) if there is one; you do not need to file one first | Nothing. On a [money path](#money-paths) the failing test is mandatory |
| Add a feature or change behaviour ([what counts](#feature)) | A [feature request issue](https://github.com/Antseed/antseed/issues/new/choose) (form) | Nothing required, but a feature nobody agreed to may be closed with a short no. A maintainer's yes in the issue tells you the direction is wanted |
| Report a security problem or funds at risk | A [private report](#security) | Never a public issue, discussion or PR |
| Build a plugin | Your own npm package | Nothing; there is nothing to merge here. See [Plugins](#plugins) |

<a id="approval"></a>
## Features: ask first

**For a new feature or behaviour change, open a feature request issue first and describe the
problem. Bug fixes, docs and tests need no issue: open the PR with [evidence](#evidence).**
This is the same everywhere in the repository, including the [money paths](#money-paths).

- You do not have to wait for a reply before opening the PR. But a feature nobody agreed to
  may be closed with a short no, so asking first saves you work.
- A yes is a reply from a maintainer that agrees to the change. A label, an upvote, "thanks"
  or "interesting" is not a yes. If the reply names a scope, build only that.
- Link the issue in the PR, for example `Closes #123`. Say in the issue if you want to build
  it yourself.
- Maintainers aim to reply to new issues within 3 business days.
- A maintainer is someone with write access to Antseed/antseed. Maintainers' own PRs do not
  need a feature request. Every other rule in this guide applies to them, including the
  [evidence](#evidence) rules.

<a id="feature"></a>
## What counts as a feature or behaviour change

A change is a feature or behaviour change, and starts with a feature request issue, if after
it the software does something new, or does something different on purpose. That includes a
change that:

- adds something users or operators could not do before: a command, flag, setting, config
  option, API endpoint or field, screen or control, provider, integration or app;
- changes what existing behaviour does: defaults, prices, limits, routing, ranking or seller
  selection, output formats, wire or metadata formats;
- removes or renames something people rely on;
- adds a dependency or a new service;
- restructures code beyond what a fix needs: refactors, rewrites, renames, reformatting.

No issue needed first:

- a bug fix: the software crashes, returns an error, is clearly broken, or does something its
  docs or specification say it should not. The PR has a test that fails before the fix (see
  [Evidence](#evidence) if no test is possible);
- docs, typos and comments;
- tests;
- a performance or reliability fix that changes no default, limit, timeout or output.

If a change fits both lists, treat it as a feature. Calling a behaviour change a bug fix does
not change what it is: maintainers may close a PR they read as a feature nobody agreed to,
with a link to this section. If the idea can be a provider or router plugin, build it as a
[plugin](#plugins): no issue needed. Not sure? Open a
[feature request](https://github.com/Antseed/antseed/issues/new/choose) and ask before writing
code.

<a id="money-paths"></a>
## Money paths and protocol

The rules are the same here as everywhere: a bug fix needs no issue first, and a feature or
behaviour change starts with a feature request. Two things are stricter:

- A bug fix here must include a test that fails before the fix. There are no exceptions.
- Changes here get the strictest review. Say in the PR that your change touches a money path,
  and expect to be asked for more tests.

A change to what the specification in `docs/protocol` says is a behaviour change.

Any change to how funds, keys, signatures, deposits, payment channels, prices, metering or
contract addresses are handled is a money-path change, wherever the file is. So is a change to
the dependencies of that code. The list below is a minimum, not the full set:

- Contracts: `packages/contracts`, `scripts/deploy-contracts.mjs`, `scripts/deployments/`, and
  the `@openzeppelin/contracts` version (in `packages/node/package.json`; the contracts
  compile it from `node_modules`).
- Node SDK: `packages/node/src/` `payments/`, `billing/`, `metering/`,
  `seller-request-handler.ts`, `p2p/identity.ts`, `config/encryption.ts`,
  `storage/migrations/channels/`.
- Buyer and wallet libraries: `packages/buyer-core`, `packages/wallet-config`,
  `packages/web-sdk`.
- CLI: `apps/cli/src/gateway/`, `apps/cli/src/proxy/` (deposit and chain code),
  `apps/cli/src/cli/commands/payments.ts`, `apps/cli/src/cli/commands/ants/`.
- Desktop: `apps/desktop/src/main/payments/`, `apps/desktop/src/main/identity.ts`.
- Web apps: `apps/payments`, `apps/ants`, `apps/diem-staking`, `apps/gateway-console/src/wallet/`.
- Protocol and wire format: `packages/protocol`, `docs/protocol`.

<a id="one-problem"></a>
## One problem per PR

- Fix one underlying problem per PR. Put unrelated cleanup, formatting or a second fix in its
  own PR.
- Use a conventional PR title: `fix(buyer-core): ...`, `feat(cli): ...`, `docs: ...`.
- From a fork, leave "Allow edits by maintainers" ticked. `main` only merges branches that
  are up to date with it, so a maintainer merges `main` into yours before merging. The PR
  guard check fails until it is ticked and the check runs again: push a commit, or ask a
  maintainer to re-run it.
- Update `CHANGELOG.md` for user-facing changes: add a bullet under `## Unreleased`, in
  `### Added`, `### Changed` or `### Fixed`, that names the affected packages and says what
  changed for users, like the entries already there. If there is no user-facing change, say
  so in the PR description.

<a id="evidence"></a>
## Evidence

- **Bug fix:** add a test that fails without the fix and passes with it. Name the test in the
  PR. Paste the failing output (before the fix) and the passing output (after the fix). The
  test's name must appear in the output you paste. A test that never runs proves nothing.
- **UI bug fix:** both a test and before and after screenshots.
- **Other UI change:** before and after screenshots. Add a short recording when motion or
  timing matters.
- **Feature:** tests for the new behaviour, and the commands you ran.
- **No test possible:** say why, and what you checked by hand. A maintainer decides whether the
  PR can go in without a test. On the [money paths](#money-paths), it can't.
- Hide wallet addresses, balances and keys in screenshots and logs.
- Put long output in a `<details>` block.
- "Tests pass" or a ticked checkbox alone is not evidence. Say what you could not check.
- CI fails for a reason unrelated to your change: say so in the PR. Do not fix unrelated
  failures in the same PR.
- The `PR guard` check reads every PR's diff for signs of a supply-chain attack. It fails on
  invisible or bidirectional Unicode characters, packages resolved from anywhere but the npm
  registry, and new install scripts (`preinstall`, `install`, `postinstall`, `prepare`) from
  outside contributors. A dependency that needs an install script goes in
  `pnpm.onlyBuiltDependencies` in its own PR, after a maintainer agrees in an issue. Changes to
  CI, agent instructions, dependencies and build tooling get a maintainer's closer read.

Use the test runner in the package's own `test` script. Most packages use vitest. A few, such
as `apps/cli`, use `node --test` on built output, so run `pnpm run build` once first.

```bash
pnpm --filter <package> test                          # one package, e.g. @antseed/buyer-core
pnpm --filter @antseed/desktop run test:renderer      # desktop UI (renderer) tests
cd packages/contracts && forge test                    # smart contracts, see setup below
pnpm run typecheck                                     # type-check all packages
pnpm run build && pnpm run test                        # full build and test suite
```

<a id="closure"></a>
## What happens to a PR that misses a rule

A maintainer may close it with a link to the rule it misses, or with a one-line no if the
feature does not fit. Fix the gap and ask for another look. A no stands unless you bring new
information.

<a id="security"></a>
## Security and funds at risk

If you find a security problem, or any way funds could be stolen, lost or locked, do not open
a public issue, discussion or PR. Report it privately at
<https://github.com/Antseed/antseed/security/advisories/new>.

Do not push a fix to a public fork or branch, and do not describe the problem in a commit
message or branch name: those are already public. Attach the fix to the private report, or
use the temporary private fork GitHub offers on the advisory. [SECURITY.md](SECURITY.md) says
what counts and what to include.

## AI-assisted work

AI-assisted work is welcome. Maintainers judge the problem, the scope and the evidence, not
who or what wrote the code. The person who opens the PR is responsible for it.

If an agent works for you, three things apply to it:

- It follows the same rules as you. If it cannot confirm that you have write access to
  Antseed/antseed, it treats you as an outside contributor. If it is not sure whether a change
  is a bug fix or a behaviour change, it treats it as a behaviour change.
- It fills in `.github/PULL_REQUEST_TEMPLATE.md` itself. `gh pr create --body` skips the
  template.
- It never files a security report or pushes a security fix for you. It tells you, and you
  report privately as [Security](#security) describes.

## Developer setup

You need Node.js 24 (pinned in `.nvmrc`) and pnpm 9.

```bash
git clone https://github.com/<your-user>/antseed   # your fork
cd antseed
nvm install && nvm use
pnpm install
pnpm run build
pnpm run test
```

Smart contracts also need [Foundry](https://getfoundry.sh) (`forge`, `anvil`, `cast`). Run
`pnpm install` first: the contracts import OpenZeppelin from `node_modules`. A plain clone
leaves `packages/contracts/lib/forge-std` empty. Fill it the way CI does, from
`packages/contracts`: `forge install foundry-rs/forge-std`.

`nix develop` gives an optional pinned toolchain (see `flake.nix`). To run the full payment
flow on a local chain, follow "Local Testing" in [CLAUDE.md](CLAUDE.md).

## Repository structure

| Area | Location |
|---|---|
| Core protocol SDK: P2P, discovery, metering, payments | `packages/node` |
| Wire protocol: messages, codecs, payment signatures | `packages/protocol` |
| Buyer request handling and channel accounting | `packages/buyer-core` |
| Shared provider and router infrastructure | `packages/provider-core`, `packages/router-core` |
| Smart contracts (Solidity, Foundry) | `packages/contracts` |
| Other shared libraries | `packages/*` |
| Provider and router plugins | `plugins/` |
| CLI (`antseed`) | `apps/cli` |
| Desktop app (Electron) | `apps/desktop` |
| Payments, ANTS staking and DIEM staking web apps | `apps/payments`, `apps/ants`, `apps/diem-staking` |
| Website and user docs | `apps/website` |
| Relay, gateway console, network stats, download proxy | other folders in `apps/` |
| Protocol specification and plugin templates | `docs/protocol` |
| End-to-end tests | `e2e/` |

<a id="plugins"></a>
## Plugins

You do not need this repository to publish a plugin. Implement the `AntseedProviderPlugin` or
`AntseedRouterPlugin` interface from `@antseed/node`, start from the templates in
`docs/protocol/templates/`, and publish your package to npm.

Antseed is not for raw resale of API keys or subscription access. Providers must add value,
for example skills, agents, fine-tuned models or TEEs. Changes to the plugins in `plugins/`
follow the same rules as the rest of this repository.

## Code style

- TypeScript in strict mode, ES modules only.
- Prefer explicit types over inference in public APIs.
- Follow the style of the code around your change.
- SQLite schema changes: add a new file in `packages/node/src/storage/migrations/<domain>/`
  and register it in that folder's `index.ts`. Never edit an existing migration.
