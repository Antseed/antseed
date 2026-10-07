# Worktree sandbox

`pnpm sandbox` gives every git worktree its own isolated AntSeed stack for end-to-end development:

- an Anvil fork of Base mainnet (production contracts, fork-only USDC)
- one or more sellers, each backed by an OpenAI-compatible mock upstream (or the real upstream with `--live`)
- a buyer and its proxy (the same `BuyerProxy` the CLI and desktop use)
- a private bootstrap DHT node, so sandbox nodes only ever see each other
- optionally a desktop window attached to the sandbox buyer

Use it to try a feature end to end, write a repeatable scenario for it, and get a `report.json` with checks and metrics.

## Prerequisites

- `pnpm install && pnpm run build`
- Foundry's `anvil` on `PATH`
- Network access to a Base RPC. The default is a public gateway; set `BASE_MAINNET_RPC_URL` for a faster, dedicated one. The URL is passed to the supervisor through its environment only and never written to disk.

## Commands

```bash
pnpm sandbox up [--config FILE] [--live] [--deposit-usdc N] [--block N] [--scenario NAME]
pnpm sandbox status [--json] [--env]   # ports, wallets, balances, peers, URLs, env exports
pnpm sandbox run <scenario> [--keep] [--strict]
pnpm sandbox desktop                  # attach-only Electron window on the sandbox buyer
pnpm sandbox:attach                   # start/reuse routing-smoke, then open the attached VPR
pnpm sandbox logs [supervisor|anvil|seller-<id>] [--follow]
pnpm sandbox down [--force]           # settle + close channels while Anvil is alive, then stop
pnpm sandbox list                     # every sandbox on this machine
```

`--slot NAME` on any command runs an additional sandbox for the same worktree (for example two scenarios with different topologies side by side).

`status --env` prints exports so any client can use the sandbox:

```bash
eval "$(pnpm -s sandbox status --env)"
curl "$ANTSEED_PROXY_URL/v1/models"
```

Typical loop:

```bash
pnpm sandbox up
pnpm sandbox run chat-basic --keep     # reuses the running sandbox
# poke at it: curl, desktop, your own client...
pnpm sandbox down
```

`run` starts a sandbox with the scenario's topology if none is running and stops it afterwards unless `--keep`. If a sandbox is running with a different topology it refuses; run `down` first or use `--slot`.

## Isolation

- **One sandbox per worktree (per slot).** The name is `wt-<basename>-<sha1(path)[:8]>[-slot]`. All state lives in `~/.antseed-sandbox/<name>/`: `home/`, `anvil-home/`, `buyer/`, `sellers/<id>/`, `config/`, `logs/`, `reports/`, `manifest.json`, `sandbox.lock`, `control.json`. Override the root with `ANTSEED_SANDBOX_HOME` (never inside `~/.antseed`).
- **Locks with PID-reuse protection.** Lock and manifest entries record each process's PID and its `ps` start time. `up` while running reattaches; a dead or reused PID is treated as stale and cleaned up on the next `up`.
- **Only owned processes are stopped.** `down` and stale cleanup signal only PIDs from our manifest whose start time still matches.
- **No defaults, no `~/.antseed`, no keychain.** Every sandbox process gets a cleaned environment (AntSeed/provider variables stripped) with `HOME` set to the sandbox's `home/`. Node options are checked before use: `dhtPort: 0`, `signalingPort: 0` (unset or 6881/6882 fail fast), `bindHost: 127.0.0.1`, `noOfficialBootstrap`, `natTraversal: false`, `allowPrivateIPs`, and one private loopback bootstrap node. Listeners take port 0 where possible; Anvil and the proxy retry on `EADDRINUSE`.
- **Buyer routing stays inside the sandbox.** `allowedPeerIds` is set to this sandbox's seller peer IDs and `minTrustScore` is forced to 0 (fresh fork sellers have no trust). Other routing preferences come from the config.
- **Fresh chain per `up`.** Channel, metering and payment databases are cleared on each `up` (they describe a chain that no longer exists); identity keys are kept, so peer IDs and wallet addresses stay stable across runs.

## Config

`--config FILE` points at an existing AntSeed config, such as `~/.antseed/config.json` or a seller config file. Otherwise the sandbox uses `ANTSEED_SANDBOX_CONFIG`, then a gitignored `.antseed-sandbox.json` in the worktree, then a built-in single-model OpenAI-compatible seller.

Only these settings are copied; everything else (identity, directories, ports, bootstrap, RPC, contracts, relay, system proxy, verifier) is dropped and set by the sandbox, and the dropped keys are printed:

- `seller.providers.<name>`: `plugin`, `baseUrl`, `apiKeyEnv`, `pathRewrite`, `defaults`, `services.<id>` (`upstreamModel`, `categories`, `pricing`, `capabilities`, `unitBillingModels`)
- `buyer.routingPreferences`, `buyer.maxPricing`
- `payments.crypto.chainId` (only `base-mainnet` is supported for now)

Inline secrets (any key that looks like a credential, anywhere in the file) are refused; reference them with `apiKeyEnv`. The source file is only read. A cleaned copy goes to `config/source.cleaned.json`, and its hash is recorded in the manifest and every `report.json`.

### Upstream

- **Mock (default).** Each seller gets its own OpenAI-compatible mock that answers every model in its config: `/v1/models`, chat (JSON and SSE streaming with usage), and `/v1/images/generations` (a fixture PNG). Usage is fixed (10 input + 8 output tokens), so costs are exact. Only OpenAI-compatible plugins (`openai`) can be mocked.
- **Live (`--live`).** Sellers call the real upstream. Every provider needs `apiKeyEnv` (set in your shell or in `--env-file`) and an HTTPS `baseUrl`. Keys reach seller processes through their environment only. Settlement still happens on the fork, so no real funds move.

