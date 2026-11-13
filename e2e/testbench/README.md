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
- Foundry's `anvil` on `PATH` (plus `forge` and `packages/contracts/lib/forge-std` for `--chain local`: `cd packages/contracts && forge install foundry-rs/forge-std --no-git`; the first `forge build` takes several minutes, later runs reuse `out/`). Verified with Foundry 1.3.5 and 1.9.0; CI pins v1.9.0. Transactions Anvil signs for the testbench (impersonated owners and funding accounts) state zero fees explicitly through `AnvilSigner` in `lib/chain.mjs`, because Anvil 1.9 rejects its own fee fill on the zero-fee testbench chain
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

`pnpm testbench desktop` is the interactive loop. Renderer edits show up immediately; main-process edits recompile on save and load when you quit and rerun the command. It runs next to your normal desktop with its own ports and data: `HOME` is the testbench's `home/`, and Electron's data lives in `$TMPDIR/antseed-desktop/<instance>/` (the dev launcher's location), not in the testbench directory.

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
pnpm testbench up [--chain fork|local] [--mode sdk|cli] [--config FILE] [--live] [--deposit-usdc N] [--block N] [--scenario NAME] [--timeout SECONDS]
pnpm testbench status [--json] [--env]   # ports, wallets, balances, peers, URLs, env exports
pnpm testbench run <scenario> [--chain fork|local|mainnet] [--mode sdk|cli] [--contracts full|payments] [--seed N] [--timeout SECONDS] [--run-timeout SECONDS] [--keep] [--strict] [--trace] [--real-funds]
pnpm testbench desktop                  # attach-only desktop (dev mode) on the testbench buyer
pnpm testbench:attach                   # start/reuse routing-smoke, then open the attached desktop
pnpm testbench mainnet --real-funds [--dev] [--fresh]   # full desktop on the real network (case 3)
pnpm testbench logs [supervisor|anvil|seller-<id>|buyer] [--follow]   # buyer: cli mode only
pnpm testbench down [--force]           # settle + close channels while Anvil is alive, then stop; exits 1 if the shutdown reported errors or left reserve locked, also when that shutdown already finished (watchdog, earlier down). On a testbench that is still starting: see "A start cannot hang" under Isolation
pnpm testbench list                     # every testbench on this machine
pnpm testbench scenarios [--json]       # every scenario with its targets and description
pnpm testbench report [run] [--open]    # latest (or named) run: index.html, video, trace paths
pnpm testbench report --serve [--port N] [--host H]   # serve reports/ over HTTP (loopback by default)
pnpm testbench share [--idle MIN] [--fresh] [--no-tailscale] [--stop]   # Linux server: desktop in your browser over Tailscale
pnpm testbench:sweep <scenario> --seeds 1-5 [run flags]   # seed search: one fresh testbench per seed, failures with their rerun lines
```

`--slot NAME` on any command runs an additional testbench for the same worktree (for example two scenarios with different topologies side by side).

### Testing against another version

`--seller-tree DIR` and `--buyer-tree DIR` (`up` and `run`, cli mode only) run that side from another built checkout of this repo: its `antseed` CLI, `packages/node` and plugins. The default for each side is this worktree. The testbench's own code, mocks, chain setup and payment oracle keep running from this worktree, so the contracts and the oracle are this branch's.

```bash
git worktree add ../antseed-main-tree origin/main
(cd ../antseed-main-tree && pnpm install && pnpm run build)
pnpm testbench run payment-flow --chain local --mode cli --seller-tree ../antseed-main-tree   # main's seller, this branch's buyer
pnpm testbench run chat-basic --chain local --mode cli --buyer-tree ../antseed-main-tree      # main's buyer, this branch's seller
git worktree remove ../antseed-main-tree
```

Use it for scenarios that exercise the two sides talking: the `stress-*` set, `payment-flow`, `chat-basic`, `routing-smoke` and `issue-*`. A tree must be the root of a built checkout, never inside `~/.antseed`. A build from another tree may ignore the testbench's `network` config, so its sellers get free ports through `--dht-port` and `--signaling-port`, and the CLI preload forces its sockets onto loopback and turns off its UPnP/NAT-PMP mapping. A run started with other trees is not reused by a command without them: `pnpm testbench down` first, or use `--slot`. The manifest, `report.json`, the run header and the HTML report record each tree's path and `git rev-parse HEAD`, and an earlier run only counts as the drift baseline when it used the same other trees.

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

Every script broadcasts with `forge script --slow`: forge sends a transaction only once the previous one has its receipt. In one burst (forge's default), Anvil 1.3.5 can park a transaction for good. It reads the sender's nonce when the transaction arrives; if the block with the previous nonce is mined and pruned from the pool before the new transaction is added, that transaction waits for a predecessor that no longer exists. Every later nonce queues behind it, automine has nothing ready (`txpool_status` shows `pending: 0` with the rest `queued`, and `evm_mine` mines an empty block), and forge polls for receipts forever. A transaction sent after its predecessor's receipt names no predecessor, so it cannot park. Measured on this repo's Mac with Foundry 1.3.5 (2026-11-09): of the burst deploys of `Deploy.s.sol`, 2 of 60 stalled this way under load, and 13 of 100 with Anvil and forge held to the efficiency cores (`taskpolicy -b`); with `--slow`, 0 of 60 and 0 of 100, and a warm `up` takes as long as before. Anvil 1.9.0 holds its mining lock across the nonce read and the insert (`add_pending_transaction` in `crates/anvil/src/eth/api.rs`), which closes that window: the same confined burst loop stalled 0 of 60 times on 1.9.0.

While a script broadcasts, the supervisor also looks at Anvil's pool once a second. Transactions parked with none ready on three looks in a row mean nothing will be mined any more, whatever the cause: the supervisor stops forge and fails the start with `Deploy.s.sol stalled: Anvil stopped mining with 20 transactions parked in its pool (deployer nonce 4, block 4)`.

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
- **A start cannot hang.** Start-up has a time limit: `--timeout SECONDS` on `up` and `run`, default 600. A supervisor that is not ready by then fails the start itself and names the step it was in (`Start-up did not finish within 600 s (it was deploying the contracts: Deploy.s.sol)`). While it starts it also checks every 5 s that the `run` or `up` that started it is still there, and stops the start when it is gone; SIGTERM stops a start too. Each of these ends like any other failed start. The supervisor stops forge (with the solc processes a compile is running), Anvil and whatever else it had started, writes the reason to `startError` in `manifest.json` (with `stoppedBy: 'watchdog'` and `reason: 'start-timeout'` or `'starter-died'` for the first two) and a `FAILED:` line to the supervisor log, and releases the lock. `up` returns the error once that supervisor has exited, and a `run` ends as `blocked` (exit 2). The next `run`, `up` or `down` then needs no `--force`. `down` on a testbench that is still starting stops it when the command that started it is gone (nothing ran on it, so nothing is settled), waits when a failed start is already shutting down, and refuses while the starter is alive, or while the supervisor has not recorded yet who started it: wait for that command, or stop it. `pnpm testbench list` shows such a testbench as `starting`, and a failed start that is still shutting down as `stopping`. A `run` or `up` that finds such a leftover start stops it the same way and starts fresh. Should the shutdown after a failed start hang too, the supervisor exits 90 s into it; its reaper stops the children and the next `up` or `down` clears the stale lock.
- **An attached desktop is stopped by `down`.** `pnpm testbench desktop` starts the desktop as its own process group and records the leader (pid and start time) under `desktops/`, because its launcher can die first. `down` and the stale cleanup stop each member of the group that has the testbench `HOME` and the attach-only flag, with the same ownership check as every other child; anything left running makes `down` say so and exit 1.
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

- **Mock (default).** Each seller gets its own OpenAI-compatible mock that answers every model in its config: `/v1/models`, chat (JSON and SSE streaming), and `/v1/images/generations` (a fixture PNG). A stream ends with a usage chunk only when the request sets `stream_options.include_usage: true`, as the OpenAI API does. Usage is fixed (10 input + 8 output tokens), so costs are exact. Only OpenAI-compatible plugins (`openai`) can be mocked.
  - `mock.usage: 'load'` sizes usage like real traffic instead (the payment stress mock): prompt tokens from the request size, a random completion within `outTokens` (default 100 to 4000), latency within `latencyRangeMs` (default 50 to 3000 ms), streams chunked over that time.
  - `mock.fault500Rate` and `mock.disconnectRate` (0 to 1) answer that share of tagged requests with an upstream 500 or cut the response midway. `mock.slowRate` makes that share take `mock.slowMs` (up to 60000) instead of their drawn latency: an upstream slower than the buyer waits. `tb.setMockFaults(id, { ... })` changes them during a run.
  - `[no-usage]` in a prompt (`NO_USAGE_MARKER`) makes that answer carry no usage, streamed or not, like an upstream that never reports it. `tb.mockRequests(id)` records what each request asked for as `includeUsage` (`true`, `false`, or `null` when the option is not set).
  - Every mock keeps a **delivery ledger** keyed by the `[req:TAG]` marker in the prompt (untagged requests get `untagged-N`): whether any byte reached the wire, how the response ended (`ok`, `500`, `disconnect`, `client-gone`) and what it cost at the seller's price. That ledger is the independent judge of what the buyer owes (`tb.deliveries(id)`, `tb.assertDeliveredWorkPaid`).
- **Live (`--live`).** Sellers call the real upstream. Every provider needs `apiKeyEnv` (set in your shell or in `--env-file`) and an HTTPS `baseUrl`. Keys reach seller processes through their environment only. Settlement still happens on the fork, so no real funds move.

Live keys come from the shell first, then `--env-file FILE` (default: a gitignored `.antseed-testbench.env` in the worktree). Only names referenced by a provider's `apiKeyEnv` are read from the file; values are never printed, and providers may share one variable. `up` prints which variable and source each provider uses.

```bash
pnpm testbench up --live --config path/to/config.json --env-file ~/.my-keys.env
```

## Scenarios

A scenario is a module in `e2e/testbench/scenarios/`. Feature tests live in `scenarios/features/`, stress shapes in `scenarios/stress/`, issue regressions in `scenarios/issues/`, and the real-funds run in `scenarios/mainnet/`. A scenario is always run by its bare name (`pnpm testbench run stress-smoke`), so names are unique across folders, and `pnpm testbench scenarios` lists them by group:

```js
export const meta = {
  description: 'What this proves',
  targets: ['fork', 'local'],   // chains it can run on; the first is the default
  requires: ['mockControl'],    // capabilities: warpTime, sellerControl, buyerControl, buyerFaults (sdk mode only), failpoints (cli mode only), mockControl, liveUpstream, desktop, sourceContracts (local only)
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
//   seller: { mock: { usage: 'load', latencyRangeMs: [50, 3000], outTokens: [100, 4000], fault500Rate: 0.05, disconnectRate: 0.05, slowRate: 0.08, slowMs: 40000 } }
//   buyer:  { depositUsdc: '500', maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15', requestTimeoutMs: 20000 }   (requestTimeoutMs: cli mode only)
//   seller or buyer: { env: { ANTSEED_DEBUG: '1' } }   (ANTSEED_* switches for that node; stressTopology() sets this one)
//   failpoints: true   (cli mode only: every node gets the fail point handler, see "Fail points")

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
| Control | `stopSeller(id)` (graceful: the seller settles and closes its channels), `crashSeller(id)` (SIGKILL: it leaves them open and unsettled, like a seller that loses power), `startSeller(id)`, `stopBuyer()` / `startBuyer()` (buyer node + proxy; sellers see a disconnect), `setMockLatency(id, ms)`, `mockRequests(id)`, `warp(seconds)`, `setBlockTime(seconds)` (Anvil mines every 1 to 30 s from now on), `waitFor(fn, label, { timeoutMs })`, `waitForPaidChannels(sellerId, { requests, signed })` (the seller's open channels once the buyer has stored the SpendingAuths for the answered requests; the proxy answers before that) |
| Faults (sdk mode) | `faults.loseNeedAuths(count)` (the buyer drops its next `count` seller NeedAuth frames, as if lost), `faults.lostNeedAuths()` (the dropped payloads). Use only to reach a state no public path produces |
| Fail points (cli mode, `failpoints: true`) | `faults.failpoints(who, spec)` (arms a running node and returns the armed spec with its `id`: `who` is `'buyer'` or `'seller:<id>'`, `spec` is `{ seed, points: { '<name>': rule \| [rule, ...] }, maxCrashes, graceMs, restartDelayMs, ignoreOthers }` with a rule `{ action: 'crash' \| 'error' \| 'delay', ms, nth, p, count, whenDown, keyed, group, killAfterMs, killWhenDown }`), `faults.clearFailpoints(who)`, `faults.failpointJournal(who)` (what the node reached and what fired), `faults.waitForFailpointRestart(who, { specId, timeoutMs })` (the supervisor's record of that arming's latest crash once the killed node is back up), `faults.failpointCrashes({ specIds, who })` and `faults.waitForFailpointRestarts({ specIds, who, timeoutMs })` (every crash record of those armings, at once or once all of them were followed by a restart), `withFailpointRestart(run, crash)` (judges a load against a crash, or a list of crashes, that came after it), `cli(args, { failpoints: spec })` (a one-shot command with the handler armed; the result's `failpoint.crash` says whether a fail point killed it), `seed` (the run seed a scenario's `failpointPlan(seed)` takes). See [Fail points](#fail-points) |
| Desktop | `desktop()` → `ui.sendChat(prompt, { expect })`, `ui.openChat()`, `ui.text()`, `ui.screenshot(name)`, `ui.page` (Playwright), `ui.errors`, `ui.close()` |
| Load and oracle | `load({ concurrency, requests, streamRatio, abortRatio, imageRatio, omitMaxTokensRatio, model, imageModel, sellerId, restart: { who, sellerId, atFraction, crash } \| { who: 'seller', sellerId, on: 'top-up', settleMs }, failpointCrash: { who, specIds }, gate })` (`crash` kills the seller with SIGKILL instead of stopping it; `omitMaxTokensRatio` sends that share of chats without `max_tokens`; `failpointCrash` makes the load wait while a node killed by a fail point is down, for every crash of `who` (a node or a list), and returns them as `restarts`, the first also as `restart`), `checkGate(run)`, `paymentSnapshot()`, `assertDeliveredWorkPaid({ before, results, injected })`, `assertNoCrashes()`, `assertIsolated()`, `setMockFaults(id, { fault500Rate, disconnectRate, slowRate, slowMs })`, `deliveries(id)`, `health()`, `gates` |
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
- `stress-smoke`, `stress-seq`, `stress-c8`, `stress-c32`, `stress-c64`, `stress-smallreserve`, `stress-images`, `stress-faults`, `stress-restart-buyer`, `stress-restart-seller`, `stress-restart-seller-topup`: the payment stress scenarios on the testbench (see [Payment stress](#payment-stress)).
- `stress-crash-seller`, `stress-smallreserve-faults`, `stress-slow-topups`, `stress-buyer-timeout`, `stress-chaos`: the fault shapes (see [Fault shapes](#fault-shapes)).
- `stress-failpoint-crash`, `stress-failpoint-close` (cli mode): a node killed at a drawn fail point in the payment path (see [Fail points](#fail-points)).
- `stress-crashes-and-delays`, `stress-crashes-and-delays-both` (cli mode): every fail point a load reaches armed at once on the seller, or on the seller and the buyer, with seeded crashes and delays and no cap on the crashes, then the settle and close points through the close (see [Crashes and delays](#crashes-and-delays)).
- `stress-crashes-correlated` (cli mode): the buyer and the seller down together on purpose (see [Crashes and delays](#crashes-and-delays)).
- `stress-failpoint-exit` (cli mode, local): the buyer's `request-close` and `withdraw` commands each killed at a drawn fail point and run again (see [The buyer's exit](#the-buyers-exit)).
- `issue-1050-stale-channel`: #1050. The buyer pays, stops, and the seller closes the channel on disconnect. After a restart the buyer must retire the closed channel in its store, `/_antseed/buyer-usage`, `/_antseed/channels` and `antseed buyer status` (all count 0), then pay again on a fresh channel; the payment oracle judges both phases.
- `cli-buyer-commands` (cli mode): after two paid chats, `antseed buyer status`, `balance`, `channels` (and `channels list`), `connection get`, `identity list --balances`, `metering`, `activity` and `emissions info` run next to the running buyer; each transcript must match `/_antseed/channels`, `/_antseed/buyer-usage` and the chain, exit 0 and print no stack trace, and `emissions info` must report the chain's stack and epoch on both sides of `warpToNextEpoch()`. Every one of these commands is safe next to a running CLI buyer: they read the stores and the chain, and the reconciling ones leave the current channel to the buyer whose pid is alive. Records the ignored `--json` of `buyer channels` subcommands as a known issue.
- `buyer-withdraw-and-exit` (cli mode, local): `antseed buyer withdraw` takes the free deposit and cannot take the reserve; the seller crashes with the channel open; `antseed buyer channels request-close`, a refused early withdraw, `warp(16 min)`, `antseed buyer channels withdraw` (with `clock: 'chain'`) times the channel out and returns the unsettled reserve. Each step is checked against `buyerBalance()` and `channelState()`, and the money adds up to the original deposit.
- `free-tier` (cli mode, local): a priced service with its own free allowance serves 2 requests free (`x-antseed-free-tier: covered`) and charges the third, settled exactly; a zero-priced service serves 2 requests with no paid channel or reserve, then the seller answers 429 `rate_limit_error` with `retry-after` before the upstream sees the request; `tb.delegateFreeTier` stakes 1000 ANTS for a staker in the seller's pool, `antseed buyer free-tier add <code>` gives the running buyer the delegation, and once the stake is active the staked tier serves the multiplied allowance on the delegated position, then refuses with `limitedBy: 'stake'`.
- `issue-streamed-chat-billed`: a streamed chat is paid for what it delivered, whatever the request says about usage. A request that sets `stream_options.include_usage: false` pays the exact cost and still gets the closing usage chunk, a path with a dot segment is answered `400 invalid_request_path` before the upstream sees it, and an answer from an upstream that never reports usage (`[no-usage]` in the prompt) is paid the estimate of its prompt and its text. Settlement equals what was signed.
- `issue-1200-spendingauth-catchup`: #1200. A lost NeedAuth leaves the buyer under-signed, the seller's budget-exhausted 402 asks it to catch up (both of the seller's catch-up NeedAuths are lost too, so only the buyer's 402 negotiator can sign), and the buyer must sign exactly the delivered spend, so settle-on-disconnect charges exactly the delivered work. Fails on a buyer that signs `max(target, signed + minBudgetPerRequest)`.

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

A seller that logs `Payments disabled` at startup fails `up` at once: on a priced topology that seller would serve every request for free and the buyer would never open a channel (the oracle caught exactly this; `main` fixed the slow-probe cause in `a962528cb`). In `cli` mode the supervisor writes each node's `config.json` and links the workspace plugins into `home/.antseed/plugins`. A stop is SIGTERM, then SIGKILL after 20 s, and a SIGKILL counts in `forcedStops`. Sellers and the buyer report exits in `unexpectedExits` (`who` is `seller:<id>` or `buyer`); a node killed by a fail point is in `failpointCrashes` instead. A restarted seller keeps its DHT and signaling ports. Every node logs at `ANTSEED_DEBUG=1`, to `logs/seller-<id>.log` and `logs/buyer.log`. `tb` works the same in both modes, because it drives the buyer through the proxy's HTTP API.

A seller's model health checks, gas checks and gas refuel are off in `cli` mode, as in the stress harness: their requests would land in the mock's ledger. A topology without `payments.minBudgetPerRequestUsdc` gets the CLI default of 0.01 USDC instead of the SDK's 0.5.

The `buyerFaults` capability needs an in-process buyer, so only `sdk` mode has it. `issue-1200-spendingauth-catchup` requires it: `--mode cli` refuses that scenario before anything starts, and `POST /faults/buyer/need-auth-loss` answers `409` on a `cli` testbench. The `failpoints` capability is the other way round: the handler is preloaded into a node's own process, so only `cli` mode has it, `--mode sdk` refuses a scenario that requires it, and `/failpoints/:who` answers `409` on an `sdk` testbench. Like `--chain`, `run` takes the running testbench's mode when `--mode` is not given. An explicit `--mode` that differs is refused; run `pnpm testbench down` first or use `--slot`.

Mainnet scenarios (`targets: ['mainnet']`) get a smaller `tb`: `check`, `knownIssue`, `metric`, `event`, `waitFor`, `desktop()` (the full profile desktop), `waitForPeers({ min })`, `models()`, `channels({ all })`, `signedSnapshot()`, `spentSince(snapshot)`, `assertWithinCap(snapshot)`, `buyerBalance()` (on-chain deposit) and `capMicros`. There is no chain or seller control on the real network.

## Payment stress

The payment stress harness (`e2e/stress`, run in CI by `node e2e/stress/ci.mjs`) checks that paid traffic under concurrency, Base-like RPC latency, upstream faults and restarts is paid for exactly. Its building blocks are testbench features too, so a stress shape is an ordinary scenario on the testbench network:

| Stress harness | Testbench |
| --- | --- |
| `rpc-proxy.mjs` between each peer and Anvil | `chain.rpc: 'base'`: the supervisor puts that same proxy in front of Anvil per node (buyer and each seller) on one shared chain clock, and Anvil mines every `blockTimeSec` (2 s) after setup. `tb.health().rpc` and the report's `metrics.rpc` count calls, 429s, stale reads and missing receipts |
| `mock-upstream.mjs` (load usage, 500s, disconnects, per-request delivery record) | the testbench mock with `usage: 'load'`, fault rates and its delivery ledger |
| `harness.mjs` load generator | `tb.load(...)` (same tagged requests, stream and abort ratios, image share, mid-load restart) |
| `rpc-proxy.mjs` `holdTopUp()` (`restart: { who: 'seller', on: 'top-up' }`) | `tb.load({ restart: { who: 'seller', on: 'top-up', settleMs } })`: the seller's RPC link holds its first `topUp()` transaction, the seller restarts `settleMs` later and the held transaction is dropped unsent (`GET`/`POST /sellers/:id/top-up-hold` on the control API; needs `chain.rpc: 'base'`). A load during which no `topUp()` was held fails a check |
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
pnpm testbench run stress-restart-seller-topup --chain local  # a seller restart with a top-up verified but not yet sent
```

`e2e/stress` still runs in CI unchanged; the testbench imports its `rpc-proxy.mjs` and `analysis.mjs` rather than copying them, so both harnesses share one set of invariants.

### Fault shapes

These shapes inject a general fault and let the same oracle judge the money, instead of testing one feature each. They are meant to run across seeds (`pnpm testbench:sweep`).

| Scenario | What it injects | Proof that it fired |
| --- | --- | --- |
| `stress-crash-seller` | the seller is killed (SIGKILL) 40% of the way through a 32-way load and started again: no settle, no close, channels left open | the load's restart record says the supervisor killed a running seller |
| `stress-smallreserve-faults` | a 0.25 USDC reserve and 0.15 USDC per-request cap, with upstream 500s, mid-response disconnects, client aborts, and 40% of chats without `max_tokens` | the mock ledger's 500 and disconnect counts, the client's abort and no-`max_tokens` counts, and at least one top-up in the seller log |
| `stress-slow-topups` | the same small reserve on 12 s blocks at 64-way load, so spend outruns each top-up and the next one is still mining when the seller reaches the ceiling | at least two top-ups, and the seller at the ceiling with a top-up mining (`stillAtCeiling`, `topUpPendingAtBudget` or a client `503 top_up_pending`) |
| `stress-buyer-timeout` (cli mode) | a 20 s buyer request timeout and an upstream that takes 40 s for 8% of requests; a fault-free follow-up load then checks that later requests go through | the mock ledger's slow count and the buyer's `requestTimedOut` log counter |
| `stress-chaos` | one plan per seed, drawn from `tb.prng('chaos')` (`lib/chaos.mjs`): any of the faults above, at drawn rates, plus a seller restart, seller crash or buyer restart at a drawn point | every fault in the plan, checked as above; the plan is `metrics.chaosPlan`, a `chaos-plan` event and a `[chaos] plan:` line |
| `stress-failpoint-crash` (cli mode) | one node (seller or buyer) killed at one fail point the payment path reaches under load, at a drawn hit, during a 16-way load of 160 requests; the supervisor starts it again | the node's fail point journal holds the crash trigger, and the load's restart record names that point |
| `stress-failpoint-close` (cli mode) | the seller killed at a fail point only settling or closing reaches (around the settle or close transaction, or a store write of the close), after a small load | the same, from the journal and the supervisor's crash record |
| `stress-crashes-and-delays` (cli mode) | every fail point the seller reaches under load armed at once, each with a seeded chance to kill it, no cap on the crashes (a drawn time down, then a drawn grace window in which nothing is killed), and delays at the points that can wait, during a 16-way load of 480 requests; then the settle, close and store points stay armed through the idle settle and the close | at least one crash of this run's armings in the supervisor's records and the journal, and a restart after every one |
| `stress-crashes-and-delays-both` (cli mode) | the same on the seller and the buyer, each with its own plan and one shared crash state: one node down at a time | the same, over both nodes |
| `stress-crashes-correlated` (cli mode) | the buyer and the seller killed at the same SpendingAuth (one seed, a keyed crash on both: the seller after verifying it, the buyer, which marked it when it sent it, as soon as the seller is down); both restarted | one crash per node in the records with the same key, one of them marked `overlapped`, and overlapping down windows |
| `stress-failpoint-exit` (cli mode, local) | with the seller killed and left down, `antseed buyer channels request-close` and, after the grace, `antseed buyer channels withdraw` are each killed at one drawn point of their transaction and run again | each command died of SIGKILL with the trigger in its own journal |

Rules these follow, and a new fault shape must too:

- **A fault must be seen firing.** `stressRun` records a `fault path ran: ...` check for everything the run injected (`injectedEvidence` in `lib/stress.mjs`: mock fault rates, aborts, chats without `max_tokens`, a restart or crash), and a scenario adds its own through `evidence`. A run whose fault never fired fails, so a scenario cannot pass without reaching its path.
- **The oracle judges the money.** With any fault the oracle checks bounds, as before: served work accepted and settled, settlement at least what clients received in full and at most what reached the wire.
- **Gates compose.** `composeGate([...])` takes the lowest floor and the failure kinds its parts allow. A gate with both a restart and allowed kinds lets anything fail inside the restart window and only those kinds outside it.

The buyer's `requestTimeoutMs` bounds a non-streamed request. A streamed one waits at least 90 s for its first byte and 60 s between chunks (`packages/buyer-core/src/buyer-request-handler.ts`), longer than a mock may hold a response, so a slow streamed request is only slow. Only `antseed buyer start` reads the setting, so a topology with `buyer.requestTimeoutMs` needs cli mode.

### Fail points

A fail point is a named place in the payment code between two steps that must both happen for the books to stay consistent: right before or after a durable write or a send. A crash, an error or a delay exactly there is the case a test from outside cannot aim at. The points are declared in `packages/buyer-core/src/failpoints.ts` (`FAILPOINTS`, one line each naming the two steps):

| Points | Where |
| --- | --- |
| `store.before-write`, `store.after-write` | every write of the sqlite channel store (seller and buyer); a transaction is one write |
| `chain.<op>.before-send`, `.after-send`, `.after-receipt` for `reserve`, `top-up`, `settle`, `close`, `request-close`, `withdraw` | a channels transaction: nothing sent yet, broadcast with its receipt not yet awaited, mined with the result not yet recorded |
| `seller.response.after-cost-recorded`, `seller.need-auth.before-send`, `seller.need-auth.after-send` | the seller's request path: a request's cost is in its books, and the NeedAuth for it |
| `seller.spending-auth.after-verify`, `seller.spending-auth.after-store`, `seller.top-up.after-verify` | the seller accepting a SpendingAuth or a top-up ReserveAuth |
| `buyer.spending-auth.after-sign`, `buyer.spending-auth.before-send`, `.after-send`, `buyer.reserve-auth.before-send`, `.after-send` | the buyer: signed (not yet persisted), then persisted and sent |

**Inert in production.** The payment code only reaches a point (`hitFailpoint(name, key?)`, `hitFailpointSync(name, key?)`), which reads a handler from `globalThis[Symbol.for('antseed.failpoints')]` and returns at once when there is none. Nothing in `packages/`, `apps/` or `plugins/` installs a handler, exports a way to set one, or reads a switch for it: `test/failpoints.test.mjs` scans the source and build output for the key and fails if any file but `failpoints.ts` names it. Only a test process can install one.

**Armed by the testbench.** A topology with `failpoints: true` (cli mode) starts every node with `lib/failpoint-preload.mjs`, which installs the handler and reads the node's spec from `failpoints/<node>.json` in the testbench directory (`ANTSEED_TESTBENCH_FAILPOINTS_FILE`, read only by the preload). The file is re-read when it changes, so `tb.faults.failpoints(who, spec)` arms a running node; other topologies start their nodes without the preload. A node from another tree (`--seller-tree`) that predates the points never calls the handler.

```js
await tb.faults.failpoints('seller:seller', { points: { 'chain.close.after-send': { action: 'crash', nth: 1 } } });
```

- `nth` triggers on exactly that hit of the point, counted from the arming; `p` on a seeded share of hits (from the spec's `seed`, which defaults to one derived from the run seed; a stream per point, rule and life of the node, so a restarted node does not replay the draws that killed it); `count` caps the triggers of a rule (default 1 for a crash rule without `p`, unless the spec sets `maxCrashes`; a `p` crash rule has no cap).
- A point takes one rule or a list of rules. A list is tried in order on every hit and the first rule that triggers wins, so one point can carry a delay and a crash. A delay's `ms` is a number or a `[min, max]` range drawn per trigger.
- For the whole spec: `maxCrashes` caps the crash triggers of the arming over all points and all lives of the node (counted from the journal, so it survives the kill); `restartDelayMs: [min, max]` is how long the supervisor keeps a node this spec killed down, drawn from the spec's seed, the node and the crash number (1 s without it); `graceMs` (a number, or a `[min, max]` range drawn the same way) is the grace window after that node is back.
- **Crashes are coordinated across nodes.** The supervisor owns one small file, `failpoints/crash-state.json`: which nodes a fail point killed and are not back in service yet, and until when the grace window after the latest restart runs. It writes it when a node dies and when its restart is complete. Every node's handler reads it before a crash (at most 50 ms old), and no crash rule triggers while any node is down or the grace window runs, on whichever node. So at most one node is down at a time, as in Sui's `handle_failpoint`. A node that was never killed has no grace: a crash can fire on its first hit. Two processes can still decide in the same instant; the supervisor sees a node die while another is down and records it on that crash (`overlapped: true`, `alsoDown`), and a scenario reports the count. A spec with `ignoreOthers: true` is not held back, and a crash rule with `whenDown: '<node>'` triggers only while the state says that node is down: both are for a scenario that wants two nodes down together.
- `crash` is `SIGKILL` from inside the process: no exit handlers, no settle, no close. `error` throws a `FailpointError` from the point. `delay` waits `ms` at an async point; the points marked `(sync)` in `failpoints.ts` sit where the code must not yield, so a delay there is skipped and journaled as such. Only the first delay of a point is a journal line; an arming's totals per process are a `delays` entry, written when the spec changes, the node stops or a crash trigger is about to kill it.
- Before it acts, the handler appends a line to `failpoints/<node>.journal.jsonl` and writes `[Failpoint] <point> hit=<n> action=<action>` to the node log. The journal also records the first hit of each point per process, and the hit counts when the spec changes or the node stops gracefully. A restarted node reads it, so a crash with `count: 1` does not fire again.
- The supervisor reads the journal when a node exits. A process that died of SIGKILL and whose crash trigger is in the journal (one no earlier record stands for, so a reused pid cannot hide a real crash) goes to `health.failpointCrashes` (`{ who, point, hit, at, pid, spec, restartDelayMs, graceMs, restartedAt }`, plus `overlapped` and `alsoDown` when another node was down; `spec` is the id of the arming that killed it) instead of `unexpectedExits`, and is started again after `restartDelayMs`, the way `POST /sellers/:id/start` and `POST /buyer/start` start one. The supervisor keeps these records for its whole life and the journal outlives a run, so a scenario scopes its evidence to its own arming: `faults.failpoints()` returns the spec's `id`, and `waitForFailpointRestart`, `failpointCrashes`, `load({ failpointCrash })` and `triggeredInJournal(entries, point, action, specId)` take it. `tb.assertNoCrashes()` still fails on any other exit, and on a killed node that did not come back (`restartError`).

`lib/failpoints.mjs` holds the registry, the catalog (`POINT_CATALOG`: which node reaches each point, when, and how often in one measured load) and the seeded draws the scenarios use. In that measured run (seed 1, the warm-up request and 160 requests 16-way on a 0.25 USDC reserve) the seller reached the store points 275 times, `seller.need-auth.*` 210, `seller.response.after-cost-recorded` 161, `seller.spending-auth.*` 105, `seller.top-up.after-verify` 10, `chain.top-up.*` 8 and `chain.reserve.*` once; the buyer reached the store points 388 times, `buyer.spending-auth.*` 212 and `buyer.reserve-auth.*` 11. A drawn hit lies in the first 60% of those. Settling and closing the channel then reached `chain.settle.*` and `chain.close.*` once each. `stress-failpoint-crash` arms before its warm-up request, so a `chain.reserve.*` crash lands on the request that opens the channel and the load runs on what the restart left; every other point fires under load. Each run prints its plan as a `[failpoint] plan:` line (a sweep shows it per seed) and records it as `metrics.failpointPlan` and a `failpoint-plan` event.

After the restart both scenarios make the two nodes meet again before the oracle closes. `stress-failpoint-crash` sends one more paid request, because after a crash near the end of the load nothing else would reconnect them. `stress-failpoint-close` sends none, so that only the close path handles what the crash left: it repeats the close until the buyer reaches the seller (`metrics.closeAttemptsAfterRestart`). The buyer does not look up a seller it just failed to reach for about 30 s, and a cooperative close needs the seller found. Its load is fault-free and over before the point is armed, so the oracle holds it to the exact rule (seller spend equals delivered cost), not to the restart bounds.

#### Crashes and delays

`stress-crashes-and-delays` and `stress-crashes-and-delays-both` arm every load-phase point of a node at once, the way Sui's `test_simulated_load_reconfig_with_crashes_and_delays` registers one handler on all of its fail points (`lib/crashes-and-delays.mjs`):

- `allPointsSpec({ node, crashesPerPoint, delay, hitsScale, maxP })` gives each point a crash rule with `p = crashesPerPoint / (hits x hitsScale)` (`hits` from the catalog, `hitsScale` 3 for a load three times the measured one, at most `maxP` 0.25), so a point reached a few times and a point reached 800 times are each expected to kill the node about equally often, and a point reached once is not killed every time. Points that can wait also get a delay rule in front of it.
- `drawCrashesAndDelaysPlan(prng, { nodes })` draws the run's plan per node from the `crashes-and-delays` stream: 6 to 9 crashes expected over the node's points if nothing held them back, `restartDelayMs` from 2 to 4 s up to 6 to 10 s (the time down drawn per crash), `graceMs` from 5 to 8 s up to 10 to 20 s (the grace window drawn per crash), and delays on a 0.05 to 0.3 share of hits for 200 to 3000 ms. There is no `maxCrashes`: the shared crash state sets the rate. The seller's plan is the same in both scenarios for one seed.
- The points are armed before the warm-up request, so a crash can fire there. The load (480 requests, 16-way, a 0.25 USDC reserve) waits out every crash. After it, the scenario waits for the last restart, sends one more paid request with the points still armed, and repeats that until nothing new fires.
- **Armed through the close.** The buyer is then disarmed and the seller trades its load points for the close phase's: `chain.settle.*`, `chain.close.*` and the store writes, each with a chance of 0.04 to 0.10 per hit (`crashes-and-delays-close` stream), delays at the chain points, the same time down and grace. The scenario waits 20 s for the seller's idle settle, then closes; a close a crash interrupted is repeated once the buyer reaches the restarted seller (`closeWhenReachable` in `lib/stress.mjs`, which `stress-failpoint-close` uses too). At most 5 close rounds, a bound on the time, not on the crashes. Then everything is disarmed and the oracle judges the money with its restart bounds.
- **The gate follows what fired** (`crashesGate` in `lib/stress.mjs`): nothing may fail outside a restart window, and the ok share must be at least `1 - (crashes x 16 + 8) / 480`, where `crashes` counts the crashes that fired while the load ran. A node killed mid-load fails the requests in flight, 16 at a 16-way load (measured over six seeds: 16, 32, 48 and 65 failed requests after 1, 2, 3 and 4 crashes); the slack of 8 covers a stray failure. A worker whose request failed looks for a crash twice, 400 ms apart, before it sends again: the supervisor records a crash only when it sees the node's exit, and one early look let all 16 workers send once more into the dead node. In those six seeds the load ran 108 to 130 s when nothing else went wrong, with 1 to 4 crashes during it and 2 to 5 per run with the close phase.
- A run fails (`fault path ran: ...`) when no crash fired at all, or when a crash in the journals was not recorded by the supervisor and followed by a restart. Everything is scoped to this run's armings by spec id.
- The plan and what fired are `metrics.crashesAndDelays` (`{ plan, specIds, closeSpecId, crashes, closeCrashes, closeAttempts, overlapped, delays }`: the load phase's crashes and the close phase's apart, and how many crashes came while another node was down), `metrics.crashesDuringLoad`, the `crashes-and-delays-plan` and `crashes-and-delays` events, and two `[failpoint] plan:` lines: the plan at the start, and the plan with the crashes and the delay count at the end. A sweep shows the last one per seed.

`stress-crashes-correlated` is the opposite on purpose: both nodes down together, at the same payment step, the way Sui keys a correlated crash on the logical event. Both nodes are armed with one seed and a keyed crash rule (below) on a SpendingAuth: the buyer at `buyer.spending-auth.after-send`, the seller at `seller.spending-auth.after-verify`, both hashing the key (`<channel id>:<cumulative amount>`) with the group `spending-auth` and `p` 0.06, so both pick the same SpendingAuth. The seller is killed at its point, the moment it has verified it. The buyer cannot die at its own point: a kill right after the send takes the frame along (it is still in the socket's queue), and a SpendingAuth above the reserve ceiling is verified only once the seller's top-up is mined, seconds later, which a dead buyer never sees because the seller closes the channel of a buyer that disconnects. So the buyer marks the step at its point and is killed as soon as the shared crash state says the seller is down (`killWhenDown`, looked at every 25 ms). Both are restarted, one more paid request must go through, and the evidence is one crash per node, the same key on both, and down windows that overlap (`metrics.crashesCorrelated`: `{ plan, crashes, sameStep, key, overlap, overlapMs }`). With about 100 SpendingAuths in the load, none is picked in about 1 run in 500, and that run fails its evidence.

#### Decisions keyed on the payment step

A `p` rule draws per hit, so under a real clock the same seed kills at another payment step in each run, and two nodes can never be told to die at the same one. A rule with `keyed: true` decides by the step instead. At the points marked `keyed` in `POINT_CATALOG` the payment code passes a key, `hitFailpointSync(name, key)`: the channel id and a cumulative amount it already holds (the SpendingAuth's amount at the buyer's sign and send points and the seller's verify and store points, the required amount at the NeedAuth points, the seller's spend at `seller.response.after-cost-recorded`, the new ceiling at `seller.top-up.after-verify`). `chain.*` and `store.*` carry none. Without a handler the key is not looked at.

- A keyed rule triggers when `keyedDecision(seed, group ?? point, key, p)` holds: a hash of the spec's seed, the point name (or the rule's `group`) and the key, below `p`. No stream and no hit count are involved, so the same seed and key decide the same in any order and in any process.
- At most once per key, over all lives of the node (the journal line of a keyed trigger carries its `key`, and so does the supervisor's crash record). A hit without a key never triggers a keyed rule.
- Two nodes armed with the same `seed` and the same `group` pick the same keys: that is the correlated crash.
- `crashesAndDelaysPlan(seed, { nodes, keyed: true })` (and `allPointsSpec({ keyed: true })`) makes the crash rules of the keyed points decide per step with the same `p`; the shipped crashes-and-delays scenarios decide per hit.

#### The buyer's exit

`chain.request-close.*` and `chain.withdraw.*` are never reached by a node: the unilateral exit is two one-shot commands. `tb.cli(args, { failpoints: spec })` preloads the handler into such a command with a spec file and a journal of its own under `failpoints/cli/`. A command that a fail point killed died of SIGKILL, was not killed by the runner's timeout, and has the crash trigger of its own pid in its journal (`result.failpoint.crash`); any other ending is the command's own.

`stress-failpoint-exit` pays for three chats, kills the seller and leaves it down, then runs `antseed buyer channels request-close` armed to crash at one drawn `chain.request-close.*` point (nothing sent yet, broadcast, or mined), compares the chain with what that point leaves behind, and runs the command again 3 s later until it exits 0: it must send the request, or report the one already on chain, and the buyer must have sent exactly one transaction. After the 15 min grace (`warp`) the same happens to `antseed buyer channels withdraw` at one drawn `chain.withdraw.*` point. At the end the channel has timed out, no reserve is left, and deposit left plus settled equals the original deposit.

#### The plan of a seed

```bash
pnpm testbench plan stress-crashes-and-delays --seed 7    # the drawn plan and every spec, as JSON; starts nothing
```

Every fail point scenario exports `failpointPlan(seed)`, which returns what it arms for a run seed (the plan and each spec with its seed, so the `p` draws, the delay lengths, the times down and the grace windows are fixed too), and its `run` arms exactly that. Two prints of one seed are identical, and a unit test holds every scenario to it. That is the part of Sui's determinism check that carries over: a run is seeded but not replayed deterministically, because the nodes are real processes on a real clock, so the same seed draws the same plan and the same chance per hit, but the hits arrive in another order and a crash can land elsewhere.

What still differs from Sui's test: nothing runs these nightly, they are run by hand or in a sweep; and the crashes-and-delays scenarios draw per hit, so one seed does not kill at the same payment step in every run (a keyed plan would, at the points that carry a key).

### Seed sweep

```bash
pnpm testbench:sweep stress-chaos --seeds 1-10 --chain local                       # one fresh testbench per seed, one at a time
pnpm testbench:sweep stress-slow-topups --seeds 1-5 --chain local --seller-tree ../other-tree
```

A sweep runs the scenario once per seed (`run`, then `down`), passes every other flag on to `run`, and ends with one line per seed and, for each seed that did not pass, its report, failed checks and `rerun:` line. It exits 1 when any seed failed. `--seeds` takes numbers and ranges (`1-5`, `3,7,11`), at most 200. It refuses `--keep`, `--live`, `--real-funds` and `--chain mainnet`. `ANTSEED_TESTBENCH_SWEEP_OUT=FILE` also writes the results as JSON.

When the runs carried fail point plans, the sweep ends with a coverage summary, from each run's `metrics.failpointCoverage` (`{ armed: { node: [point] }, crashes: [{ node, point }] }`): per node and point, how many seeds saw a crash there, and the armed points that never triggered in the whole sweep. The JSON file gets it as `failpointCoverage`.

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

`GET /status`, `GET /health`, `POST /channels/close {sellerId?}`, `POST /chain/warp {seconds}`, `POST /chain/block-time {seconds}`, `POST /buyer/stop`, `POST /buyer/start`, `POST /sellers/:id/stop`, `POST /sellers/:id/crash`, `POST /sellers/:id/start`, `GET|POST /sellers/:id/mock {latencyMs?, fault500Rate?, disconnectRate?, slowRate?, slowMs?}`, `GET /sellers/:id/deliveries`, `GET|POST /sellers/:id/top-up-hold {action: 'arm' | 'drop'}`, `GET|POST /faults/buyer/need-auth-loss {count}`, `GET /failpoints/:who` (the armed spec and the journal), `POST /failpoints/:who {spec}` or `{clear: true}` (`:who` is `buyer` or `seller:<id>`; cli mode with `failpoints: true`, else `409`), `POST /shutdown`

`GET /health` returns `unexpectedExits`, `forcedStops`, `unhandledRejections`, `failpointCrashes` and the RPC counters.

## Fork cache

Applies to `--chain fork` only. Anvil's RPC cache makes a warm `up` take a few seconds instead of a minute.

- The shared cache lives in `~/.antseed-testbench/.cache/anvil` (override with `ANTSEED_TESTBENCH_CACHE_DIR`). It is seeded once from the older `~/.antseed-e2e/anvil-home` cache, which is only ever read.
- Each testbench copies the warm block into its own `anvil-home/`; Anvil never writes the shared cache.
- On exit the testbench's copy is published back under `cache.lock` with a temp file and an atomic rename, and only if it is larger than the shared copy.
- Pruning keeps the newest 3 blocks and never removes a block pinned by a running testbench.
- Without `--block`, the newest warm block younger than 72 hours is reused; otherwise the fork pins a block just behind head.

## Tests

```bash
pnpm test:testbench       # fast unit tests (node --test): options, config, naming, locks, manifest, ports, cache, mock, control, stress load, gates and ledger, fail points
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
- a nightly CI job running the full `scenarios/stress/` set across several seeds (the per-PR `testbench` job already runs five scenarios, `stress-smoke` among them); then retire `e2e/stress`'s own chain, mock, bootstrap and config writers once the testbench scenarios match its results (`docs/testing.md`)
- a `testbench-compat` CI job, modelled on Sui's split-cluster check (`scripts/compatibility/split-cluster-check.sh`, run by `.github/workflows/split-cluster-pr.yml` on every PR): a separate job that checks out and builds the last published release tag next to the PR, then runs `payment-flow` and `stress-smoke` in cli mode twice each, new buyer against the release seller (`--seller-tree`) and release buyer against the new seller (`--buyer-tree`), both with `--strict`. It is a smoke test of "do old and new peers still work together", not the full scenario set, which keeps running on one version. Follow-ups: `--seller-version <tag>` to fetch a published CLI instead of a checkout, and a bisect variant that finds the commit that broke compatibility
- seed search in CI: `pnpm testbench:sweep` runs one scenario across many seeds by hand (Sui's `seed-search.py`); the nightly job should run `stress-chaos` and the fault shapes that way
- more fail point scenarios: `error` and `delay` actions under load (a lost NeedAuth through `seller.need-auth.before-send` in cli mode, a slow settle), the buyer's unilateral exit (`chain.request-close.*`, `chain.withdraw.*`), and both fail point shapes in the nightly seed search
- retiring `e2e/scripts/full-payment-flow.mjs` once local runs prove stable in CI
- streaming the real-funds profile desktop with `share`
- Anvil state snapshots, a Herdr tab launcher, rebasing the video harness onto this
