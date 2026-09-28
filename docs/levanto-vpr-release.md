# Levanto VPR release verification

## Scope

Desktop uses the selection-only buyer route API, discovers completed-request
routing offers separately from models, persists exact routing targets and generic preferences,
and preserves router mode during catalog/system-proxy refreshes. Explicit models
and conversation pins override the router. The installed `local` plugin includes
the Levanto adapter; no plugin switch or buyer backend credentials are needed.

The fake routing/inference providers under `e2e/tests/helpers` are test fixtures,
not production plugins. They support changing recommendations, ranked fallback,
delayed replies, invalid JSON, empty rankings, foreign peers, unsupported models,
and service failures.

## Reproduce locally

### Standalone fake router for the desktop

After building this worktree, run these commands in separate terminals from its
root. Use the same instance name in both commands:

```sh
volta run --node 24.21.0 pnpm dev:levanto levanto-vpr-release
volta run --node 24.21.0 pnpm dev:desktop:instance levanto-vpr-release
```

`dev:levanto` is a foreground server: after printing “Fake Levanto ready” it
waits for requests and does not exit. Leave that terminal running while using
the desktop, or press Ctrl+C to stop the fake router.

If an older buyer was already running, stop it in its owning app or terminal
before starting the buyer from the updated dev instance, so the new process
uses this worktree's code and picks up the local discovery port. A named dev
instance's Home button only detaches/reattaches to a shared buyer; it does not
restart that external process. A 404 from `/_antseed/routing-services` means the
buyer is too old, not that no router is advertising. The picker shows this
error in the picker, even before a router has been selected.
The desktop instance still uses the configured buyer; this does not create a
new funded wallet or silently change its selected route. If other desktop
windows share that buyer, restarting it affects those windows too.

Select **Auto Router** by **Levanto**, marked **Router**, in the picker.
Routers use the same compact row layout as models, without inline settings.
Open **Models** and click the router to inspect its exact target, routing fee,
and router-published settings. The detail page uses the model-page layout: **Use**
at the top right, a pricing tile, and one dropdown for each advertised string enum.
The top-right button only selects the router. Settings and allowed-model edits
save automatically per exact peer/provider/service, including for inactive routers.
Editing an inactive router does not change the current route. Active-router edits
sync to the buyer immediately without restarting connected app profiles; failures
remain visible. An empty allowlist stays empty and blocks routing instead of
silently enabling every model.
Names, values, descriptions and defaults come from the plugin-provided catalog, not desktop
code. The mock publishes CQT; other routers can publish their own fields without
a desktop change. Routing v1 carries a generic `preferences` map of strings.
The searchable **Allowed models** list supports checking individual
provider/model pairs from the router's catalog. **All supported models** includes newly advertised supported models; an
explicit selection does not. Edits save automatically; **Use** selects an inactive
router. The allowlist persists across restarts.
The buyer filters both recommendations and fallback destinations. No eligible
allowed model means an error, never an unapproved inference request. Explicit
model requests and per-chat pins still override router mode. The revised v1
contract always sends exact eligible peer/provider/model tuples and includes
the catalog revision when advertised; both sides enforce restrictions. There is
no version negotiation or peer-only compatibility path. No catalog means unknown
support, not support for every network model. Stale/invalid catalogs fail closed.
See [the seller integration contract](protocol/levanto-routing.md).
The service always recommends `gpt-6-astra` from the exact GesundAI peer
`983e9de990b9ac8d36d373db5d0b49a4d7f7d826`, provider `openai-responses`.
CQT is accepted but does not change this deterministic recommendation. It checks
the local buyer's catalog for current availability and pricing and respects
allowed/blocked peers and supplied price/trust limits. It never substitutes a
seller with the same display name or recommends a different model.

Recommendations cost **$0**; real GesundAI inference still uses normal buyer
billing. The command itself does not send inference or select the router for you.
It logs no prompt text. Missing/ineligible targets return a service error.

