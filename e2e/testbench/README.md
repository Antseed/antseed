# Worktree testbench

[docs/testing.md](../../docs/testing.md) maps every kind of test in this repo; this page covers the testbench.

`pnpm testbench` tests the current worktree's changes end to end. It covers four cases. Find the one that matches your change and follow its section.

| Case | What changed | Network | Command |
| --- | --- | --- | --- |
| [1. Isolated network](#case-1-seller-or-buyer-change-isolated-network) | seller, buyer, `packages/node`, payments, routing, contracts, new seller features | private: your sellers, your buyer, Anvil chain | `pnpm testbench run <scenario>` |
| [2. Desktop only](#case-2-desktop-only-change-vpr-on-the-isolated-network) | desktop UI or main process (VPR) | the isolated network from case 1 | `pnpm testbench desktop` |
| [3. Real network](#case-3-local-buyer-against-real-sellers-mainnet-real-funds) | buyer, proxy, routing, desktop buyer, checked against live sellers | Base mainnet, live sellers, a funded test wallet | `pnpm testbench mainnet --real-funds` |
| [4. On a server](#case-4-on-a-server-with-the-desktop-in-your-browser) | any of the above, run on a Linux server, desktop streamed to your browser | as in cases 1 and 2 | `pnpm testbench share` |

Each case is isolated from your real setup: `~/.antseed`, your keychain, your OS proxy settings and your running desktop are never touched. Every scenario run writes an HTML report with checks, metrics, screenshots and a video.

Agents: the `verify-antseed` skill (`.claude/skills/verify-antseed/SKILL.md`) says which scenario a change requires, how to fix a bug red to green with an `issue-<N>-<slug>` scenario, and what evidence to keep.

## Prerequisites

- Node 24 (`.nvmrc`; `up` refuses other majors because native modules would not load), then `pnpm install && pnpm run build`
- Desktop scenarios and cases 2 to 4: build the desktop too (`pnpm --filter @antseed/desktop run build`)
- Desktop scenarios: Playwright's own ffmpeg, which records the run video (`pnpm exec playwright install ffmpeg`, once per machine; it goes to Playwright's cache, `~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS). Without it the window never loads, so `run` refuses a desktop scenario before starting anything.
- Linux as root (common on servers): Chromium refuses to run as root, so the desktop launchers add `--no-sandbox` there and say so. Run as a normal user to keep Chromium's testbench on.
- Foundry's `anvil` on `PATH` (plus `forge` and `packages/contracts/lib/forge-std` for `--chain local`: `cd packages/contracts && forge install foundry-rs/forge-std --no-git`; the first `forge build` takes several minutes, later runs reuse `out/`)
- For the fork chain and for case 3, a dedicated Base mainnet RPC with an API key (Alchemy, QuickNode, ...) as `BASE_MAINNET_RPC_URL` in the worktree's gitignored `.env.local` (or exported in the shell, which wins). Public gateways rate-limit fork reads and Anvil times out. The URL is passed through process environments only and never printed or written to testbench state. Anvil forks through a loopback relay (`http://127.0.0.1:<port>/<random token>`), so the URL and its key never appear on a command line that other users can read with `ps`.

  ```bash
  echo 'BASE_MAINNET_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>' >> .env.local
  ```

## Case 1: Seller or buyer change (isolated network)

Use this when you change the seller, the buyer, `packages/node`, payments, routing, discovery, provider plugins or contracts, or when you build a new feature that needs a seller. Everything runs on your machine with no real funds:

- an Anvil chain: a fork of Base mainnet (production contracts, fork-only USDC; default), or with `--chain local` a plain Anvil with `packages/contracts` deployed from source (no RPC key)
- one or more sellers from this worktree, each backed by an OpenAI-compatible mock upstream (or the real upstream with `--live`)
- a buyer and its proxy from this worktree (the same `BuyerProxy` the CLI and desktop use), paying from the testbench's own wallet (see [Buyer wallet](#buyer-wallet))
- a private bootstrap DHT node, so testbench nodes only ever see each other

```bash
pnpm testbench run chat-basic                    # starts a testbench, runs, reports, stops
pnpm testbench run payment-flow --chain local    # payment lifecycle on this worktree's contracts
pnpm testbench run routing-smoke                 # two sellers, routing stays in the testbench
pnpm testbench run desktop-chat                  # the desktop drives a chat through the testbench buyer
```

Which scenarios a change needs is decided in one place: the table in the `verify-antseed` skill (`.claude/skills/verify-antseed/SKILL.md`, "Decide what to prove"). A new seller feature gets a new scenario with its own `topology` (see [Scenarios](#scenarios)); for your own seller setup add `--config <seller config>`, and `--live` for the real upstream.

To keep the network up and poke at it yourself:

```bash
pnpm testbench up [--chain fork|local] [--mode sdk|cli] [--contracts full|payments] [--config FILE] [--live]
pnpm testbench run chat-basic --keep             # reuses the running testbench
eval "$(pnpm -s testbench status --env)" && curl "$ANTSEED_PROXY_URL/v1/models"
pnpm testbench down                              # settles and closes channels, then stops
```

Your seller setup: `--config FILE` takes an existing AntSeed config (such as a seller's `config.json`); see [Config](#config). `--live` uses the real upstream with your provider keys while settlement stays on the testbench chain.

### Buyer wallet

The testbench buyer never uses your real wallet. By default it creates a throwaway key on the first `up` and keeps it in `buyer/identity.key` inside the testbench, so the address stays the same across runs. To pick the address yourself (for example a test wallet you want to reuse on the fork), put its key in the worktree's gitignored `.env.local` or export it (the shell wins):

```bash
ANTSEED_TESTBENCH_BUYER_IDENTITY_HEX=<64 hex private key of a test wallet>   # never your personal wallet
```

`up` installs that key as the testbench buyer's `identity.key`, prints the address, and stops the testbench if the running buyer reports a different one. Removing the variable keeps the last key in the testbench; delete `buyer/identity.key` to get a new throwaway key. Real-funds runs (case 3) use their own variable, `ANTSEED_TESTBENCH_MAINNET_IDENTITY_HEX`.

## Case 2: Desktop-only change (VPR on the isolated network)

Use this when only the desktop app changes. The desktop runs attach-only on the case 1 network: it uses the testbench buyer and its wallet, and starts no buyer of its own.

```bash
pnpm testbench up                  # or: pnpm testbench run desktop-chat --keep
pnpm testbench desktop             # dev mode: Vite hot reload for the renderer, tsc watch for main
pnpm testbench:attach              # one step: starts or reuses routing-smoke, then opens the desktop
```

`pnpm testbench desktop` is the interactive loop. Renderer edits show up immediately; main-process edits recompile on save and load when you quit and rerun the command. It runs next to your normal desktop with its own ports and data: `HOME` is the testbench's `home/`, and Electron's data lives in `$TMPDIR/antseed-desktop/<instance>/` (the dev launcher's location), not in the testbench directory. Add `--cdp-port N` to also open Chrome DevTools Protocol on `127.0.0.1:N`, so an agent can drive it with `agent-browser connect N`.

For an agent-run check with evidence, use `pnpm testbench run desktop-chat` (built desktop under Playwright: screenshots, video, renderer errors). Rebuild first: `pnpm --filter @antseed/desktop run build`. Write a scenario with `tb.desktop()` for a new desktop feature (see [Desktop automation](#desktop-automation)).

## Case 3: Local buyer against real sellers (mainnet, real funds)

Use this to check this worktree's buyer against the sellers that are live on the network, paying real USDC: buyer, proxy and routing changes, and the desktop's own buyer. It runs the full desktop (not attach-only). The desktop starts its own buyer from this worktree's build, discovers real sellers on the public DHT, and pays from a dedicated test wallet.

Setup (once): create a fresh wallet for testing only, put its key in `.env.local`, then fund its AntseedDeposits balance with a few USDC from the deposit view of `pnpm testbench mainnet --real-funds` (the profile desktop shows the test wallet):

```bash
ANTSEED_TESTBENCH_MAINNET_IDENTITY_HEX=<64 hex private key of the test wallet>   # never your personal wallet
ANTSEED_TESTBENCH_MAINNET_MAX_RESERVE_USDC=0.50                                # optional; default 0.50, max 5
BASE_MAINNET_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
```

```bash
pnpm testbench run mainnet-smoke --chain mainnet --real-funds   # agent-run check with a report
pnpm testbench mainnet --real-funds                             # interactive: the built desktop on the profile
pnpm testbench mainnet --real-funds --dev                       # same, with Vite hot reload (rebuilds the CLI and packages first)
pnpm testbench mainnet --real-funds --fresh                     # reset the profile first
```

`mainnet-smoke` checks that the test wallet has a deposit, the desktop's buyer discovers live sellers and lists models, a chat from the UI gets a reply, the chat signed a nonzero amount within the cap, the on-chain reserve grew by at most the cap, and the renderer logged no errors.

Guard rails:

- **Explicit opt-in.** Every real-network command needs `--real-funds`; without it the command refuses. Agents only propose these runs and never start them on their own.
- **Spend caps, per step, not in total.** The profile config sets `payments.maxReserveAmountUsdc` and `maxPerRequestUsdc` to the cap. That bounds each reserve step and each request's overdraft, not the total. When a channel runs low the buyer tops it up on its own: `topUpReserve` in `packages/buyer-core` raises the channel's ceiling by `maxReserveAmountUsdc` per top-up (by up to 10 times that under parallel load). So a long session, interactive or scripted, can reserve and spend more than the cap, and each seller's channel gets its own. The only hard limit is the test wallet's AntseedDeposits balance: fund it with no more than you are willing to spend. `mainnet-smoke` checks after the fact that the run signed at most the cap and that the on-chain reserve grew by at most the cap, and fails the run if not. It cannot stop a signature before it is made, and the interactive `pnpm testbench mainnet` desktop has no such check.
- **Isolated profile.** The desktop gets its own `HOME` (`profiles/mainnet/home`), so identity, config, chats and plugins never touch `~/.antseed`. The wallet key is encrypted with a mock keychain on macOS and Chromium's basic password store on Linux, never your login keychain or session keyring. A Linux profile whose `identity.enc` an earlier version encrypted with the keyring is not launched: the testbench stops, deletes nothing, and says how to re-seed it from `ANTSEED_TESTBENCH_MAINNET_IDENTITY_HEX`. Windows is refused before anything is prepared, because Windows reads the home directory from `USERPROFILE` and `APPDATA`, not `HOME`. OS proxy settings and connected-app changes are off (`ANTSEED_DESKTOP_ISOLATED_PROFILE=1`). The buyer proxy uses its own port, never 8377.
- **This worktree's code.** The profile's `plugins/` links `@antseed/router-local` and its `@antseed/*` dependencies to this worktree's build; nothing is downloaded. Rebuild after changes.
- **One user per wallet.** A machine-wide lock stops two worktrees from driving the same test wallet at once. A profile created for a different wallet is refused until you pass `--fresh`.

Deposits and withdrawals are not automated: top the wallet up by hand when it runs low.

## Case 4: On a server, with the desktop in your browser

Use this to run cases 1 and 2 on a Linux server and click through the desktop from your laptop.

- **Scenarios:** `pnpm testbench run <scenario>` works on the server as is. Desktop scenarios need a display; on a headless server wrap them in `xvfb-run -a pnpm testbench run desktop-chat`. Inspect the reports from your laptop with `pnpm testbench report --serve` (see [Desktop automation](#desktop-automation)).
- **Interactive desktop:** `pnpm testbench share` streams the attach-only desktop to your browser over Tailscale. See [Share](#share-linux-server).

`share` streams only the attach-only desktop (case 2), not the real-funds profile.

# Reference

## Commands

```bash
pnpm testbench up [--chain fork|local] [--mode sdk|cli] [--config FILE] [--live] [--deposit-usdc N] [--block N] [--scenario NAME]
pnpm testbench status [--json] [--env]   # ports, wallets, balances, peers, URLs, env exports
pnpm testbench run <scenario> [--chain fork|local|mainnet] [--mode sdk|cli] [--contracts full|payments] [--seed N] [--run-timeout SECONDS] [--keep] [--strict] [--trace] [--real-funds]
pnpm testbench desktop                  # attach-only desktop (dev mode) on the testbench buyer
pnpm testbench:attach                   # start/reuse routing-smoke, then open the attached desktop
pnpm testbench mainnet --real-funds [--dev] [--fresh]   # full desktop on the real network (case 3)
pnpm testbench logs [supervisor|anvil|seller-<id>|buyer] [--follow]   # buyer: cli mode only
pnpm testbench down [--force]           # settle + close channels while Anvil is alive, then stop; exits 1 if the shutdown reported errors or left reserve locked, also when that shutdown already finished (watchdog, earlier down)
pnpm testbench list                     # every testbench on this machine
pnpm testbench scenarios [--json]       # every scenario with its targets and description
pnpm testbench report [run] [--open]    # latest (or named) run: index.html, video, trace paths
pnpm testbench report --serve [--port N] [--host H]   # serve reports/ over HTTP (loopback by default)
pnpm testbench share [--idle MIN] [--fresh] [--no-tailscale] [--stop]   # Linux server: desktop in your browser over Tailscale
```

`--slot NAME` on any command runs an additional testbench for the same worktree (for example two scenarios with different topologies side by side).

## Chains

| | `--chain fork` (default) | `--chain local` |
| --- | --- | --- |
| Chain | Anvil fork of Base mainnet, chain 8453 | empty Anvil, chain 31337 |
| Contracts | deployed production stack (recognized-usage) | this worktree's `packages/contracts` at the `base-local` addresses: the full production stack by default, see below |
| Setup | fork-only USDC mint, ERC-8004 + SellerRegistry/ANTS pool stake, deposit | MockUSDC mint, MockERC8004 `register()`, then the stake (full: SellerRegistry binding + ANTS seller-pool stake, as on Base; payments: 50 USDC `AntseedStaking.stake`), deposit |
| Needs | `BASE_MAINNET_RPC_URL` | `forge` + forge-std, no RPC key |
| Use for | release checks against what is live | contract changes, payment-flow checks, offline work |

`--chain mainnet` is not an Anvil chain: it is case 3 (`run` only, with `--real-funds`).

### Local contract layouts

`topology.chain.contracts` (or `--contracts` on `up` and `run`) picks what `--chain local` deploys. A fork always has Base's contracts.

| Layout | Deploys | Registry staking / emissions | `up` (warm, this repo's Mac) |
| --- | --- | --- | --- |
| `full` (default) | `script/Deploy.s.sol`, then `script/DeployLocalFull.s.sol` (M001's deploy broadcast adapted to a fresh chain), a warp into the gate's effective epoch, `M001 Cutover.s.sol`, `DeployFreeUsage.s.sol` and `M003 Deploy.s.sol` unchanged, and M003's manual owner steps 1 and 3: payments, ANTS, the emissions gate, seller pools and registry, usage accounting and rewards, the legacy escrow, wash-trading registry (development verifier), points policies, free usage, KBF audits and verification results | `AntseedSellerRegistry` / `AntseedUsageAccounting` (recognized usage, as on Base) | about 17 s |
| `payments` | `script/Deploy.s.sol` only: registry, MockUSDC, MockERC8004, ANTS, legacy staking and emissions, deposits, channels, stats, deposit relay | `AntseedStaking` / `AntseedEmissions` (legacy) | about 8 s |

Every contract lands at a fixed deployer nonce (`e2e/testbench/lib/local-deploy.mjs`), and the addresses reach the code the way production ones do: through `getChainConfig('base-local')` in `packages/node` and the `payments.crypto` the testbench writes into each node's config. `up` checks that every layout address has code and that the registry points where the layout says. `base-local` keeps naming Deploy.s.sol's legacy contracts in `stakingContractAddress` and `emissionsContractAddress` (the stress harness and the e2e scripts deploy only Deploy.s.sol); on `full` the testbench writes them as Base does after the cutover, with the legacy ones in `legacyStakingContractAddress` and `legacyEmissionsContractAddress`.

Notes on `full`:

- `AntseedEmissionsGate` hardcodes Base's ANTS token and genesis, so the deploy copies Deploy.s.sol's ANTSToken (code and storage) to `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263`, and epochs follow Base's clock.
- Anvil starts four weeks in the past and is set to wall time once setup is done, so the warps setup needs (into the effective epoch, past the stake activation delay) leave the chain at wall time, not weeks ahead.
- Sellers' ANTS come from the legacy emissions escrow, as on the fork. M002 (legacy seller claims) is not run: it needs the legacy V2 emissions and the seller rewards pool, which a fresh chain never had.
- The team wallet and the verification bucket's first controller are anvil accounts 8 and 9 (the gate takes one minter per controller; the deployer, anvil account 0, is the protocol reserve). No KBF auditor is approved and verification rewards are off, as M003 leaves them.

`manifest.chain.contracts` and `tb.contracts` name every address (`registry`, `deposits`, `channels`, `usdc`, `antsToken`, `staking`, `emissions`, `sellerPools`, `sellerRegistry`, `usageAccounting`, `emissionsGate`, `freeUsage`, `verification`, `verificationResults`, ..., plus `legacyAntsToken`, `washTradingVerifier`, `washTradingPointsPolicy` and `verificationPointsPolicy` on the local chain); `manifest.localDeploy.timingsMs` has the time of each deploy step.

`run` picks the chain from `--chain`, else the running testbench's chain, else the scenario's first `targets` entry. A scenario lists the chains it supports in `meta.targets`.

`run` starts a testbench with the scenario's topology if none is running and stops it afterwards unless `--keep`. If a testbench is running with a different topology it refuses; run `down` first or use `--slot`. Topologies are compared on every setting that changes behavior (sellers, providers and prices, each mock's latency, usage, fault rates and ranges, node env, buyer deposit, caps, routing and `maxPricing`, `payments.*`, `chain.*`, mode); only `budgets` are left out, and the refusal names the settings that differ. A fork block the run does not pin matches the running one. The upstream must match too: a `run` or `up` without `--live` never reuses or reattaches to a testbench started with `--live` (its sellers call a real provider), and `--live` never reattaches to a mock one.

## Isolation

- **One testbench per worktree (per slot).** The name is `wt-<basename>-<sha1(path)[:8]>[-slot]`. All state lives in `~/.antseed-testbench/<name>/`: `home/`, `anvil-home/`, `buyer/`, `sellers/<id>/`, `config/`, `logs/`, `reports/`, `manifest.json`, `testbench.lock`, `control.json`. Override the root with `ANTSEED_TESTBENCH_HOME` (never inside `~/.antseed`).
- **Locks with PID-reuse protection.** Lock and manifest entries record each process's PID and its `ps` start time. A lock is published atomically (a fully written file hard-linked into place), so a reader never sees a partial one. Reclaiming a stale lock is serialized: a starter that finds one first wins a reclaim mutex named after that stale lock's content (`<lock>.reclaim-<hash>-<level>`, published the same way), removes the stale lock only if it is still exactly what it judged stale, and links its own at once. A live reclaimer is never preempted; a dead one is superseded through the next level. So no fresh lock is ever moved or removed, and two starters can never both own it. The testbench state must therefore live on a filesystem with hard links (APFS, ext4 and the like; not every network, overlay or 9p mount): where `link()` fails with `EPERM`, `ENOTSUP` or `EXDEV`, locking stops with an error saying so, with no fallback. Point `ANTSEED_TESTBENCH_HOME` at a local disk. `up` while running reattaches; a dead or reused PID is treated as stale and cleaned up on the next `up`. That cleanup (and `down --force`) stops the recorded processes, then takes the slot lock itself (reclaiming the stale one the same way) and resets `control.json` and `manifest.json` only as its owner, and only while the manifest is still the generation it judged; a replacement that took the slot first keeps its lock, control token and manifest. A reclaimer that dies mid-reclaim can leave a `<lock>.reclaim-*` file behind. It never blocks anything, because it is keyed by a stale lock text that can never come back. It is deliberately not swept, since a sweep cannot tell it from a live reclaimer's mutex or draft without a race. Delete such files by hand once no testbench is starting.
- **Only owned processes are stopped.** `down` and stale cleanup signal only PIDs from our manifest whose start time still matches.
- **A killed run does not orphan its testbench.** The supervisor runs detached, so a `pnpm testbench run` killed with SIGKILL (an agent's command timeout, for example) used to leave Anvil, the sellers and the supervisor up for good. Now `run` and `up` record themselves as the testbench's starter (`starter` in `plan.json` and `manifest.json`, with the same PID-reuse check as the locks), and `run` sends `POST /heartbeat` every 10 s. Every 15 s a watchdog in the supervisor checks the starter. Once the starter is gone and its last heartbeat is one interval old, the watchdog runs the normal settle-and-close shutdown and writes `stoppedBy: 'watchdog', reason: 'starter-died'` to `manifest.json` and a `Watchdog:` line to the supervisor log. A `run` that finds such a testbench says so, runs `down` and starts fresh. `up` and `run --keep` release the starter when they finish, so their testbench stays up. It then stops after `ANTSEED_TESTBENCH_IDLE_MINUTES` (default 120, 5 to 1440) without a control request, with `reason: 'idle'`. Any control request counts, including `status`, `desktop` and `share` (which send heartbeats while they run), but traffic to the proxy does not. `status` shows the budget and the time since the last control request. A run that reuses a testbench does not become its starter, so killing it leaves the testbench up. `pnpm testbench down` is still the way to stop a testbench.
- **Children follow the supervisor.** The mocks, RPC links, fork RPC relay and bootstrap DHT run inside the supervisor and die with it. Anvil, forge, seller workers and CLI nodes are separate processes. The supervisor registers each one with a small reaper process (`lib/reaper.mjs`) that holds a pipe to it. If the supervisor dies by SIGKILL, the pipe closes and the reaper sends SIGTERM to every child still alive, then SIGKILL after 8 s. Every child, the reaper included, starts from the supervisor's cleaned environment (no fork RPC URL, no live keys; sellers get only their own provider key), and a topology's `buyer.env` reaches only the buyer, never a seller, Anvil or forge. Separately, CLI nodes stop themselves when their parent changes (`lib/isolate-preload.mjs`), and the next `up`'s stale cleanup stops whatever the manifest still lists. `pnpm testbench list` shows `starting` or `stopping` while a supervisor is alive but not ready, and `stopped` only once it has exited.
- **What runs.** Every mode runs the supervisor (private bootstrap DHT, mocks, RPC links, control API) and Anvil. In `sdk` mode it also forks one `seller-worker.mjs` per seller and runs the buyer node and proxy inside itself. In `cli` mode each seller and the buyer are their own `node apps/cli/dist/cli/index.js` process. The manifest records each one as soon as it is spawned (`nodeProcesses`), so `down --force` finds them even after a supervisor crash, and a CLI process stops itself when its supervisor dies.
- **No defaults, no `~/.antseed`, no keychain.** Every testbench process gets a cleaned environment (AntSeed/provider variables, including `ANTSEED_IDENTITY_HEX`, stripped) with `HOME` set to the testbench's `home/`; starting one with your real home or anything inside `~/.antseed` as `HOME` fails. That includes the attach-only desktop, so it cannot read your wallets, tunnel or Telegram settings or plugins. It also uses a mock keychain (macOS) and a basic password store (Linux, Windows), so it never opens your login keychain or keyring. Its wallet is the testbench buyer's key, read from `buyer/`. Node options are checked before use: `dhtPort: 0`, `signalingPort: 0` (unset or 6881/6882 fail fast), `bindHost: 127.0.0.1`, `noOfficialBootstrap`, `natTraversal: false`, `allowPrivateIPs`, and one private loopback bootstrap node. The same check runs on the `config.json` written for each CLI process, which also refuses an unset or default proxy port and a non-local RPC; a CLI node that reports any other bootstrap count stops the testbench. Listeners take port 0 where possible; Anvil and the proxy retry on `EADDRINUSE`.
- **Buyer routing stays inside the testbench.** `allowedPeerIds` is set to this testbench's seller peer IDs and `minTrustScore` is forced to 0 (fresh fork sellers have no trust). Other routing preferences come from the config.
- **Fresh chain per `up`.** Channel, metering and payment databases are cleared on each `up` (they describe a chain that no longer exists); identity keys are kept, so peer IDs and wallet addresses stay stable across runs.

## Config

`--config FILE` points at an existing AntSeed config, such as `~/.antseed/config.json` or a seller config file. Otherwise the testbench uses `ANTSEED_TESTBENCH_CONFIG`, then a gitignored `.antseed-testbench.json` in the worktree, then a built-in single-model OpenAI-compatible seller.

Only these settings are copied; everything else (identity, directories, ports, bootstrap, RPC, contracts, relay, system proxy, verifier) is dropped and set by the testbench, and the dropped keys are printed:

- `seller.providers.<name>`: `plugin`, `baseUrl`, `apiKeyEnv`, `pathRewrite`, `defaults`, `services.<id>` (`upstreamModel`, `categories`, `pricing`, `capabilities`, `unitBillingModels`)
- `buyer.routingPreferences`, `buyer.maxPricing`
- `payments.crypto.chainId` (only `base-mainnet` is supported for now)

Inline secrets (any key that looks like a credential, anywhere in the file) are refused; reference them with `apiKeyEnv`. The source file is only read. A cleaned copy goes to `config/source.cleaned.json`, and its hash is recorded in the manifest and every `report.json`.

### Upstream

- **Mock (default).** Each seller gets its own OpenAI-compatible mock that answers every model in its config: `/v1/models`, chat (JSON and SSE streaming with usage), and `/v1/images/generations` (a fixture PNG). Usage is fixed (10 input + 8 output tokens), so costs are exact. Only OpenAI-compatible plugins (`openai`) can be mocked.
  - `mock.usage: 'load'` sizes usage like real traffic instead (the payment stress mock): prompt tokens from the request size, a random completion within `outTokens` (default 100 to 4000), latency within `latencyRangeMs` (default 50 to 3000 ms), streams chunked over that time.
  - `mock.fault500Rate` and `mock.disconnectRate` (0 to 1) answer that share of tagged requests with an upstream 500 or cut the response midway. `tb.setMockFaults(id, { ... })` changes them during a run.
  - Every mock keeps a **delivery ledger** keyed by the `[req:TAG]` marker in the prompt (untagged requests get `untagged-N`): whether any byte reached the wire, how the response ended (`ok`, `500`, `disconnect`, `client-gone`) and what it cost at the seller's price. That ledger is the independent judge of what the buyer owes (`tb.deliveries(id)`, `tb.assertDeliveredWorkPaid`).
- **Live (`--live`).** Sellers call the real upstream. Every provider needs `apiKeyEnv` (set in your shell or in `--env-file`) and an HTTPS `baseUrl`. Keys reach seller processes through their environment only. Settlement still happens on the fork, so no real funds move.

Live keys come from the shell first, then `--env-file FILE` (default: a gitignored `.antseed-testbench.env` in the worktree). Only names referenced by a provider's `apiKeyEnv` are read from the file; values are never printed, and providers may share one variable. `up` prints which variable and source each provider uses.

```bash
pnpm testbench up --live --config path/to/config.json --env-file ~/.my-keys.env
```

## Scenarios

A scenario is a module in `e2e/testbench/scenarios/<name>.mjs`:

```js
export const meta = {
  description: 'What this proves',
  targets: ['fork', 'local'],   // chains it can run on; the first is the default
  requires: ['mockControl'],    // capabilities: warpTime, sellerControl, buyerControl, buyerFaults (sdk mode only), mockControl, liveUpstream, desktop, sourceContracts (local only)
};

// Plain data. Sellers inherit the config's providers unless they bring their own.
export const topology = {
  mode: 'sdk',                  // optional: sdk (default) or cli, see "Modes"; --mode overrides it
  sellers: [{ id: 'fast', mock: { latencyMs: 20 } }, { id: 'slow', mock: { latencyMs: 400 } }],
  buyer: { depositUsdc: '10', routingPreferences: { preferLowLatency: true } },
  chain: { block: 52223957 },   // optional fork pin; on --chain local, contracts: 'payments' keeps the Deploy.s.sol-only layout
  payments: { settlementIdleMs: 5000, minBudgetPerRequestUsdc: '0.01' },  // optional: seller idle-settle timer (default 600000); seller minimum budget per request (SDK default 0.5; `antseed seller start` uses 0.01)
};

// Free tier (cli mode only: `antseed seller start` reads the programs from its config):
//   seller: { freeTier: { maxRequestsPerAddress: 2, maxRequestsPerIp, windowMs: 3600000, stakeTiers: [{ minPower: 1000, multiplier: 3 }], stakersOnly } }
//   service: providers.<name>.services.<model>.freeTier, the same keys: that service's own program (on a priced service, a free allowance)

// Payment stress shapes (see "Payment stress" below) add, all optional:
//   chain:  { rpc: 'base', blockTimeSec: 2, topUpThresholdBps: 6500 }
//   seller: { mock: { usage: 'load', latencyRangeMs: [50, 3000], outTokens: [100, 4000], fault500Rate: 0.05, disconnectRate: 0.05 } }
//   buyer:  { depositUsdc: '500', maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' }
//   seller or buyer: { env: { ANTSEED_DEBUG: '1' } }   (ANTSEED_* switches for that node; stressTopology() sets this one)

export async function run(tb) {
  const reply = await tb.chat({ model: tb.sellers[0].models[0], sellerId: 'fast' });
  tb.check('fast seller answered', reply.content.length > 0, reply.content);
  tb.metric('latencyMs', reply.latencyMs);
  await tb.closeAll();
  await tb.assertSettlementMatchesSigned();
}
```

The `tb` API:

| Area | Calls |
| --- | --- |
| Client | `catalog()`, `peers()`, `chat({ model, prompt, stream, sellerId })`, `request(path, { method, body, headers, stream })` (any proxy route, such as `/v1/responses`, `/v1/messages`, `/v1/images/generations`, `/v1/models`; returns `{ status, headers, json, text, latencyMs }`, and with `stream` the raw SSE is in `text`) |
| Payments | `channels({ all })`, `signedBySeller()`, `closeAll()`, `closeChannel(id)`, `assertSettlementMatchesSigned(expected?)`, `buyerBalance()` |
| Chain | `contracts` (every address, see [Local contract layouts](#local-contract-layouts)), `chainState()` (block, epoch clock, the buyer's deposit, USDC and ANTS, each seller's USDC, ANTS, eligibility and pool stake, the fee recipient's USDC; amounts as strings), `buyerBalance()`, `usdcBalance(address)`, `mintUsdc(address, micros)` and `usdcTransfer(from, to, micros)` (Anvil impersonation: MockUSDC locally, the master minter on the fork), `epoch()`, `epochClock()` (`{ epoch, startsAt, endsAt, now }` in chain time) and `warpToNextEpoch()` (the emissions gate's clock, legacy emissions' on `payments`), `delegateFreeTier({ from, to, amount, sellerId, epochs, expiresInDays })` (a staker stakes `amount` ANTS in the seller's pool and signs a free-tier delegation to the buyer; returns `{ staker, delegation, code, power }`, the stake counts from the next epoch), `settledEvents(sellerId)` (on-chain `ChannelSettled`), `channelState(channelId)`, `buyerRequestClose(channelId)` / `buyerWithdraw(channelId)` (the buyer's unilateral exit via Anvil impersonation; warp 15 min before withdraw; `buyer-withdraw-and-exit` does it through the CLI) |
| CLI | `cli(args, { dataDir, configPath, home, env, timeoutMs, input, clock })` runs this worktree's `antseed --data-dir <buyer dir> --config <buyer config> ...args` once, isolated like the nodes (private HOME, official bootstrap list emptied, no update check, no debug logs on stdout), and returns `{ code, signal, stdout, stderr, json, durationMs, timedOut }` (`json`: stdout parsed, else `null`; a failing command does not throw). `sellerCli(id, args, options)` runs on a seller's data dir and config. Each call is a `cli` event in `events.jsonl` and the HTML report, with the first 2000 characters of each stream. `clock: 'chain'` shifts the command's clock to the chain's, for commands that compare chain timestamps with `Date.now()` after a `warp()` |
| Control | `stopSeller(id)`, `startSeller(id)`, `stopBuyer()` / `startBuyer()` (buyer node + proxy; sellers see a disconnect), `setMockLatency(id, ms)`, `mockRequests(id)`, `warp(seconds)`, `waitFor(fn, label, { timeoutMs })` |
| Faults (sdk mode) | `faults.loseNeedAuths(count)` (the buyer drops its next `count` seller NeedAuth frames, as if lost), `faults.lostNeedAuths()` (the dropped payloads). Use only to reach a state no public path produces |
| Desktop | `desktop()` → `ui.sendChat(prompt, { expect })`, `ui.openChat()`, `ui.text()`, `ui.screenshot(name)`, `ui.page` (Playwright), `ui.errors`, `ui.close()` |
| Load and oracle | `load({ concurrency, requests, streamRatio, abortRatio, imageRatio, model, imageModel, sellerId, restart: { who, sellerId, atFraction }, gate })`, `checkGate(run)`, `paymentSnapshot()`, `assertDeliveredWorkPaid({ before, results, injected })`, `assertNoCrashes()`, `assertIsolated()`, `setMockFaults(id, { fault500Rate, disconnectRate })`, `deliveries(id)`, `health()`, `gates` |
| Budgets | `budget(name, value, { max, unit = 'ms' })` (a ceiling: records the metric and, with `--budgets`, the check `budget: <name> <= <max> <unit>`), `timings(measured)` (holds measured values to `topology.budgets`), `budgets` (the declared ones). See [Performance budgets and drift](#performance-budgets-and-drift) |
| Reporting | `check(name, ok, detail)`, `knownIssue(name, ok, detail, issue)`, `metric(name, value)`, `event(type, data)`, `mockCostPerChat(sellerId, model)`, `prng(label)` (a seeded random stream) |

Each run writes `reports/<timestamp>-<scenario>/index.html` (a self-contained page with checks, metrics, screenshots, video and events), `report.json` (result, phase, seed, mode, git, Node version, duration, checks, known issues, metrics, config hash, fork block, topology, sellers, buyer), `events.jsonl` and `metrics.json` (the metrics plus each seller mock's delivery ledger under `deliveries`). A run refused before the scenario starts still writes `report.json`.

`result` is `passed`, `failed`, `error`, `timeout` or `blocked`, and the exit code is 0, 1, 4, 3 or 2. Anything but `passed` prints a `rerun:` line with the run's seed. [docs/testing.md](../../docs/testing.md#seeds-and-reruns) defines the classes and what a seed replays. Use `tb.prng(label)` instead of `Math.random` when a scenario needs randomness, so its runs stay replayable.

`knownIssue` records a check for a tracked defect outside the testbench without failing the run; `--strict` makes it fail.

A scenario must leave no money locked: restart every seller it stopped (`tb.startSeller(id)`) or close that seller's channel before it ends. `down` closes channels only with online sellers, and buyer reserve still locked after the close fails `down`, so a passed run ends as `error` in teardown, with a message naming the seller that was offline.

Shipped scenarios:

- `chat-basic`: catalog, a non-streaming and a streaming chat, receipts, then exact on-chain settlement with zero reserves after close.
- `desktop-chat`: launches the built attach-only desktop under Playwright, sends a chat from the UI, checks the testbench reply, the upstream request, the signed channel and exact settlement, and saves screenshots plus `desktop-main.log` in the report.
- `payment-flow`: the CI payment flow and more (default chain: local). Deposit, reserve locked on-chain, three paid chats on one channel with cumulative SpendingAuth, buyer disconnect, seller settles and closes on its own, exact settled amount, fee split and reserve release, buyer reconnects on a fresh channel, cooperative close, exact totals across both channels.
- `mainnet-smoke`: case 3 on the real network (needs `--chain mainnet --real-funds`). Live discovery, one paid desktop chat, spend within the cap, consistent on-chain reserve.
- `routing-smoke`: two sellers with different mock latency; the buyer sees only testbench sellers, pinned and auto-routed chats stay inside the testbench, and per-seller settlement is exact.
- `stress-smoke`, `stress-c32`, `stress-c64`, `stress-smallreserve`, `stress-images`, `stress-faults`, `stress-restart-buyer`, `stress-restart-seller`: the payment stress scenarios on the testbench (see [Payment stress](#payment-stress)).
- `issue-1050-stale-channel`: #1050. The buyer pays, stops, and the seller closes the channel on disconnect. After a restart the buyer must retire the closed channel in its store, `/_antseed/buyer-usage`, `/_antseed/channels` and `antseed buyer status` (all count 0), then pay again on a fresh channel; the payment oracle judges both phases.
- `cli-buyer-commands` (cli mode): after two paid chats, `antseed buyer status`, `balance`, `channels` (and `channels list`), `connection get`, `identity list --balances`, `metering`, `activity` and `emissions info` run next to the running buyer; each transcript must match `/_antseed/channels`, `/_antseed/buyer-usage` and the chain, exit 0 and print no stack trace, and `emissions info` must report the chain's stack and epoch on both sides of `warpToNextEpoch()`. Every one of these commands is safe next to a running CLI buyer: they read the stores and the chain, and the reconciling ones leave the current channel to the buyer whose pid is alive. Records the ignored `--json` of `buyer channels` subcommands as a known issue.
- `buyer-withdraw-and-exit` (cli mode, local): `antseed buyer withdraw` takes the free deposit and cannot take the reserve; the seller stops with the channel open; `antseed buyer channels request-close`, a refused early withdraw, `warp(16 min)`, `antseed buyer channels withdraw` (with `clock: 'chain'`) times the channel out and returns the unsettled reserve. Each step is checked against `buyerBalance()` and `channelState()`, and the money adds up to the original deposit.
- `free-tier` (cli mode, local): a priced service with its own free allowance serves 2 requests free (`x-antseed-free-tier: covered`) and charges the third, settled exactly; a zero-priced service serves 2 requests with no paid channel or reserve, then the seller answers 429 `rate_limit_error` with `retry-after` before the upstream sees the request; `tb.delegateFreeTier` stakes 1000 ANTS for a staker in the seller's pool, `antseed buyer free-tier add <code>` gives the running buyer the delegation, and once the stake is active the staked tier serves the multiplied allowance on the delegated position, then refuses with `limitedBy: 'stake'`.
- `issue-1200-spendingauth-catchup`: #1200. A lost NeedAuth leaves the buyer under-signed, the seller's budget-exhausted 402 asks it to catch up, and the buyer must sign exactly the delivered spend, so settle-on-disconnect charges exactly the delivered work. Fails on a buyer that signs `max(target, signed + minBudgetPerRequest)`.

### Modes

`topology.mode`, or `--mode` on `up` and `run`, picks what runs as a node. The default is `sdk` for every topology.

| Mode | Sellers | Buyer | Use it for |
| --- | --- | --- | --- |
| `sdk` | Forked workers built from `@antseed/node` | Node and proxy inside the supervisor | Quick runs, and scenarios that reach into the buyer |
| `cli` | `antseed seller start --no-dashboard` processes | An `antseed buyer start --no-verifier` process | Anything that should prove the shipped binaries: argument parsing, the config loader, plugin loading, restart, crash and stop behavior |

```bash
pnpm testbench run stress-restart-buyer --chain local --mode cli
pnpm testbench logs buyer
```

A seller that logs `Payments disabled` at startup fails `up` at once: on a priced topology that seller would serve every request for free and the buyer would never open a channel (the oracle caught exactly this; `main` fixed the slow-probe cause in `a962528cb`). In `cli` mode the supervisor writes each node's `config.json` and links the workspace plugins into `home/.antseed/plugins`. A stop is SIGTERM, then SIGKILL after 20 s, and a SIGKILL counts in `forcedStops`. Sellers and the buyer report exits in `unexpectedExits` (`who` is `seller:<id>` or `buyer`). A restarted seller keeps its DHT and signaling ports. Every node logs at `ANTSEED_DEBUG=1`, to `logs/seller-<id>.log` and `logs/buyer.log`. `tb` works the same in both modes, because it drives the buyer through the proxy's HTTP API.

A seller's model health checks, gas checks and gas refuel are off in `cli` mode, as in the stress harness: their requests would land in the mock's ledger. A topology without `payments.minBudgetPerRequestUsdc` gets the CLI default of 0.01 USDC instead of the SDK's 0.5.

The `buyerFaults` capability needs an in-process buyer, so only `sdk` mode has it. `issue-1200-spendingauth-catchup` requires it: `--mode cli` refuses that scenario before anything starts, and `POST /faults/buyer/need-auth-loss` answers `409` on a `cli` testbench. Like `--chain`, `run` takes the running testbench's mode when `--mode` is not given. An explicit `--mode` that differs is refused; run `pnpm testbench down` first or use `--slot`.

### Features without a scenario

`e2e/testbench/features/<area>/<feature>/README.md` is the coverage map: one folder per product feature the testbench does not cover yet, each README saying what to test, what the testbench lacks to drive it, and where the feature lives in the code. There is no code in those folders. `features/README.md` is the index. When a feature gets its scenario, the scenario goes to `scenarios/<name>.mjs` and the folder's README gets a `Scenario:` line. Most gaps are blocked by one of three enablers: a mock upstream that speaks more than chat and image generation, the real `antseed` processes (`mode: 'cli'`), or the full contract stack on `--chain local`.

Mainnet scenarios (`targets: ['mainnet']`) get a smaller `tb`: `check`, `knownIssue`, `metric`, `event`, `waitFor`, `desktop()` (the full profile desktop), `waitForPeers({ min })`, `models()`, `channels({ all })`, `signedSnapshot()`, `spentSince(snapshot)`, `assertWithinCap(snapshot)`, `buyerBalance()` (on-chain deposit) and `capMicros`. There is no chain or seller control on the real network.

## Payment stress

The payment stress harness (`e2e/stress`, run in CI by `node e2e/stress/ci.mjs`) checks that paid traffic under concurrency, Base-like RPC latency, upstream faults and restarts is paid for exactly. Its building blocks are testbench features too, so a stress shape is an ordinary scenario on the testbench network:

| Stress harness | Testbench |
| --- | --- |
| `rpc-proxy.mjs` between each peer and Anvil | `chain.rpc: 'base'`: the supervisor puts that same proxy in front of Anvil per node (buyer and each seller) on one shared chain clock, and Anvil mines every `blockTimeSec` (2 s) after setup. `tb.health().rpc` and the report's `metrics.rpc` count calls, 429s, stale reads and missing receipts |
| `mock-upstream.mjs` (load usage, 500s, disconnects, per-request delivery record) | the testbench mock with `usage: 'load'`, fault rates and its delivery ledger |
| `harness.mjs` load generator | `tb.load(...)` (same tagged requests, stream and abort ratios, image share, mid-load restart) |
| `analysis.mjs` payment invariants | `tb.assertDeliveredWorkPaid(...)` runs `analyzePayments` itself on the testbench's seller and buyer stores, chain and mock ledgers |
| crash patterns, unexpected exits, SIGKILL stops | `tb.assertNoCrashes()` (peer logs since the run started, supervisor health for every peer) |
| isolation guard (no non-loopback IPv4 URL, 1 bootstrap node) | `tb.assertIsolated()`, called by `tb.assertNoCrashes()`, over `logs/seller-*.log`, `logs/buyer.log` and `logs/supervisor.log` |
| `SELLER_PATTERNS`, `BUYER_PATTERNS` log counters | `metrics.logPatterns` (`seller` and `buyer` counts for the run, such as `rejectUnderfunded`, `behindSpendAccepted`, `topUpPermanentFail`), filled by `tb.assertNoCrashes()`. Counts only, no checks |
| `x-antseed-estimated-cost-usd` per request | `costHeader` on each load result, summed as `estimatedCostUsd` in `metrics.load` (null when no response carried it) |
| `ci.mjs` `GATES` | `tb.gates` / `GATES` in `lib/stress.mjs`: `load({ gate })` returns `gateProblems` without failing, `tb.checkGate(run)` records the check after the oracle |
| owner-only chain setup (credit limit, 65% top-up threshold) | `buyer.depositUsdc` above 10 sets the Deposits credit limit override; `chain.topUpThresholdBps` sets the channels threshold (owner impersonated on Anvil, fork or local) |

`lib/stress.mjs` exports `stressTopology()` (the stress network: a 3 / 15 USD per million token seller with a 0.04 USD image model, a 500 USDC deposit, a 1 USDC reserve cap, Base-like RPCs, 65% top-up, 15 s idle settle, the CLI seller's 0.01 USDC minimum budget per request) and `stressRun(tb, { load, faults, gate })` (snapshot, warm-up, faults on, load, faults off, oracle, crash and isolation checks, gate). A failed gate or check does not stop the next one: the report shows every verdict, then the run fails. Scenarios that judge a run themselves use `runAll([...])` from `lib/stress.mjs` for the same effect. A new stress shape is a few lines:

```js
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';
export const meta = { description: '...', targets: ['local', 'fork'], requires: ['mockControl'] };
export const topology = stressTopology({ buyer: { maxReserveUsdc: '0.25' } });
export async function run(tb) {
  await stressRun(tb, { load: { concurrency: 32, requests: 256 }, gate: GATES.default });
}
```

The oracle fails a run on any of: delivered work not settled, settlement above what reached the wire, a response the client received in full that the mock never delivered, per-channel signed or accepted amounts that differ from what settled, a deposit decrease that differs from the sum settled or from seller plus fee income, reserve left locked, a channel left open, and (with no faults, aborts or restarts) seller spend that differs from the delivered cost. It also compares settlement with the seller's own `Cost recorded` log lines. Those are debug lines, so the oracle needs `ANTSEED_DEBUG` on the seller: `stressTopology()` sets it on every node through `env` (sellers and buyer, `ANTSEED_*` switches only), and a run with paid requests and no cost lines fails with `seller cost lines missing (ANTSEED_DEBUG not set?)`. The bootstrap check and most `metrics.logPatterns` counters read debug lines too. It judges only what happened after the `paymentSnapshot()`, so it also works on a testbench kept with `--keep`; it refuses to run while an earlier channel is still open.

```bash
pnpm testbench run stress-smoke --chain local        # quick: 6 requests, about a minute with setup
pnpm testbench run stress-c32 --chain local          # the CI shapes; each takes a few minutes
pnpm testbench run stress-restart-seller --chain local
```

`e2e/stress` still runs in CI unchanged; the testbench imports its `rpc-proxy.mjs` and `analysis.mjs` rather than copying them, so both harnesses share one set of invariants.

### Performance budgets and drift

The stress set also guards speed. Every run records timings in `metrics.json` and the HTML report:

- each load's `clientSummary` in `metrics.load`: `p50Ms`, `p95Ms`, `p99Ms` and `maxMs` over successful requests, split into `streamed` (with `ttfb`, the time to the first body byte) and `nonStreamed`, plus `okPerSecond`;
- `stressRun` lifts them to top-level metrics: `p50Ms`, `p95Ms`, `p99Ms`, `maxMs`, `streamedP95Ms`, `nonStreamedP95Ms`, `ttfbP95Ms`, `okPerSecond` and `loadMs`, and for a restart `restartDownMs`;
- a buyer restart's `settleOnDisconnectMs`: how long until the seller settled the channels the restart dropped. A seller restart leaves the buyer's channel open, so it has none. `payment-flow` records its own;
- `closeAllMs` from `tb.closeAll()`, `chatMs` and `streamChatMs` in `chat-basic`, and `upMs` (from `up` to `READY`, also in `report.json`) when the run started its testbench.

A scenario declares ceilings in `topology.budgets`, for example `stressTopology({ budgets: { p95Ms: 12000, closeAllMs: 16000 } })`. `stressRun` and `payment-flow` hold what they measured to every declared key with `tb.timings(...)`, after the oracle, crash, isolation and gate checks, so a slow run never hides a money verdict. Undeclared keys stay metrics. A declared key nothing measured counts as over budget, so a misspelled budget does not pass unnoticed. Budgets are scenario data: they are left out of the topology fingerprint, so a kept testbench runs scenarios with other budgets.

Budgets are checked only with `pnpm testbench run <scenario> --budgets` (or `ANTSEED_TESTBENCH_BUDGETS=1`). `--strict` does not imply it. Without it, the values are recorded, the HTML report's Budgets table shows them against their budget in grey, and an over-budget value prints `over budget, not enforced: ...`. The shipped numbers are twice what one `--chain local` cli-mode run took on a developer laptop. CI runners and loaded laptops are slower, and the nightly job will set CI numbers.

After every run, `metrics.drift` compares each top-level numeric metric with the latest earlier passed run of the same scenario, mode and chain (`metrics.driftFrom` names it) as `{ previous, current, ratio }`. Nested metrics (per-load summaries, log counters) stay out because they vary with the seed. A metric that moved past x1.5 or under x0.67 prints a line:

```text
[testbench] DRIFT p95Ms 1200 -> 2400 (x2.0)
```

Nothing fails on drift. It tells whoever reads the run what changed since last time. Mock latencies are drawn from the seed, so compare runs of one `--seed` when a drift line matters.

## Desktop automation

`tb.desktop()` launches the built desktop (`apps/desktop/dist`) under Playwright's Electron driver in attach-only mode on this testbench's buyer. Chats, sessions and projects go to `buyer/desktop/` and Electron data to `desktop-automation/` inside the testbench; telemetry is off; nothing reads or writes `~/.antseed`. Rebuild after desktop changes (`pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`). The window is visible while it runs, and it closes automatically when the scenario ends.

Every desktop run records `video/desktop.webm` and keeps screenshots in `screenshots/`; a chat that times out also saves `chat-timeout.png` and puts the visible screen text in the error. `run --trace` additionally records a Playwright trace (`trace.zip`, 100+ MB) for `npx playwright show-trace`. Each launch starts from an empty desktop state (`desktop-automation/` is reset).

To inspect results from a remote machine, run `pnpm testbench report --serve --port 8799` there and `ssh -L 8799:127.0.0.1:8799 <host>` locally, then open `http://127.0.0.1:8799/`. The server is read-only, serves only report file types inside `reports/`, supports video seeking, and binds to `127.0.0.1` unless `--host` says otherwise.

## Share (Linux server)

`pnpm testbench share` runs the testbench desktop on a Linux server and streams it to your browser on your tailnet. You click a link and use the real app (mouse, keyboard, chat, payments on the testbench chain) while everything runs on the server. Desktop browsers only.

```bash
# on the server, in the worktree
pnpm testbench share                   # starts the testbench if needed, prints https://<host>.<tailnet>.ts.net/<testbench-name>/
pnpm testbench share --stop            # or pnpm testbench down, which also stops the share
```

The link opens a landing page with the branch, chain, desktop status, a button to open the desktop, and links to the run reports. It does the following:

- Starts a virtual display (Xvfb, 1440x900), openbox if installed, and x11vnc on a unix socket inside the testbench directory.
- Runs the attach-only desktop on the testbench buyer, with state in `desktop-share/`. `--fresh` resets that state first.
- Serves noVNC, the landing page and `reports/` on a loopback port.
- Publishes it with `tailscale serve --https=443 --set-path=/<testbench-name>`, so each worktree gets its own path on the same host.
- Stops after `--idle` minutes without a viewer (default 120, range 5-1440), when the testbench stops, or on `share --stop`. Stopping removes the `tailscale serve` path.

Server setup (once):

```bash
sudo apt-get install -y xvfb x11vnc novnc openbox
sudo apt-get install -y libgtk-3-0 libnss3 libasound2 libgbm1 libxss1   # Electron runtime libraries
sudo tailscale set --operator=$USER          # lets share run tailscale serve without sudo
pnpm install && pnpm run build               # share needs apps/desktop/dist
```

Enable MagicDNS and HTTPS certificates for the tailnet in the Tailscale admin console. If noVNC is not under `/usr/share/novnc`, set `ANTSEED_TESTBENCH_NOVNC_DIR` to the directory that contains `vnc.html`.

Security:

- Only tailnet members can reach the link: the server listens on `127.0.0.1` and Tailscale proxies to it.
- `share` refuses to run while Tailscale Funnel is on for port 443, because Funnel would put the desktop on the public internet.
- The VNC socket is never exposed. The WebSocket bridge rejects cross-origin pages.
- The desktop runs on the testbench wallet and testbench chain only (mock upstream unless the testbench was started with `--live`).

Without Tailscale, use `--no-tailscale`, then `ssh -L PORT:127.0.0.1:PORT <server>` and open `http://127.0.0.1:PORT/`.

For agents: with `ANTSEED_TESTBENCH_SHARE_DEBUG_PORT=N`, the shared desktop listens for Chrome DevTools Protocol on `127.0.0.1:N`. An agent can then read the DOM over CDP to check what a viewer sees through noVNC. Logs: `logs/share.log`, `share-desktop.log`, `share-vnc.log`, `share-xvfb.log`, `share-wm.log`.

## Control API

The supervisor exposes a loopback-only API with a bearer token stored in `control.json` (mode 0600). Scenarios use it through `tb`; you rarely need it directly.

`GET /status`, `GET /health`, `POST /channels/close {sellerId?}`, `POST /chain/warp {seconds}`, `POST /buyer/stop`, `POST /buyer/start`, `POST /sellers/:id/stop`, `POST /sellers/:id/start`, `GET|POST /sellers/:id/mock {latencyMs?, fault500Rate?, disconnectRate?}`, `GET /sellers/:id/deliveries`, `GET|POST /faults/buyer/need-auth-loss {count}`, `POST /shutdown`

## Fork cache

Applies to `--chain fork` only. Anvil's RPC cache makes a warm `up` take a few seconds instead of a minute.

- The shared cache lives in `~/.antseed-testbench/.cache/anvil` (override with `ANTSEED_TESTBENCH_CACHE_DIR`). It is seeded once from the older `~/.antseed-e2e/anvil-home` cache, which is only ever read.
- Each testbench copies the warm block into its own `anvil-home/`; Anvil never writes the shared cache.
- On exit the testbench's copy is published back under `cache.lock` with a temp file and an atomic rename, and only if it is larger than the shared copy.
- Pruning keeps the newest 3 blocks and never removes a block pinned by a running testbench.
- Without `--block`, the newest warm block younger than 72 hours is reused; otherwise the fork pins a block just behind head.

## Tests

```bash
pnpm test:testbench       # fast unit tests (node --test): options, config, naming, locks, manifest, ports, cache, mock, control, stress load, gates and ledger
pnpm test:testbench:e2e   # full flow on a real fork: up, reattach, status, run chat-basic, down, isolation checks
pnpm testbench run payment-flow --chain local   # payment lifecycle on source-deployed contracts, no RPC key
```

The e2e flow checks:

- no testbench port collides with an existing listener or a default port
- `up` reattaches instead of restarting
- every port is closed after `down`
- no testbench process ever holds a file under `~/.antseed`
- `~/.antseed/identity.key` and `config.json` are unchanged
- nothing else under `~/.antseed` changed either: any change fails the flow and lists the processes holding files there. On a machine where a real node or verifier writes `~/.antseed` during the run, set `ANTSEED_TESTBENCH_E2E_ALLOW_HOME_WRITES=1` to turn that change into a note (`identity.key` and `config.json` changing still fails)
- foreign Anvil processes survive

Pass scenario names to run more than `chat-basic` (`node e2e/testbench/test/e2e-flow.mjs chat-basic routing-smoke`).

## Roadmap

Deferred (not needed for the four cases):

- a pool of test wallets with rotation and automatic top-ups for case 3
- a canary seller of ours on mainnet, so case 3 can also test seller changes against real buyers
- multiple sellers from different configs in one testbench
- a CI job: the e2e scenarios plus `stress-smoke` on every PR, the full stress set nightly with repeats; then retire `e2e/stress`'s own chain, mock, bootstrap and config writers once the testbench scenarios match its results
- a `--runs N` repeat mode for stress scenarios (the stress harness's `--runs`)
- fail points in `packages/node` at payment boundaries (before a settle is sent, after a NeedAuth arrives, before a close), generalizing `faults.loseNeedAuths`
- retiring `e2e/scripts/full-payment-flow.mjs` once local runs prove stable in CI
- streaming the real-funds profile desktop with `share`
- Anvil state snapshots, a Herdr tab launcher, rebasing the video harness onto this
