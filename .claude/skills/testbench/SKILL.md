---
name: testbench
description: How to use the worktree testbench (pnpm testbench): prerequisites, up and down, running a scenario, --chain local or fork, reading and serving reports, desktop runs under xvfb-run, share, logs. Opt-in only; asks before --live, --real-funds or mainnet runs. What to run for a given change is decided by the verify-antseed skill, not here. Use only when the user asks to "run the testbench", "run a scenario", "open the report", "share the desktop", or when the user invoked verify-antseed and it names a scenario to run. Do not use it on your own after a code change.
---

# Testbench test

How to drive `pnpm testbench` in this worktree. `e2e/testbench/README.md` is the full reference for every command and the `tb` API.

**What to run is not decided here.** The **verify-antseed** skill (`.claude/skills/verify-antseed/SKILL.md`, "Decide what to prove") maps a changed path to the unit tests and scenarios it requires, and says when the change is proven. Read it first, then use this skill to run what it names.

## Rules

- **Opt-in.** Run the testbench only when the user asked for it (see `CLAUDE.md`). Once they have, isolated runs for that task (`--chain local`, fork runs when `.env.local` has the RPC, desktop QA) need no further approval: say what you will run, then run it.
- **Ask before spending.** `--live` (real upstream API money), `--real-funds`, `--chain mainnet` and `pnpm testbench mainnet` (real USDC from the test wallet) each need an explicit yes for that run. Never print key or wallet values; check that they exist with `grep -c`.
- Never touch `~/.antseed`, the keychain, port 8377, or processes the testbench did not start. Tear down only with `pnpm testbench down`; use `--force` only with the user's approval.
- Don't commit. Don't weaken a check to make a run pass. Report a `KNOWN` result (a `knownIssue`) as known.

## 1. Prerequisites

- Node must match `.nvmrc` (24.x); `up` refuses other majors. Put a Node 24 first on `PATH`: Volta on macOS (`PATH=~/.volta/tools/image/node/<24.x>/bin:$PATH`), `/usr/local/bin` or `nvm use` on Linux.
- `--chain local` needs Foundry (`forge`, `anvil`; `export PATH=$HOME/.foundry/bin:$PATH`) and `git submodule update --init packages/contracts/lib/forge-std`.
- `--chain fork` needs `BASE_MAINNET_RPC_URL` (a dedicated Base RPC with an API key) in the worktree's gitignored `.env.local` or the shell. Check with `grep -c '^BASE_MAINNET_RPC_URL=' .env.local`. If it is missing, ask the user to add it or use `--chain local`; never fall back to a public RPC.
- The testbench buyer pays from its own throwaway key, or from `ANTSEED_TESTBENCH_BUYER_IDENTITY_HEX` in `.env.local` or the shell when set. Never put the user's real key there or read it from `~/.antseed`.
- The testbench loads `dist/`, not `src/`: `pnpm install && pnpm run build` in a fresh worktree, and rebuild changed packages after an edit.
- Desktop scenarios need Playwright's ffmpeg for the run video: `pnpm exec playwright install ffmpeg` once per machine (doctor checks it). As root on Linux the desktop launchers add `--no-sandbox` automatically.
- One read-only check for all of this: `.claude/skills/verify-antseed/scripts/doctor.mjs`. Fix every `FAIL` before a run.

## 2. Run a scenario

```bash
pnpm -s testbench list                                  # every testbench on this machine
pnpm -s testbench status                                # this worktree's testbench, if any
pnpm testbench run <scenario> --chain local             # starts a testbench, runs, writes a report, stops
pnpm testbench run <scenario> --chain local --keep      # leaves it up afterwards
```

- Scenarios live in `e2e/testbench/scenarios/<name>.mjs`. The shipped ones: `chat-basic`, `payment-flow`, `routing-smoke`, `desktop-chat`, `mainnet-smoke` (real funds), and the `issue-*` scenarios.
- Each run prints `PASS`, `FAIL` and `KNOWN` lines and the path of `report.json`. `--strict` turns `KNOWN` into failures. `--budgets` turns a scenario's `topology.budgets` into `budget: ...` checks (recorded in grey without it), and `DRIFT` lines name timings that moved against the previous passed run.
- `report.json` has `result`: `passed`, `failed`, `error`, `timeout` (past `--run-timeout`, default 1800 seconds) or `blocked` (the environment refused the run). The exit codes are 0, 1, 4, 3 and 2; `pnpm -s` turns any of them into 1. Anything but `passed` prints a `rerun:` line with the run's `--seed`; see `docs/testing.md`.
- If this worktree's testbench is already running with the same topology, `run` reuses it (same chain, same channels); with another topology it refuses. Run `pnpm testbench down` first, or add `--slot NAME` for a second testbench next to it.
- Scenarios assume a fresh testbench: run `pnpm testbench down` between runs after `--keep` or `up`.
- A `run` killed by a command timeout (SIGKILL) no longer orphans its testbench. The supervisor's watchdog settles and stops it within about 30 seconds, and the next `run` restarts one it finds that way. Still tear down with `pnpm testbench down`, and wait while `pnpm testbench list` says `starting` or `stopping`. A testbench left up by `up` or `--keep` stops after `ANTSEED_TESTBENCH_IDLE_MINUTES` (default 120) without a control request.
- For evidence (checks.log, the run transcript, per-run logs) run scenarios through `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> --chain local`, as verify-antseed describes.
- A first `--chain local` run in a worktree compiles the contracts (about 2.5 minutes); later runs are ready in seconds. Give such a run a long command timeout or run it in the background.