Live keys come from the shell first, then `--env-file FILE` (default: a gitignored `.antseed-sandbox.env` in the worktree). Only names referenced by a provider's `apiKeyEnv` are read from the file; values are never printed, and providers may share one variable. `up` prints which variable and source each provider uses.

```bash
pnpm sandbox up --live --config path/to/config.json --env-file ~/.my-keys.env
```

## Scenarios

A scenario is a module in `e2e/sandbox/scenarios/<name>.mjs`:

```js
export const meta = {
  description: 'What this proves',
  targets: ['fork'],            // where it can run
  requires: ['mockControl'],    // capabilities it uses: warpTime, sellerControl, mockControl
};

// Plain data. Sellers inherit the config's providers unless they bring their own.
export const topology = {
  sellers: [{ id: 'fast', mock: { latencyMs: 20 } }, { id: 'slow', mock: { latencyMs: 400 } }],
  buyer: { depositUsdc: '10', routingPreferences: { preferLowLatency: true } },
  chain: { block: 52223957 },   // optional pin
};

export async function run(sb) {
  const reply = await sb.chat({ model: sb.sellers[0].models[0], sellerId: 'fast' });
  sb.check('fast seller answered', reply.content.length > 0, reply.content);
  sb.metric('latencyMs', reply.latencyMs);
  await sb.closeAll();
  await sb.assertSettlementMatchesSigned();
}
```

The `sb` API:

| Area | Calls |
| --- | --- |
| Client | `catalog()`, `peers()`, `chat({ model, prompt, stream, sellerId })` |
| Payments | `channels({ all })`, `signedBySeller()`, `closeAll()`, `closeChannel(id)`, `assertSettlementMatchesSigned(expected?)`, `buyerBalance()` |
| Control | `stopSeller(id)`, `startSeller(id)`, `setMockLatency(id, ms)`, `mockRequests(id)`, `warp(seconds)` |
| Reporting | `check(name, ok, detail)`, `knownIssue(name, ok, detail, issue)`, `metric(name, value)`, `event(type, data)`, `mockCostPerChat(sellerId, model)` |

Each run writes `reports/<timestamp>-<scenario>/report.json` (result, checks, known issues, metrics, config hash, fork block, topology, sellers, buyer), `events.jsonl` and `metrics.json`. A failed check fails the run with a nonzero exit.

`knownIssue` records a check for a tracked defect outside the sandbox without failing the run; `--strict` makes it fail. It currently tracks one issue: after a cooperative close, `chat-basic` sees one extra request's cost settled (two 18 micro-USDC chats settle 54, not 36). On-chain settlement still matches exactly what the buyer signed.

Shipped scenarios:

- `chat-basic`: catalog, a non-streaming and a streaming chat, receipts, then exact on-chain settlement with zero reserves after close.
- `routing-smoke`: two sellers with different mock latency; the buyer sees only sandbox sellers, pinned and auto-routed chats stay inside the sandbox, and per-seller settlement is exact.

Ideas the topology/`sb` split is designed for: payment changes (`warp`, `closeChannel`, deposits), network changes (stop/start sellers mid-run, latency), routing experiments (many sellers, metrics per run), and desktop UX checks (`pnpm sandbox desktop` against a scenario left running with `--keep`).

## Control API

The supervisor exposes a loopback-only API with a bearer token stored in `control.json` (mode 0600). Scenarios use it through `sb`; you rarely need it directly.

`GET /status`, `POST /channels/close {sellerId?}`, `POST /chain/warp {seconds}`, `POST /sellers/:id/stop`, `POST /sellers/:id/start`, `GET|POST /sellers/:id/mock {latencyMs}`, `POST /shutdown`

## Fork cache

Anvil's RPC cache makes a warm `up` take a few seconds instead of a minute.

- The shared cache lives in `~/.antseed-sandbox/.cache/anvil` (override with `ANTSEED_SANDBOX_CACHE_DIR`). It is seeded once from the older `~/.antseed-e2e/anvil-home` cache, which is only ever read.
- Each sandbox copies the warm block into its own `anvil-home/`; Anvil never writes the shared cache.
- On exit the sandbox's copy is published back under `cache.lock` with a temp file and an atomic rename, and only if it is larger than the shared copy.
- Pruning keeps the newest 3 blocks and never removes a block pinned by a running sandbox.
- Without `--block`, the newest warm block younger than 72 hours is reused; otherwise the fork pins a block just behind head.

## Tests

```bash
pnpm test:sandbox       # fast unit tests (node --test): options, config, naming, locks, manifest, ports, cache, mock, control
pnpm test:sandbox:e2e   # full flow on a real fork: up, reattach, status, run chat-basic, down, isolation checks
```

The e2e flow checks:

- no sandbox port collides with an existing listener or a default port
- `up` reattaches instead of restarting
- every port is closed after `down`
- no sandbox process ever holds a file under `~/.antseed`
- `~/.antseed/identity.key` and `config.json` are unchanged
- foreign Anvil processes survive

Pass scenario names to run more than `chat-basic` (`node e2e/sandbox/test/e2e-flow.mjs chat-basic routing-smoke`).

## Roadmap

Not built yet:

- a mainnet target for scenarios that declare `targets: ['mainnet']`, with spend caps and real funds
- local chain mode without a fork
- mock failure and latency modes
- multiple sellers from different configs
- rebasing the video harness onto this
- Anvil state snapshots
- a Herdr tab launcher
- a CI smoke run