The catalog port defaults to `8377`; pass a different configured buyer port as
the second argument, for example `pnpm dev:levanto levanto-vpr-release 8477`.
The fake uses instance-derived local bootstrap/signaling ports, a loopback
advertised address, and its own identity under the OS temporary directory at
`antseed-desktop/<instance>/fake-levanto`. Ctrl+C stops it; its identity survives
until that temporary directory is removed. The dev-instance launcher supplies
`ANTSEED_DEV_ROUTING_DHT_PORT` to the buyer; normal launches without this opt-in
keep their existing bootstrap configuration.

### One-shot fake-router test

After building this worktree, run from its root:

```sh
volta run --node 24.21.0 pnpm test:levanto
```

This runs the fake-router unit tests and a real-P2P subprocess integration test
using a synthetic local catalog. It starts its own fake router and buyer,
checks discovery, a free recommendation and a missing-target error, then stops
them, removes their temporary state and exits. It does not call GesundAI
inference, use real funds, or change the running desktop's route or wallet.
It does not leave a router running for manual desktop testing; use `dev:levanto`
for that. This focused check does not replace the full VPR/paid coverage below.

### Automated coverage

Use the pinned Node 24 runtime and pnpm 9.15.4. Install Foundry (`forge`, `anvil`)
for paid tests; initialize the contracts' forge-std submodule if absent. Install
Chromium with `pnpm --filter @antseed/e2e exec playwright install chromium`.

```sh
pnpm install --frozen-lockfile
pnpm run build:tier0
pnpm run build:tier1
pnpm run build:tier2
pnpm run build:tier3
pnpm --filter @antseed/cli test
pnpm --filter @antseed/desktop test
pnpm --filter @antseed/desktop typecheck:renderer
pnpm --filter @antseed/router-levanto test

ANTSEED_LEVANTO_BROWSER=1 pnpm --filter @antseed/e2e exec vitest run \
  tests/levanto-vpr.e2e.test.ts --maxWorkers 1 --minWorkers 1

ANTSEED_LEVANTO_BROWSER=1 ANTSEED_LEVANTO_CHAIN=1 pnpm --filter @antseed/e2e exec vitest run \
  tests/levanto-vpr.e2e.test.ts --maxWorkers 1 --minWorkers 1

pnpm --filter @antseed/desktop build:main
pnpm --filter @antseed/desktop build:renderer
pnpm --filter @antseed/desktop prepare-dist
node apps/desktop/scripts/smoke-bundled-router.mjs
```

Run `prepare-dist` last: it replaces desktop workspace symlinks with production
copies and installs Electron-compatible SQLite binaries. Before running Node
tests again, restore dependencies and Node-compatible native binaries; a hoisted
SQLite package may also have been rebuilt for Electron.
Unset inherited desktop instance/system-proxy data-directory overrides when
running the desktop suite so environment-specific settings do not change fixtures.

## What the tests prove

- Real local DHT discovery, buyer/seller nodes, P2P transport and buyer HTTP proxy;
  no mocked transport or fake payment signatures.
- Model → router → changed recommendation → model, and switching while a routing
  purchase is in flight. In-flight work keeps its original selection.
- `antseed`, `levanto-auto`, connected-app request markers, explicit models,
  conversation pins and clearing pins before returning to router mode.
- Anthropic/OpenAI streaming and Responses API input adaptation.
- Preference rejection, restart persistence, malformed/unusable recommendations,
  retryable inference fallback and cancellation.
- Chromium drives the production picker, route-selection action and chat
  controller, changes CQT and a non-CQT strategy enum, sends messages, refreshes discovery and reloads.
  It also checks visible discovery errors, an empty router catalog, and recovery
  to real discovered router offers without reloading.
  Electron IPC is replaced by a bridge to the real local buyer for this harness;
  this is not a packaged native Electron or third-party application test.
- The bundle smoke builds an isolated plugin tree from electron-builder resource
  paths and imports local/Levanto routers and opens SQLite under Electron's Node
  runtime, without resolving packages from the workspace.
- Paid mode deploys real contracts to isolated Anvil, funds/stakes sellers,
  deposits buyer funds, executes paid recommendations and paid inference, and
  checks settlement, routing seller payout and exact buyer debit.