## 3. Chains

| | `--chain local` | `--chain fork` |
| --- | --- | --- |
| Chain | empty Anvil, this worktree's `packages/contracts` deployed from source | Anvil fork of Base mainnet, the production contracts |
| Needs | `forge` + forge-std, no RPC key | `BASE_MAINNET_RPC_URL` |
| Use for | contract changes, payment checks, offline work | release checks against what is live |

A scenario's default chain is the first entry in its `targets`: `payment-flow` and `issue-1200-spendingauth-catchup` default to local, the others to fork. Pass `--chain` explicitly. A contract change shows up only on `--chain local`.

## 4. Keep a network up and poke at it

```bash
pnpm testbench up --chain local [--config FILE] [--live]
eval "$(pnpm -s testbench status --env)" && curl "$ANTSEED_PROXY_URL/v1/models"
pnpm testbench logs supervisor            # also: anvil, seller-<id>; --follow to tail
pnpm testbench down                       # settles and closes channels, then stops
```

## 5. Reports

Every run writes `~/.antseed-testbench/<name>/reports/<timestamp>-<scenario>/`: `index.html`, `report.json`, `events.jsonl`, `metrics.json`, and for desktop runs `screenshots/`, `video/desktop.webm` and `desktop-main.log`. `pnpm testbench down` keeps them.

- Same machine: `pnpm testbench report --open` (latest run) or the printed `index.html` path.
- Remote machine or server: `pnpm testbench report --serve --port 8799` there (it binds to loopback), then `ssh -L 8799:127.0.0.1:8799 <host>` and open `http://127.0.0.1:8799/`. Never bind to `0.0.0.0` unless the user asks: reports contain wallet addresses and logs.
- `run --trace` records a Playwright trace (`npx playwright show-trace <report>/trace.zip`, 100+ MB) for a step-by-step replay.
- On a failure, read `report.json`, `events.jsonl` and the logs before tearing down. If an earlier report of the same scenario exists, compare its metrics with the new one.

## 6. Desktop runs

- Rebuild the desktop first: `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`.
- `pnpm testbench run desktop-chat --chain local` launches the built attach-only desktop under Playwright on the testbench buyer (testbench wallet, testbench chat store, telemetry off). A window opens while it runs.
- On a headless Linux server or VPS: `xvfb-run -a pnpm testbench run desktop-chat --chain local`.
- After the run, open `screenshots/` and `video/desktop.webm` and say what they show; read `desktop-main.log` for main-process errors. A chat timeout saves `screenshots/*chat-timeout*.png` and puts the visible screen text in the error.
- A new desktop scenario: `e2e/testbench/scenarios/desktop-<name>.mjs` with `requires: ['desktop']`, `const ui = await tb.desktop()`, role and label selectors (`getByRole`, `getByLabel`), `ui.screenshot(name)`, and `tb.check('no renderer errors', ui.errors.length === 0, ui.errors)`. If an element has no accessible name, add an `aria-label` as part of the change.
- Hands-on review: `pnpm testbench run desktop-chat --chain local --keep`, then `pnpm testbench desktop` (Vite hot reload, attach-only; `--cdp-port N` for agent-browser), or `pnpm testbench:attach`.

## 7. Share (Linux server)

`pnpm testbench share` streams the attach-only desktop to the user's browser over Tailscale and prints `https://<host>.<tailnet>.ts.net/<testbench-name>/`. Give the user that URL; `pnpm testbench share --stop` or `pnpm testbench down` ends it. Without Tailscale: `--no-tailscale`, then an ssh tunnel to the printed loopback port. Server setup and security rules are in `e2e/testbench/README.md`, "Share".

## 8. Real network (only with an explicit yes)

`pnpm testbench run mainnet-smoke --chain mainnet --real-funds` runs this worktree's buyer against live sellers with real USDC from the test wallet (capped at `ANTSEED_TESTBENCH_MAINNET_MAX_RESERVE_USDC`, default 0.50). It needs `ANTSEED_TESTBENCH_MAINNET_IDENTITY_HEX` and `BASE_MAINNET_RPC_URL`. Propose it as a separate step; never start it without a yes for that run. Its failures are read from the report's `desktop-main.log`, screenshots, video and `metrics.json`.

## 9. Report back

Per scenario: passed or failed, the failing checks with their `detail`, `KNOWN` results as known, metrics that moved against the previous report, the report path (and the video for desktop runs), and whether the testbench is still running and how to stop it.
