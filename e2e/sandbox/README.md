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
- Node 24 (the version in `.nvmrc`). Native modules such as better-sqlite3 are built for it; on another Node version the buyer channel store fails and routed chats return "Router is temporarily unavailable".
- Foundry's `anvil` on `PATH`
- Network access to a Base RPC. The default is a public gateway; set `BASE_MAINNET_RPC_URL` for a faster, dedicated one. The URL is passed to the supervisor through its environment only and never written to disk.

## Commands

```bash
pnpm sandbox up [--config FILE] [--live] [--deposit-usdc N] [--block N] [--scenario NAME]
pnpm sandbox status [--json] [--env]   # ports, wallets, balances, peers, URLs, env exports
pnpm sandbox run <scenario> [--keep] [--strict] [--seed N] [--repeat N]
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

- **Mock (default).** Each seller gets its own OpenAI-compatible mock that answers every model in its config: `/v1/models`, chat (JSON and SSE streaming with usage), and `/v1/images/generations` (a fixture PNG). By default usage is fixed (10 input + 8 output tokens), so costs are exact. A seller profile turns it into a timing-accurate upstream (see [Seller profiles](#seller-profiles)). Only OpenAI-compatible plugins (`openai`) can be mocked.
- **Live (`--live`).** Sellers call the real upstream. Every provider needs `apiKeyEnv` (set in your shell or in `--env-file`) and an HTTPS `baseUrl`. Keys reach seller processes through their environment only. Settlement still happens on the fork, so no real funds move.

Live keys come from the shell first, then `--env-file FILE` (default: a gitignored `.antseed-sandbox.env` in the worktree). Only names referenced by a provider's `apiKeyEnv` are read from the file; values are never printed, and providers may share one variable. `up` prints which variable and source each provider uses.

```bash
pnpm sandbox up --live --config path/to/config.json --env-file ~/.my-keys.env
```

## Scenarios

A scenario is a module in `e2e/sandbox/scenarios/<name>.mjs`. It is either declarative (a default export with a topology, a workload and phases; preferred for load, chaos and routing experiments) or imperative (a `run(sb)` function for custom step-by-step logic). Both get the same global invariants, seeding and report.

### Declarative scenarios

```js
export default {
  meta: { description: 'One seller drops out; the others absorb its traffic', requires: ['sellerControl'] },
  topology: { sellers: [{ id: 'victim', mock: 'cheap-slow' }, { id: 'steady', mock: 'fast-premium' }], buyer: { depositUsdc: '20' } },
  workload: { spec: 'chat-only', rateMultiplier: 1 },   // or an inline workload; via: 'router:<id>' routes through a sandbox router
  setup: async (sb) => {},                               // optional
  phases: [
    { name: 'baseline', duration: '30s', expect: { successRate: '>=0.99' } },
    { name: 'outage', duration: '30s', faults: [{ stop: 'victim' }], expect: { 'servedBy.victim': '==0' } },
    {
      name: 'recovery', duration: '60s', faults: [{ start: 'victim' }],
      known: { 'recoveryMs.victim': { expect: '<45000', issue: 'buyer does not fail back' } },
    },
  ],
  expect: { successRate: '>=0.9' },                      // over the whole run
};
```

One open-loop workload runs across all phases; faults fire on its timeline at the start of their phase (or `at: '5s'` into it).

| Fault | Effect |
| --- | --- |
| `{ stop: id }`, `{ start: id }` | Stop or restart a seller process |
| `{ mock: { seller, patch } }` | Patch a seller's mock profile (latency, errors, decode rate...); restored when the phase ends unless `restore: false` |
| `{ closeChannel: id }` | Cooperatively close the buyer's channel with that seller |
| `{ warp: '1m' }` | Advance chain time |

Expectations are `'>=0.99'`, `'<45000'`, `'==0'` (or a plain value for equality) against these metrics, computed per phase and for the whole run:

- `requests`, `succeeded`, `failed`, `successRate`, `errorRate`
- `ttftP50Ms`, `ttftP95Ms`, `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms`
- `distinctSellers`, `distinctModels`
- per seller: `servedBy.<id>`, `share.<id>`, `failedOn.<id>`, and `recoveryMs.<id>` (time from the phase's faults to the first success on that seller)

A request belongs to the phase it started in. If it failed after the next phase's first fault fired, it counts in that next phase, because the fault caused the failure. A failed expectation is recorded and fails the run, but the run continues so the report lists every failure. `known` entries are recorded as known issues instead. `report.json.metrics` gets `phases`, `run` and `faults` (when each fault actually ran). Required capabilities are inferred from the faults.

### Imperative scenarios

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
| Client | `catalog()`, `peers()`, `chat({ model, prompt, stream, sellerId })`, `routingServices()`, `route(body)`, `useRouter(id, { costQualityTradeoff, allowedModels })` |
| Payments | `channels({ all })`, `signedBySeller()`, `closeAll()`, `closeChannel(id)`, `assertSettlementMatchesSigned(expected?)`, `buyerBalance()` |
| Control | `stopSeller(id)`, `startSeller(id)`, `setMockLatency(id, ms)`, `setMockProfile(id, patch, { replace })`, `mockProfileRaw(id)`, `mockRequests(id)`, `mockStats(id)`, `routerStats(id)`, `warp(seconds)` |
| Load | `runWorkload({ workload, durationMs, seed, rateMultiplier, timeline, label })`, `checkInvariants({ phase })` |
| Reporting | `check(name, ok, detail)` (throws on failure), `expect(name, ok, detail)` (records and continues), `failures()`, `knownIssue(name, ok, detail, issue)`, `metric(name, value)`, `event(type, data)`, `pricing(sellerId, model)`, `mockCostPerChat(sellerId, model)`, `deliveredCost(sellerId)`, `seed` |

Each run writes `reports/<timestamp>-<scenario>/report.json` (result, checks, known issues, metrics, config hash, fork block, topology, sellers, buyer, seed, and for load scenarios `workloads` and `invariants`), `events.jsonl`, `metrics.json` and, when a workload ran, `requests.jsonl` (one record per request). A failed check fails the run with a nonzero exit.

### Seeds and reproduction

`--seed N` (default 1) seeds every random choice the sandbox makes:

- workload plans: arrivals, sessions, turns, request sizes
- mock draws (errors, timing samples, output lengths): keyed by the request's `x-sandbox-draw-key` (`<seed>-<session>-<turn>`) plus the retry attempt, not by arrival order, so concurrency does not reshuffle them
- sandbox router rankings: keyed by the seed and the request content; candidates are sorted by peer id first

Before each run the CLI reseeds every mock (and clears its draw counters) and every router, so the same seed sends the same requests to the same sellers. Effects that depend on wall-clock time still vary: queueing, timeouts, P2P latency, and which request a stop fault interrupts.

`--repeat N` runs the scenario N times in one sandbox with seeds N, N+1, ... and writes `run-<i>/report.json` for each plus an `aggregate` (mean, 95% CI, min, max per numeric metric) in the top-level `report.json`. Reports record `gitCommit` (suffixed `-dirty` for uncommitted changes), and a failed run lists and prints `reproduce` commands (`pnpm sandbox run <scenario> --seed <failed seed>`).

`knownIssue` records a check for a tracked defect outside the sandbox without failing the run; `--strict` makes it fail. Tracked issues:

- after a cooperative close, one extra request's cost is settled (two 18 micro-USDC chats settle 54, not 36), and a router gets one extra ranking fee. On-chain settlement still matches exactly what the buyer signed.
- the buyer pins one of several equal-price sellers instead of spreading load, and it does not move traffic back to a restarted cheaper seller (`chaos-seller-drop`).

Shipped scenarios:

- `chat-basic`: catalog, a non-streaming and a streaming chat, receipts, then exact on-chain settlement with zero reserves after close.
- `routing-smoke`: two sellers with different mock latency; the buyer sees only sandbox sellers, pinned and auto-routed chats stay inside the sandbox, and per-seller settlement is exact.
- `load-mixed`: five sellers (`fast-premium`, `cheap-slow`, `flaky`, `degrading`, `local-gpu` profiles at different prices) under the `mixed` workload for 150 s (`SANDBOX_LOAD_DURATION_MS`); reports the full metrics summary and checks invariants before and after close.
- `load-ramp`: runs a workload (`chat-only` by default) at increasing `rateMultiplier` steps until p95 TTFT exceeds 2x the first step's (or 30 s) or success drops below 90%, and records the knee (`kneeRateMultiplier`, `kneeRequestsPerSec`). Tune with `SANDBOX_RAMP_WORKLOAD`, `SANDBOX_RAMP_STEP_MS`, `SANDBOX_RAMP_MULTIPLIERS`, `SANDBOX_RAMP_KNEE_FACTOR`, `SANDBOX_RAMP_MAX_TTFT_P95_MS`, `SANDBOX_RAMP_MIN_SUCCESS_RATE`.
- `chaos-seller-drop`: declarative. Chat traffic over three sellers; phases `baseline` (30 s), `outage` (the cheapest seller is stopped; nothing may reach it) and `recovery` (60 s, it is restarted). Override durations with `SANDBOX_CHAOS_BASELINE`, `SANDBOX_CHAOS_OUTAGE`, `SANDBOX_CHAOS_RECOVERY` (e.g. `15s`). Known issues: the buyer pins one of the equal-price sellers, and it does not move traffic back to the restarted cheaper seller.

Routing peers are declared in a scenario as `routers: [{ id: 'levanto', priceUsd: '0.001' }]`. The supervisor launches each as a real AntSeed seller node with `model-routing` billing, allowlists it for the buyer and closes its channel on teardown. Its rankings are seeded per run. Routers need an `@antseed/node` build with model-routing (IRP) support; the `routing-irp` scenario that uses them ships with the routing branch.

Ideas the topology/`sb` split is designed for: payment changes (`warp`, `closeChannel`, deposits), network changes (stop/start sellers mid-run, latency), routing experiments (many sellers, metrics per run), and desktop UX checks (`pnpm sandbox desktop` against a scenario left running with `--keep`).

## Seller profiles

A profile describes how a seller's upstream behaves. Put it inline in the topology (`sellers[].mock`), name a file in `e2e/sandbox/profiles/<name>.json` (`mock: 'flaky'` or `mock: { profile: 'flaky', concurrency: 2 }`, overrides merge by key), or patch it at runtime with `sb.setMockProfile(id, patch)`. Without timing fields the mock keeps the original behaviour (fixed 10/8 usage after `latencyMs`), so existing scenarios are unchanged.

| Field | Meaning |
| --- | --- |
| `prefillTokensPerSec`, `decodeTokensPerSec` | Distribution: a number, `{ type: 'uniform', min, max }` or `{ type: 'lognormal', median, p99 }` (optional `clampMin`/`clampMax`) |
| `rttMs`, `jitterMs` | Added per request; distributions |
| `outputTokens`, `chunkTokens` | Output length when the request carries no hint; tokens per SSE chunk (default 4) |
| `concurrency` | Slots (0 = unlimited). Requests beyond it wait in a FIFO queue, so queueing latency emerges under load |
| `tailSpike { p, multiplier }` | With probability `p`, TTFT and decode time are multiplied |
| `degradation { everyMs, forMs, decodeMultiplier }` | Decode speed is multiplied during the last `forMs` of every `everyMs` |
| `errors` | `http5xx` rate and `status5xx`; `rateLimitQueue` (429 with `retry-after: retryAfterSec` once that many requests are queued); `midStreamDrop` rate; `timeout` rate (hold `timeoutHoldMs`, then drop); `stall` rate with `stallMs` |
| `adversarial` | Off by default: `inflateUsage` (factor on reported usage), `stallStream` (send the first chunk, then hang) |
| `seed`, `latencyMs`, `usage` | RNG seed (set by `--seed`); fixed extra delay; `fixed` or `modeled` (implied by timing fields) |

Timing: TTFT = queue wait + `latencyMs` + RTT + (input tokens / prefill + jitter) x spike; then output streams in `chunkTokens` chunks at the decode rate. Non-streaming responses arrive after the full duration. Input tokens come from the `x-sandbox-input-tokens` header (the workload sends it) or a deterministic estimate (4 characters per token, plus 4 per message); output from `x-sandbox-output-tokens`, else the profile, capped by `max_tokens`. Reported usage is exactly what was generated, so settlement checks stay exact; drops and timeouts report no usage. Every request draws from an RNG seeded by (seed, seller, draw key and attempt), or by request index when there is no draw key, never `Math.random`.

Shipped profiles (assumptions are in each file's `description`): `fast-premium` (16 slots, ~90 tok/s), `cheap-slow` (4 slots, ~25 tok/s), `flaky` (5% 5xx, 2% drops, 1% hangs, stalls), `degrading` (decode drops to 20% for 30 s of every 90 s), `local-gpu` (2 slots, ~40 tok/s).

## Workloads

A persona describes one kind of client. Files live in `e2e/sandbox/workloads/personas/<name>.json`; a workload in `e2e/sandbox/workloads/<name>.json` mixes personas:

```json
{ "sessionsPerMinute": 20, "personas": ["desktop-chat", "coding-agent", "api-batch"], "maxInFlight": 64, "maxPromptChars": 16000 }
```

Persona fields: `share` (fraction of `sessionsPerMinute`), `arrival { process: poisson|uniform, perMinute }` (used when the workload sets no total), `turns`, `thinkTimeMs`, `systemTokens`, `inputTokens`, `carryContext` (resend the conversation so input grows), `outputTokens`, `models` (`{ zipf: s }` over the catalog in order, or `{ weights: [...] }`), `streamRatio`, `abandonAfterMs`. Distributions use the profile syntax. Shipped personas (assumptions are listed in each file): `desktop-chat`, `coding-agent`, `api-batch`. Shipped workloads: `mixed`, `chat-only`.

To add a persona, drop a JSON file into `workloads/personas/`, reference it from a workload (or pass an inline object to `sb.runWorkload({ workload: { personas: [...] } })`), and run `pnpm test:sandbox`: the persona test loads every shipped persona.

`sb.runWorkload` plans every session up front from the seed (`planWorkload`) and runs the plan open-loop: sessions start on schedule however slow earlier responses are, so slow sellers cannot hide load (no coordinated omission). Turns inside a session follow the previous answer plus think time. At most `maxInFlight` requests run at once; a request beyond that is recorded as `overload` (dropped) and ends its session. Turns that would start after `durationMs` are skipped. `timeline: [{ atMs, name, action }]` runs actions such as `sb.stopSeller` at fixed offsets and records when they started and finished.

Requests go through the buyer proxy like a real client. Each record (in `requests.jsonl`) has persona, session, turn, model, seller (from `x-antseed-peer-id`), stream, scheduled and actual start, TTFT (first body byte of a streaming response), total latency, usage, status and an error class: `seller` (peer-attributed 429/5xx or no peer could serve), `network` (stream ended early), `timeout` (client abandoned or 408/499/504), `buyer` (everything else), `overload` (dropped locally).

## Metrics and invariants

`report.json.workloads.<name>` holds, overall and per persona: request/success counts, success rate, error breakdown, p50/p95/p99 TTFT (streaming successes only) and latency, decode tokens/s, input/output tokens, output tokens/s, dropped count; per seller: served, share, failures, p95 TTFT, slot utilisation, queue peak and 429s from the mock; plus the load-spread Gini over sellers (0 = even, 0.8 = all on one of five) and cost per 1M tokens from the micro-USDC the buyer signed during the run. `metrics.workload` keeps the headline numbers for `--repeat` aggregation.

Global invariants run after every scenario, declarative or imperative: once during the run, then (unless the scenario already did it) `closeAll` and the final checks. Each is recorded with `sb.expect`, so every violation is reported rather than only the first. `sb.checkInvariants({ phase })` runs them on demand and records results in `report.json.invariants`. With `--repeat`, router fee checks are relative to the start of each run.

- buyer signed cumulative is monotonic per channel and within the reserve (from `/_antseed/channels?all=1`, sampled every second during each workload)
- buyer channels are only with sandbox sellers and routers
- every request was served by an allowed sandbox seller
- every buyer success matches a completed mock request with the same `x-sandbox-request-id` on the same seller; extra mock completions (proxy retries, abandons, truncation) are allowed up to the number of buyer-side failures
- `phase: 'final'` (after `closeAll`): on-chain settled equals the buyer's final signed amount per seller, and reserves are zero
- `phase: 'final'`: settled equals the cost of delivered work (mock usage at the seller's prices); a known issue until the cooperative-close bug is fixed
- router fees signed equal rankings served x ranking price; exactly one extra ranking price is the same cooperative-close known issue, anything else fails

The checks are pure functions in `lib/invariants.mjs`, so they also run on synthetic data in unit tests and can be reused per step.

## Control API

The supervisor exposes a loopback-only API with a bearer token stored in `control.json` (mode 0600). Scenarios use it through `sb`; you rarely need it directly.

`GET /status`, `POST /channels/close {sellerId?}`, `POST /chain/warp {seconds}`, `POST /sellers/:id/stop`, `POST /sellers/:id/start`, `POST /sellers/:id/mock` (body is a profile patch such as `{latencyMs}` or `{errors: {http5xx: 0.2}}`, or `{patch, replace: true}` to swap the whole profile), `{resetDraws: true}` to restart the seeded draws, `GET /sellers/:id/mock` (`requests`, `profile`, `raw` profile, `stats`), `POST /routers/:id/seed {seed}`, `GET /routers/:id` (rankings served and rejected), `POST /shutdown`

## Fork cache

Anvil's RPC cache makes a warm `up` take a few seconds instead of a minute.

- The shared cache lives in `~/.antseed-sandbox/.cache/anvil` (override with `ANTSEED_SANDBOX_CACHE_DIR`). It is seeded once from the older `~/.antseed-e2e/anvil-home` cache, which is only ever read.
- Each sandbox copies the warm block into its own `anvil-home/`; Anvil never writes the shared cache.
- On exit the sandbox's copy is published back under `cache.lock` with a temp file and an atomic rename, and only if it is larger than the shared copy.
- Pruning keeps the newest 3 blocks and never removes a block pinned by a running sandbox.
- Without `--block`, the newest warm block younger than 72 hours is reused; otherwise the fork pins a block just behind head.

## Tests

```bash
pnpm test:sandbox       # fast unit tests (node --test): options, config, naming, locks, manifest, ports, cache, mock, control,
                        # profiles, seeded distributions, timing (injected clock), queueing/429, error rates, personas,
                        # open-loop scheduling, metrics math, invariants
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
- an auto-research loop that implements variants and picks the best by these metrics
- a discrete-event simulator for thousands of peers (the profile and persona files are meant to feed it)
- multiple buyer nodes: the workload sender is per proxy URL, so several buyers would each get a supervisor-started proxy and `runWorkload` would split sessions across them
- calibrating profiles from real metering data
- multiple sellers from different configs
- rebasing the video harness onto this
- Anvil state snapshots
- a Herdr tab launcher
- a CI smoke run