- Invalid paid output does not increase buyer authorization, can cause a
  subsequent channel payment disagreement, and does not prevent direct-model use.
- A regression test covers seller `NeedAuth` winning the race against local
  post-response/close authorization: a delivered inference response is charged
  once, including when post-response signing is repeated.

Paid and free modes intentionally cover different cases. Malformed free replies
are tested independently; paid mode tests one terminal disagreement rather than
pretending that its channel automatically recovers for each malformed variant.
Skipped cases in either run are covered by the other mode. The commands above
exercise the browser harness against both free and paid peers.

## Latest-main verification (September 25, 2026)

The worktree is based on `origin/main` at `cfe8949c66e80250acf551ebb28a392631c2e1a7`
(desktop 0.2.49), with the prerequisite Levanto branch changes and desktop work
reapplied as uncommitted changes. Existing main changes, including model dropdown
clipping fixes and seller free-tier limits, are retained.

- Dependency installation with the frozen lockfile, desktop CLI dependency build,
  main build and renderer typecheck passed.
- CLI: 655 tests; node SDK: 1,246 tests.
- Desktop: 12 script tests, 389 main-process tests and 421 renderer tests.
- Fake GesundAI router: 13 tests; free browser/P2P suite: 16 passed, 2 paid-only
  cases skipped; paid browser/Anvil suite: 11 passed, 7 free-only cases skipped.
- A separate read-only discovery check found the already-running local fake
  router through bootstrap port 18266 using the updated SDK. No real inference
  or production payment was sent.

The active shared buyer on port 8377 returned HTTP 404 for
`/_antseed/routing-services`: it was running from a different, older worktree.
That process was not stopped, because doing so would interrupt its connected
apps. It must be replaced by a buyer started from the updated dev instance for
the live desktop to discover and use the fake router.

Development buyers now load the worktree's local router through an explicit
development-only plugin path. Merely rebuilding the CLI previously left a
same-version global plugin installed without Levanto selection support. Restart
the dev desktop and its buyer after changing this startup behavior; packaged
launches strip the override and continue to use the bundled plugin lifecycle.
Chat replies show a compact actual-model indicator; aliases are never presented
as a resolved model, and new response-route metadata is retained on chat reopen.

## Catalog/v1 verification (September 25, 2026)

Verified locally after adding plugin-provided catalogs, router-advertised enum settings and exact v1 constraints:

- Protocol: 81 tests; node SDK: 1,252 tests; CLI: 661 tests.
- Levanto adapter: 36 tests; local router: 16 tests.
- Desktop: 12 script tests, 392 main-process tests and 440 renderer tests.
- Free browser/P2P and fake dev-command suites: 34 passed, 3 paid-only skipped.
- Paid browser/P2P/Anvil suite: 12 passed, 11 free-only skipped.
- Renderer typecheck, Node SDK build, CLI/main build, renderer production build
  and `git diff --check` passed. Router/plugin dependency builds also passed.
- Narrow-width router settings visually checked: top-right action, Router tag,
  pricing tile, schema-driven dropdowns and model-like checkbox rows remain aligned.

New cases cover exact provider mismatches, ignored candidate restrictions,
same-turn cache invalidation after catalog/candidate changes, stale revisions
without dropping constraints, empty intersections before purchase, and nonbillable 409/422
responses with subsequent successful paid routing. UI regressions cover unknown
support, expired catalogs, preserved removed selections, separator-safe exact
IDs and supported providers hidden by the main catalog's canonical grouping.
Catalog sellers refresh announcements at least once a minute to avoid expiring
between normal discovery cycles; ordinary seller intervals remain unchanged.
Settings tests cover schema-bound revisions, multiple arbitrary text-enum fields,
required choices, defaults, removed choices, unknown fields, optional unset,
reload persistence and validation against changed schemas before any purchase.
The browser changes both CQT and a router-owned `strategy` field and verifies the
generic preferences on the P2P request. Registered non-Levanto protocol discovery
also exposes the seller's schema without adding desktop-specific code.

All payment tests use local Anvil, not production funds. The browser harness
exercises actual renderer components and buyer HTTP/P2P transport, not a signed
packaged desktop release. Already-running development processes are not upgraded
in place; restart the fake router and buyer to load these changes.

