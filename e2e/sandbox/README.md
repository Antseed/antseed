# Worktree sandbox

`pnpm sandbox` tests the current worktree's changes end to end. It covers four cases. Find the one that matches your change and follow its section.

| Case | What changed | Network | Command |
| --- | --- | --- | --- |
| [1. Isolated network](#case-1-seller-or-buyer-change-isolated-network) | seller, buyer, `packages/node`, payments, routing, contracts, new seller features | private: your sellers, your buyer, Anvil chain | `pnpm sandbox run <scenario>` |
| [2. Desktop only](#case-2-desktop-only-change-vpr-on-the-isolated-network) | desktop UI or main process (VPR) | the isolated network from case 1 | `pnpm sandbox desktop` |
| [3. Real network](#case-3-local-buyer-against-real-sellers-mainnet-real-funds) | buyer, proxy, routing, desktop buyer, checked against live sellers | Base mainnet, live sellers, a funded test wallet | `pnpm sandbox mainnet --real-funds` |
| [4. On a server](#case-4-on-a-server-with-the-desktop-in-your-browser) | any of the above, run on a Linux server, desktop streamed to your browser | as in cases 1 and 2 | `pnpm sandbox share` |

Each case is isolated from your real setup: `~/.antseed`, your keychain, your OS proxy settings and your running desktop are never touched. Every scenario run writes an HTML report with checks, metrics, screenshots and a video.

Agents: the `verify-antseed` skill (`.claude/skills/verify-antseed/SKILL.md`) says which scenario a change requires, how to fix a bug red to green with an `issue-<N>-<slug>` scenario, and what evidence to keep.

## Prerequisites

- Node 24 (`.nvmrc`; `up` refuses other majors because native modules would not load), then `pnpm install && pnpm run build`
- Desktop scenarios and cases 2 to 4: build the desktop too (`pnpm --filter @antseed/desktop run build`)
- Foundry's `anvil` on `PATH` (plus `forge` and `packages/contracts/lib/forge-std` for `--chain local`: `cd packages/contracts && forge install foundry-rs/forge-std --no-git`; the first `forge build` takes several minutes, later runs reuse `out/`)
- For the fork chain and for case 3, a dedicated Base mainnet RPC with an API key (Alchemy, QuickNode, ...) as `BASE_MAINNET_RPC_URL` in the worktree's gitignored `.env.local` (or exported in the shell, which wins). Public gateways rate-limit fork reads and Anvil times out. The URL is passed through process environments only and never printed or written to sandbox state.

  ```bash
  echo 'BASE_MAINNET_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>' >> .env.local
  ```

## Case 1: Seller or buyer change (isolated network)

Use this when you change the seller, the buyer, `packages/node`, payments, routing, discovery, provider plugins or contracts, or when you build a new feature that needs a seller. Everything runs on your machine with no real funds:

- an Anvil chain: a fork of Base mainnet (production contracts, fork-only USDC; default), or with `--chain local` a plain Anvil with `packages/contracts` deployed from source (no RPC key)
- one or more sellers from this worktree, each backed by an OpenAI-compatible mock upstream (or the real upstream with `--live`)
- a buyer and its proxy from this worktree (the same `BuyerProxy` the CLI and desktop use)
- a private bootstrap DHT node, so sandbox nodes only ever see each other

```bash
pnpm sandbox run chat-basic                    # starts a sandbox, runs, reports, stops
pnpm sandbox run payment-flow --chain local    # payment lifecycle on this worktree's contracts
pnpm sandbox run routing-smoke                 # two sellers, routing stays in the sandbox
pnpm sandbox run desktop-chat                  # the desktop drives a chat through the sandbox buyer
```

Which scenarios a change needs is decided in one place: the table in the `verify-antseed` skill (`.claude/skills/verify-antseed/SKILL.md`, "Decide what to prove"). A new seller feature gets a new scenario with its own `topology` (see [Scenarios](#scenarios)); for your own seller setup add `--config <seller config>`, and `--live` for the real upstream.

To keep the network up and poke at it yourself:

```bash
pnpm sandbox up [--chain fork|local] [--config FILE] [--live]
pnpm sandbox run chat-basic --keep             # reuses the running sandbox
eval "$(pnpm -s sandbox status --env)" && curl "$ANTSEED_PROXY_URL/v1/models"
pnpm sandbox down                              # settles and closes channels, then stops
```

Your seller setup: `--config FILE` takes an existing AntSeed config (such as a seller's `config.json`); see [Config](#config). `--live` uses the real upstream with your provider keys while settlement stays on the sandbox chain.

## Case 2: Desktop-only change (VPR on the isolated network)

Use this when only the desktop app changes. The desktop runs attach-only on the case 1 network: it uses the sandbox buyer and its wallet, and starts no buyer of its own.

```bash
pnpm sandbox up                  # or: pnpm sandbox run desktop-chat --keep
pnpm sandbox desktop             # dev mode: Vite hot reload for the renderer, tsc watch for main
pnpm sandbox:attach              # one step: starts or reuses routing-smoke, then opens the desktop
```

`pnpm sandbox desktop` is the interactive loop. Renderer edits show up immediately; main-process edits recompile on save and load when you quit and rerun the command. It runs next to your normal desktop with its own ports and data. Add `--cdp-port N` to also open Chrome DevTools Protocol on `127.0.0.1:N`, so an agent can drive it with `agent-browser connect N`.

For an agent-run check with evidence, use `pnpm sandbox run desktop-chat` (built desktop under Playwright: screenshots, video, renderer errors). Rebuild first: `pnpm --filter @antseed/desktop run build`. Write a scenario with `sb.desktop()` for a new desktop feature (see [Desktop automation](#desktop-automation)).

## Case 3: Local buyer against real sellers (mainnet, real funds)

Use this to check this worktree's buyer against the sellers that are live on the network, paying real USDC: buyer, proxy and routing changes, and the desktop's own buyer. It runs the full desktop (not attach-only). The desktop starts its own buyer from this worktree's build, discovers real sellers on the public DHT, and pays from a dedicated test wallet.

Setup (once): create a fresh wallet for testing only, put its key in `.env.local`, then fund its AntseedDeposits balance with a few USDC from the deposit view of `pnpm sandbox mainnet --real-funds` (the profile desktop shows the test wallet):

```bash
ANTSEED_SANDBOX_MAINNET_IDENTITY_HEX=<64 hex private key of the test wallet>   # never your personal wallet
ANTSEED_SANDBOX_MAINNET_MAX_RESERVE_USDC=0.50                                # optional; default 0.50, max 5
BASE_MAINNET_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
```

```bash
pnpm sandbox run mainnet-smoke --chain mainnet --real-funds   # agent-run check with a report
pnpm sandbox mainnet --real-funds                             # interactive: the built desktop on the profile
pnpm sandbox mainnet --real-funds --dev                       # same, with Vite hot reload (rebuilds the CLI and packages first)
pnpm sandbox mainnet --real-funds --fresh                     # reset the profile first
```

`mainnet-smoke` checks that the test wallet has a deposit, the desktop's buyer discovers live sellers and lists models, a chat from the UI gets a reply, the chat signed a nonzero amount within the cap, the on-chain reserve grew by at most the cap, and the renderer logged no errors.

Guard rails:

- **Explicit opt-in.** Every real-network command needs `--real-funds`; without it the command refuses. Agents only propose these runs and never start them on their own.
- **Spend caps.** The profile config sets `payments.maxReserveAmountUsdc` and `maxPerRequestUsdc` to the cap, so a channel can never lock more. `mainnet-smoke` also fails if this run signed more than the cap.
- **Isolated profile.** The desktop gets its own `HOME` (`profiles/mainnet/home`), so identity, config, chats and plugins never touch `~/.antseed`. The wallet key is encrypted with a mock keychain, not your login keychain. OS proxy settings and connected-app changes are off (`ANTSEED_DESKTOP_ISOLATED_PROFILE=1`). The buyer proxy uses its own port, never 8377.
- **This worktree's code.** The profile's `plugins/` links `@antseed/router-local` and its `@antseed/*` dependencies to this worktree's build; nothing is downloaded. Rebuild after changes.
- **One user per wallet.** A machine-wide lock stops two worktrees from driving the same test wallet at once. A profile created for a different wallet is refused until you pass `--fresh`.

Deposits and withdrawals are not automated: top the wallet up by hand when it runs low.

## Case 4: On a server, with the desktop in your browser

Use this to run cases 1 and 2 on a Linux server and click through the desktop from your laptop.

- **Scenarios:** `pnpm sandbox run <scenario>` works on the server as is. Desktop scenarios need a display; on a headless server wrap them in `xvfb-run -a pnpm sandbox run desktop-chat`. Inspect the reports from your laptop with `pnpm sandbox report --serve` (see [Desktop automation](#desktop-automation)).
- **Interactive desktop:** `pnpm sandbox share` streams the attach-only desktop to your browser over Tailscale. See [Share](#share-linux-server).

`share` streams only the attach-only desktop (case 2), not the real-funds profile.

# Reference

## Commands

```bash
pnpm sandbox up [--chain fork|local] [--config FILE] [--live] [--deposit-usdc N] [--block N] [--scenario NAME]
pnpm sandbox status [--json] [--env]   # ports, wallets, balances, peers, URLs, env exports
pnpm sandbox run <scenario> [--chain fork|local|mainnet] [--keep] [--strict] [--trace] [--real-funds]
pnpm sandbox desktop                  # attach-only desktop (dev mode) on the sandbox buyer
pnpm sandbox:attach                   # start/reuse routing-smoke, then open the attached desktop
pnpm sandbox mainnet --real-funds [--dev] [--fresh]   # full desktop on the real network (case 3)
pnpm sandbox logs [supervisor|anvil|seller-<id>] [--follow]
pnpm sandbox down [--force]           # settle + close channels while Anvil is alive, then stop
pnpm sandbox list                     # every sandbox on this machine
pnpm sandbox report [run] [--open]    # latest (or named) run: index.html, video, trace paths
pnpm sandbox report --serve [--port N] [--host H]   # serve reports/ over HTTP (loopback by default)
pnpm sandbox share [--idle MIN] [--fresh] [--no-tailscale] [--stop]   # Linux server: desktop in your browser over Tailscale
```

`--slot NAME` on any command runs an additional sandbox for the same worktree (for example two scenarios with different topologies side by side).

## Chains

| | `--chain fork` (default) | `--chain local` |
| --- | --- | --- |
| Chain | Anvil fork of Base mainnet, chain 8453 | empty Anvil, chain 31337 |
| Contracts | deployed production stack (recognized-usage) | this worktree's `packages/contracts`, deployed by `script/Deploy.s.sol` at the `base-local` addresses |
| Setup | fork-only USDC mint, ERC-8004 + SellerRegistry/ANTS pool stake, deposit | MockUSDC mint, MockERC8004 `register()`, 50 USDC `AntseedStaking.stake`, deposit |
| Needs | `BASE_MAINNET_RPC_URL` | `forge` + forge-std, no RPC key |
| Use for | release checks against what is live | contract changes, payment-flow checks, offline work |

`--chain mainnet` is not an Anvil chain: it is case 3 (`run` only, with `--real-funds`).

`run` picks the chain from `--chain`, else the running sandbox's chain, else the scenario's first `targets` entry. A scenario lists the chains it supports in `meta.targets`.

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
  - `mock.usage: 'load'` sizes usage like real traffic instead (the payment stress mock): prompt tokens from the request size, a random completion within `outTokens` (default 100 to 4000), latency within `latencyRangeMs` (default 50 to 3000 ms), streams chunked over that time.
  - `mock.fault500Rate` and `mock.disconnectRate` (0 to 1) answer that share of tagged requests with an upstream 500 or cut the response midway. `sb.setMockFaults(id, { ... })` changes them during a run.
  - Every mock keeps a **delivery ledger** keyed by the `[req:TAG]` marker in the prompt (untagged requests get `untagged-N`): whether any byte reached the wire, how the response ended (`ok`, `500`, `disconnect`, `client-gone`) and what it cost at the seller's price. That ledger is the independent judge of what the buyer owes (`sb.deliveries(id)`, `sb.assertDeliveredWorkPaid`).
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
  targets: ['fork', 'local'],   // chains it can run on; the first is the default
  requires: ['mockControl'],    // capabilities: warpTime, sellerControl, buyerControl, mockControl, liveUpstream, desktop, sourceContracts (local only)
};

// Plain data. Sellers inherit the config's providers unless they bring their own.
export const topology = {
  sellers: [{ id: 'fast', mock: { latencyMs: 20 } }, { id: 'slow', mock: { latencyMs: 400 } }],
  buyer: { depositUsdc: '10', routingPreferences: { preferLowLatency: true } },
  chain: { block: 52223957 },   // optional fork pin
  payments: { settlementIdleMs: 5000, minBudgetPerRequestUsdc: '0.01' },  // optional: seller idle-settle timer (default 600000); seller minimum budget per request (SDK default 0.5; `antseed seller start` uses 0.01)
};

// Payment stress shapes (see "Payment stress" below) add, all optional:
//   chain:  { rpc: 'base', blockTimeSec: 2, topUpThresholdBps: 6500 }
//   seller: { mock: { usage: 'load', latencyRangeMs: [50, 3000], outTokens: [100, 4000], fault500Rate: 0.05, disconnectRate: 0.05 } }
//   buyer:  { depositUsdc: '500', maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' }

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
| Chain | `buyerBalance()`, `usdcBalance(address)`, `settledEvents(sellerId)` (on-chain `ChannelSettled`), `channelState(channelId)`, `buyerRequestClose(channelId)` / `buyerWithdraw(channelId)` (the buyer's unilateral exit via Anvil impersonation; warp 15 min before withdraw) |
| Control | `stopSeller(id)`, `startSeller(id)`, `stopBuyer()` / `startBuyer()` (buyer node + proxy; sellers see a disconnect), `setMockLatency(id, ms)`, `mockRequests(id)`, `warp(seconds)`, `waitFor(fn, label, { timeoutMs })` |
| Faults | `faults.loseNeedAuths(count)` (the buyer drops its next `count` seller NeedAuth frames, as if lost), `faults.lostNeedAuths()` (the dropped payloads). Use only to reach a state no public path produces |
| Desktop | `desktop()` → `ui.sendChat(prompt, { expect })`, `ui.openChat()`, `ui.text()`, `ui.screenshot(name)`, `ui.page` (Playwright), `ui.errors`, `ui.close()` |
| Load and oracle | `load({ concurrency, requests, streamRatio, abortRatio, imageRatio, model, imageModel, sellerId, restart: { who, sellerId, atFraction }, gate })`, `paymentSnapshot()`, `assertDeliveredWorkPaid({ before, results, injected })`, `assertNoCrashes()`, `setMockFaults(id, { fault500Rate, disconnectRate })`, `deliveries(id)`, `health()`, `gates` |
| Reporting | `check(name, ok, detail)`, `knownIssue(name, ok, detail, issue)`, `metric(name, value)`, `event(type, data)`, `mockCostPerChat(sellerId, model)` |

Each run writes `reports/<timestamp>-<scenario>/index.html` (a self-contained page with checks, metrics, screenshots, video and events), `report.json` (result, checks, known issues, metrics, config hash, fork block, topology, sellers, buyer), `events.jsonl` and `metrics.json`. A failed check fails the run with a nonzero exit.

`knownIssue` records a check for a tracked defect outside the sandbox without failing the run; `--strict` makes it fail. It currently tracks one issue: after a cooperative close, `chat-basic` sees one extra request's cost settled (two 18 micro-USDC chats settle 54, not 36). Settle-on-disconnect does not have it (`payment-flow` checks that path exactly). On-chain settlement still matches exactly what the buyer signed.

Shipped scenarios:

- `chat-basic`: catalog, a non-streaming and a streaming chat, receipts, then exact on-chain settlement with zero reserves after close.
- `desktop-chat`: launches the built attach-only desktop under Playwright, sends a chat from the UI, checks the sandbox reply, the upstream request, the signed channel and exact settlement, and saves screenshots plus `desktop-main.log` in the report.
- `payment-flow`: the CI payment flow and more (default chain: local). Deposit, reserve locked on-chain, three paid chats on one channel with cumulative SpendingAuth, buyer disconnect, seller settles and closes on its own, exact settled amount, fee split and reserve release, buyer reconnects on a fresh channel, cooperative close, exact totals across both channels.
- `mainnet-smoke`: case 3 on the real network (needs `--chain mainnet --real-funds`). Live discovery, one paid desktop chat, spend within the cap, consistent on-chain reserve.
- `routing-smoke`: two sellers with different mock latency; the buyer sees only sandbox sellers, pinned and auto-routed chats stay inside the sandbox, and per-seller settlement is exact.
- `stress-smoke`, `stress-c32`, `stress-c64`, `stress-smallreserve`, `stress-images`, `stress-faults`, `stress-restart-buyer`, `stress-restart-seller`: the payment stress scenarios on the sandbox (see [Payment stress](#payment-stress)).
- `issue-1050-stale-channel`: #1050. The buyer pays, stops, and the seller closes the channel on disconnect. After a restart the buyer must retire the closed channel in its store, `/_antseed/buyer-usage`, `/_antseed/channels` and `antseed buyer status` (all count 0), then pay again on a fresh channel; the payment oracle judges both phases.
- `issue-1200-spendingauth-catchup`: #1200. A lost NeedAuth leaves the buyer under-signed, the seller's budget-exhausted 402 asks it to catch up, and the buyer must sign exactly the delivered spend, so settle-on-disconnect charges exactly the delivered work. Fails on a buyer that signs `max(target, signed + minBudgetPerRequest)`.

Mainnet scenarios (`targets: ['mainnet']`) get a smaller `sb`: `check`, `knownIssue`, `metric`, `event`, `waitFor`, `desktop()` (the full profile desktop), `waitForPeers({ min })`, `models()`, `channels({ all })`, `signedSnapshot()`, `spentSince(snapshot)`, `assertWithinCap(snapshot)`, `buyerBalance()` (on-chain deposit) and `capMicros`. There is no chain or seller control on the real network.

## Payment stress

The payment stress harness (`e2e/stress`, run in CI by `node e2e/stress/ci.mjs`) checks that paid traffic under concurrency, Base-like RPC latency, upstream faults and restarts is paid for exactly. Its building blocks are sandbox features too, so a stress shape is an ordinary scenario on the sandbox network:

| Stress harness | Sandbox |
| --- | --- |
| `rpc-proxy.mjs` between each peer and Anvil | `chain.rpc: 'base'`: the supervisor puts that same proxy in front of Anvil per node (buyer and each seller) on one shared chain clock, and Anvil mines every `blockTimeSec` (2 s) after setup. `sb.health().rpc` and the report's `metrics.rpc` count calls, 429s, stale reads and missing receipts |
| `mock-upstream.mjs` (load usage, 500s, disconnects, per-request delivery record) | the sandbox mock with `usage: 'load'`, fault rates and its delivery ledger |
| `harness.mjs` load generator | `sb.load(...)` (same tagged requests, stream and abort ratios, image share, mid-load restart) |
| `analysis.mjs` payment invariants | `sb.assertDeliveredWorkPaid(...)` runs `analyzePayments` itself on the sandbox's seller and buyer stores, chain and mock ledgers |
| crash patterns, unexpected exits, SIGKILL stops | `sb.assertNoCrashes()` (peer logs since the run started, supervisor health) |
| `ci.mjs` `GATES` | `sb.gates` / `GATES` in `lib/stress.mjs`, passed as `load({ gate })` |
| owner-only chain setup (credit limit, 65% top-up threshold) | `buyer.depositUsdc` above 10 sets the Deposits credit limit override; `chain.topUpThresholdBps` sets the channels threshold (owner impersonated on Anvil, fork or local) |

`lib/stress.mjs` exports `stressTopology()` (the stress network: a 3 / 15 USD per million token seller with a 0.04 USD image model, a 500 USDC deposit, a 1 USDC reserve cap, Base-like RPCs, 65% top-up, 15 s idle settle, the CLI seller's 0.01 USDC minimum budget per request) and `stressRun(sb, { load, faults, gate })` (snapshot, warm-up, faults on, gated load, faults off, oracle, crash checks). A new stress shape is a few lines:

```js
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';
export const meta = { description: '...', targets: ['local', 'fork'], requires: ['mockControl'] };
export const topology = stressTopology({ buyer: { maxReserveUsdc: '0.25' } });
export async function run(sb) {
  await stressRun(sb, { load: { concurrency: 32, requests: 256 }, gate: GATES.default });
}
```

The oracle fails a run on any of: delivered work not settled, settlement above what reached the wire, a response the client received in full that the mock never delivered, per-channel signed or accepted amounts that differ from what settled, a deposit decrease that differs from the sum settled or from seller plus fee income, reserve left locked, a channel left open, and (with no faults, aborts or restarts) seller spend that differs from the delivered cost. It judges only what happened after the `paymentSnapshot()`, so it also works on a sandbox kept with `--keep`; it refuses to run while an earlier channel is still open.

```bash
pnpm sandbox run stress-smoke --chain local        # quick: 6 requests, about a minute with setup
pnpm sandbox run stress-c32 --chain local          # the CI shapes; each takes a few minutes
pnpm sandbox run stress-restart-seller --chain local
```

`e2e/stress` still runs in CI unchanged; the sandbox imports its `rpc-proxy.mjs` and `analysis.mjs` rather than copying them, so both harnesses share one set of invariants.

## Desktop automation

`sb.desktop()` launches the built desktop (`apps/desktop/dist`) under Playwright's Electron driver in attach-only mode on this sandbox's buyer. Chats, sessions and projects go to `buyer/desktop/` and Electron data to `desktop-automation/` inside the sandbox; telemetry is off; nothing reads or writes `~/.antseed`. Rebuild after desktop changes (`pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`). The window is visible while it runs, and it closes automatically when the scenario ends.

Every desktop run records `video/desktop.webm` and keeps screenshots in `screenshots/`; a chat that times out also saves `chat-timeout.png` and puts the visible screen text in the error. `run --trace` additionally records a Playwright trace (`trace.zip`, 100+ MB) for `npx playwright show-trace`. Each launch starts from an empty desktop state (`desktop-automation/` is reset).

To inspect results from a remote machine, run `pnpm sandbox report --serve --port 8799` there and `ssh -L 8799:127.0.0.1:8799 <host>` locally, then open `http://127.0.0.1:8799/`. The server is read-only, serves only report file types inside `reports/`, supports video seeking, and binds to `127.0.0.1` unless `--host` says otherwise.

## Share (Linux server)

`pnpm sandbox share` runs the sandbox desktop on a Linux server and streams it to your browser on your tailnet. You click a link and use the real app (mouse, keyboard, chat, payments on the sandbox chain) while everything runs on the server. Desktop browsers only.

```bash
# on the server, in the worktree
pnpm sandbox share                   # starts the sandbox if needed, prints https://<host>.<tailnet>.ts.net/<sandbox-name>/
pnpm sandbox share --stop            # or pnpm sandbox down, which also stops the share
```

The link opens a landing page with the branch, chain, desktop status, a button to open the desktop, and links to the run reports. It does the following:

- Starts a virtual display (Xvfb, 1440x900), openbox if installed, and x11vnc on a unix socket inside the sandbox directory.
- Runs the attach-only desktop on the sandbox buyer, with state in `desktop-share/`. `--fresh` resets that state first.
- Serves noVNC, the landing page and `reports/` on a loopback port.
- Publishes it with `tailscale serve --https=443 --set-path=/<sandbox-name>`, so each worktree gets its own path on the same host.
- Stops after `--idle` minutes without a viewer (default 120, range 5-1440), when the sandbox stops, or on `share --stop`. Stopping removes the `tailscale serve` path.

Server setup (once):

```bash
sudo apt-get install -y xvfb x11vnc novnc openbox
sudo apt-get install -y libgtk-3-0 libnss3 libasound2 libgbm1 libxss1   # Electron runtime libraries
sudo tailscale set --operator=$USER          # lets share run tailscale serve without sudo
pnpm install && pnpm run build               # share needs apps/desktop/dist
```

Enable MagicDNS and HTTPS certificates for the tailnet in the Tailscale admin console. If noVNC is not under `/usr/share/novnc`, set `ANTSEED_SANDBOX_NOVNC_DIR` to the directory that contains `vnc.html`.

Security:

- Only tailnet members can reach the link: the server listens on `127.0.0.1` and Tailscale proxies to it.
- `share` refuses to run while Tailscale Funnel is on for port 443, because Funnel would put the desktop on the public internet.
- The VNC socket is never exposed. The WebSocket bridge rejects cross-origin pages.
- The desktop runs on the sandbox wallet and sandbox chain only (mock upstream unless the sandbox was started with `--live`).

Without Tailscale, use `--no-tailscale`, then `ssh -L PORT:127.0.0.1:PORT <server>` and open `http://127.0.0.1:PORT/`.

For agents: with `ANTSEED_SANDBOX_SHARE_DEBUG_PORT=N`, the shared desktop listens for Chrome DevTools Protocol on `127.0.0.1:N`. An agent can then read the DOM over CDP to check what a viewer sees through noVNC. Logs: `logs/share.log`, `share-desktop.log`, `share-vnc.log`, `share-xvfb.log`, `share-wm.log`.

## Control API

The supervisor exposes a loopback-only API with a bearer token stored in `control.json` (mode 0600). Scenarios use it through `sb`; you rarely need it directly.

`GET /status`, `GET /health`, `POST /channels/close {sellerId?}`, `POST /chain/warp {seconds}`, `POST /buyer/stop`, `POST /buyer/start`, `POST /sellers/:id/stop`, `POST /sellers/:id/start`, `GET|POST /sellers/:id/mock {latencyMs?, fault500Rate?, disconnectRate?}`, `GET /sellers/:id/deliveries`, `GET|POST /faults/buyer/need-auth-loss {count}`, `POST /shutdown`

## Fork cache

Applies to `--chain fork` only. Anvil's RPC cache makes a warm `up` take a few seconds instead of a minute.

- The shared cache lives in `~/.antseed-sandbox/.cache/anvil` (override with `ANTSEED_SANDBOX_CACHE_DIR`). It is seeded once from the older `~/.antseed-e2e/anvil-home` cache, which is only ever read.
- Each sandbox copies the warm block into its own `anvil-home/`; Anvil never writes the shared cache.
- On exit the sandbox's copy is published back under `cache.lock` with a temp file and an atomic rename, and only if it is larger than the shared copy.
- Pruning keeps the newest 3 blocks and never removes a block pinned by a running sandbox.
- Without `--block`, the newest warm block younger than 72 hours is reused; otherwise the fork pins a block just behind head.

## Tests

```bash
pnpm test:sandbox       # fast unit tests (node --test): options, config, naming, locks, manifest, ports, cache, mock, control, stress load, gates and ledger
pnpm test:sandbox:e2e   # full flow on a real fork: up, reattach, status, run chat-basic, down, isolation checks
pnpm sandbox run payment-flow --chain local   # payment lifecycle on source-deployed contracts, no RPC key
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

Deferred (not needed for the four cases):

- a pool of test wallets with rotation and automatic top-ups for case 3
- a canary seller of ours on mainnet, so case 3 can also test seller changes against real buyers
- multiple sellers from different configs in one sandbox
- a CI job: the e2e scenarios plus `stress-smoke` on every PR, the full stress set nightly with repeats; then retire `e2e/stress`'s own chain, mock, bootstrap and config writers once the sandbox scenarios match its results
- a `--runs N` repeat mode for stress scenarios (the stress harness's `--runs`)
- fail points in `packages/node` at payment boundaries (before a settle is sent, after a NeedAuth arrives, before a close), generalizing `faults.loseNeedAuths`
- retiring `e2e/scripts/full-payment-flow.mjs` once local runs prove stable in CI
- streaming the real-funds profile desktop with `share`
- Anvil state snapshots, a Herdr tab launcher, rebasing the video harness onto this