## Plugin catalog verification (September 26, 2026)

Catalogs moved out of peer metadata into the router plugin's optional
`getCatalog()`; the Levanto adapter reads `GET /_antseed/route/catalog` from the
router's API. Metadata, announcer and signing changes were reverted to the
PR #1047 state. Verified: protocol 9, node 89 (announcer/metadata), router-core 31,
Levanto adapter 38, CLI 665, free e2e 33 (+4 paid-only skipped), paid Anvil e2e 11,
and the Chromium VPR run.

## Routing VPN UI PR verification (September 28, 2026)

The desktop work is on `codex/routing-vpn-ui`, stacked on prerequisite PR #1047.
The development instance name remains `levanto-vpr-release`; its commands above
are unchanged. Router entries now have a visible Routers heading, with a Models
heading separating subsequent model entries in the pickers and model browser.

Fresh checks with Node 24.21.0 passed:

- CLI: 665 tests.
- Desktop: 12 script tests, 392 main-process tests, and 462 renderer tests.
- Fake-router unit/subprocess integration: 14 tests.
- Desktop renderer typecheck and production renderer build.

The desktop suite runs with named-instance environment overrides removed; an
initial run inherited the running instance's data directory and failed one
default-path assertion. No application change was needed for the clean rerun.
Paid-chain, browser, and packaged-Electron checks were not rerun for this PR
preparation. Earlier results above remain historical evidence only.

The branch contains earlier main merges and catalog/cache work that diverges
from #1047's current head. A read-only merge preview reports conflicts in CLI
routing, router adapters, and documentation. Reconcile the prerequisite before
landing; this branch has not silently overwritten or merged those conflicts.

## Production gates — do not skip

The AntSeed buyer and local fake routers implement the plugin catalog API and routing
v1. This does **not** upgrade Levanto's separately operated backend. Before
release, its router API must serve `GET /_antseed/route/catalog` with a truthful catalog and enforce exact
candidate constraints, echo the catalog revision, include providers in rankings,
and return nonbillable 409/422 errors. Restart local fake sellers and buyers after
rebuilding to load the new adapter; already-running processes continue using their
loaded code. Peer metadata is unchanged (v12).

1. Repeat CI on the exact release candidate and reconcile the prerequisite
   PR #1047 changes before landing. Latest-main local integration is verified
   above; it is not a merged or published release.
2. Verify against Levanto's actual advertised peer: metadata, target identity,
   endpoint, CQT, ranking schema, two real downstream models, streams, errors,
   and paid settlement. A fake provider does not certify the private backend.
3. Agree on the paid invalid-response/price-change policy. The buyer refuses
   unaccepted charges; the seller may then reject future work on that channel.
   No automatic refund, disputed-payment authorization, or recovery is included.
   Validate successful payloads seller-side before billing and treat safe
   operational recovery as a prerequisite for broad paid availability.
4. Use separate upgraded routing peers initially. Old buyers reject announcements
   containing `completed_requests`, including mixed inference/routing sellers.
5. Build signed/notarized desktop artifacts through the normal release pipeline.
   Test a fresh install and an upgrade, restart persistence, packaged local-router
   loading, real connected apps, Telegram and explicit per-chat overrides on
   supported operating systems. Local browser tests do not cover native app
   configuration, certificate trust, OS proxy settings or code signing.
6. Compute npm version bumps from the integrated changes and exact dependency-pin
   cascade using `.claude/skills/publish/SKILL.md` and
   `node scripts/npm-publish-plan.mjs`. Include the new `router-levanto` package
   and affected dependents; desktop must bundle matching CLI/SDK/router builds.
   Do not choose release versions from this unmerged branch's stale versions.
7. Run release CI/dry-run, publish through approved CI, then canary a limited
   rollout. Monitor routing errors, disputed channels, spend attribution and
   model/router switches before wider availability. Model mode remains the
   user-controlled fallback; never silently authorize bad routing output.

No real funds, production service credentials, release signing, publishing, or
production mutations are required by the local verification commands.
