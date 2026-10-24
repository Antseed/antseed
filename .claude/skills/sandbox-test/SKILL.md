---
name: sandbox-test
description: How to use the worktree sandbox (pnpm sandbox): prerequisites, up and down, running a scenario, --chain local or fork, reading and serving reports, desktop runs under xvfb-run, share, logs. Runs isolated scenarios without asking and asks only before --live, --real-funds or mainnet runs. What to run for a given change is decided by the verify-antseed skill, not here. Use when asked to "run the sandbox", "run a scenario", "open the report", "share the desktop", or when verify-antseed names a scenario to run.
---

# Sandbox test

How to drive `pnpm sandbox` in this worktree. `e2e/sandbox/README.md` is the full reference for every command and the `sb` API.

**What to run is not decided here.** The **verify-antseed** skill (`.claude/skills/verify-antseed/SKILL.md`, "Decide what to prove") maps a changed path to the unit tests and scenarios it requires, and says when the change is proven. Read it first, then use this skill to run what it names.

## Rules

- **Isolated runs need no approval.** Builds, new scenarios, `--chain local` runs (or fork runs, when `.env.local` has the RPC) and desktop QA can run without asking. Say what you will run, then run it.
- **Ask before spending.** `--live` (real upstream API money), `--real-funds`, `--chain mainnet` and `pnpm sandbox mainnet` (real USDC from the test wallet) each need an explicit yes for that run. Never print key or wallet values; check that they exist with `grep -c`.
- Never touch `~/.antseed`, the keychain, port 8377, or processes the sandbox did not start. Tear down only with `pnpm sandbox down`; use `--force` only with the user's approval.
- Don't commit. Don't weaken a check to make a run pass. Report a `KNOWN` result (a `knownIssue`) as known.

## 1. Prerequisites

- Node must match `.nvmrc` (24.x); `up` refuses other majors. Put a Node 24 first on `PATH`: Volta on macOS (`PATH=~/.volta/tools/image/node/<24.x>/bin:$PATH`), `/usr/local/bin` or `nvm use` on Linux.
- `--chain local` needs Foundry (`forge`, `anvil`; `export PATH=$HOME/.foundry/bin:$PATH`) and `git submodule update --init packages/contracts/lib/forge-std`.
- `--chain fork` needs `BASE_MAINNET_RPC_URL` (a dedicated Base RPC with an API key) in the worktree's gitignored `.env.local` or the shell. Check with `grep -c '^BASE_MAINNET_RPC_URL=' .env.local`. If it is missing, ask the user to add it or use `--chain local`; never fall back to a public RPC.
- The sandbox loads `dist/`, not `src/`: `pnpm install && pnpm run build` in a fresh worktree, and rebuild changed packages after an edit.
- One read-only check for all of this: `.claude/skills/verify-antseed/scripts/doctor.mjs`. Fix every `FAIL` before a run.

## 2. Run a scenario

```bash
pnpm -s sandbox list                                  # every sandbox on this machine
pnpm -s sandbox status                                # this worktree's sandbox, if any
pnpm sandbox run <scenario> --chain local             # starts a sandbox, runs, writes a report, stops
pnpm sandbox run <scenario> --chain local --keep      # leaves it up afterwards
```

- Scenarios live in `e2e/sandbox/scenarios/<name>.mjs`. The shipped ones: `chat-basic`, `payment-flow`, `routing-smoke`, `desktop-chat`, `mainnet-smoke` (real funds), and the `issue-*` scenarios.
- Each run prints `PASS`, `FAIL` and `KNOWN` lines and the path of `report.json`. `--strict` turns `KNOWN` into failures.
- If this worktree's sandbox is already running with the same topology, `run` reuses it (same chain, same channels); with another topology it refuses. Run `pnpm sandbox down` first, or add `--slot NAME` for a second sandbox next to it.
- Scenarios assume a fresh sandbox: run `pnpm sandbox down` between runs after `--keep` or `up`.
- For evidence (checks.log, the run transcript, per-run logs) run scenarios through `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> --chain local`, as verify-antseed describes.
- A first `--chain local` run in a worktree compiles the contracts (about 2.5 minutes); later runs are ready in seconds. Give such a run a long command timeout or run it in the background.

## 3. Chains

| | `--chain local` | `--chain fork` |
| --- | --- | --- |
| Chain | empty Anvil, this worktree's `packages/contracts` deployed from source | Anvil fork of Base mainnet, the production contracts |
| Needs | `forge` + forge-std, no RPC key | `BASE_MAINNET_RPC_URL` |
| Use for | contract changes, payment checks, offline work | release checks against what is live |

`payment-flow` defaults to local, other scenarios to fork; pass `--chain` explicitly. A contract change shows up only on `--chain local`.

## 4. Keep a network up and poke at it

```bash
pnpm sandbox up --chain local [--config FILE] [--live]
eval "$(pnpm -s sandbox status --env)" && curl "$ANTSEED_PROXY_URL/v1/models"
pnpm sandbox logs supervisor            # also: anvil, seller-<id>; --follow to tail
pnpm sandbox down                       # settles and closes channels, then stops
```

## 5. Reports

Every run writes `~/.antseed-sandbox/<name>/reports/<timestamp>-<scenario>/`: `index.html`, `report.json`, `events.jsonl`, `metrics.json`, and for desktop runs `screenshots/`, `video/desktop.webm` and `desktop-main.log`. `pnpm sandbox down` keeps them.

- Same machine: `pnpm sandbox report --open` (latest run) or the printed `index.html` path.
- Remote machine or server: `pnpm sandbox report --serve --port 8799` there (it binds to loopback), then `ssh -L 8799:127.0.0.1:8799 <host>` and open `http://127.0.0.1:8799/`. Never bind to `0.0.0.0` unless the user asks: reports contain wallet addresses and logs.
- `run --trace` records a Playwright trace (`npx playwright show-trace <report>/trace.zip`, 100+ MB) for a step-by-step replay.
- On a failure, read `report.json`, `events.jsonl` and the logs before tearing down. If an earlier report of the same scenario exists, compare its metrics with the new one.

## 6. Desktop runs

- Rebuild the desktop first: `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`.
- `pnpm sandbox run desktop-chat --chain local` launches the built attach-only desktop under Playwright on the sandbox buyer (sandbox wallet, sandbox chat store, telemetry off). A window opens while it runs.
- On a headless Linux server or VPS: `xvfb-run -a pnpm sandbox run desktop-chat --chain local`.
- After the run, open `screenshots/` and `video/desktop.webm` and say what they show; read `desktop-main.log` for main-process errors. A chat timeout saves `screenshots/*chat-timeout*.png` and puts the visible screen text in the error.
- A new desktop scenario: `e2e/sandbox/scenarios/desktop-<name>.mjs` with `requires: ['desktop']`, `const ui = await sb.desktop()`, role and label selectors (`getByRole`, `getByLabel`), `ui.screenshot(name)`, and `sb.check('no renderer errors', ui.errors.length === 0, ui.errors)`. If an element has no accessible name, add an `aria-label` as part of the change.
- Hands-on review: `pnpm sandbox run desktop-chat --chain local --keep`, then `pnpm sandbox desktop` (Vite hot reload, attach-only; `--cdp-port N` for agent-browser), or `pnpm sandbox:attach`.

## 7. Share (Linux server)

`pnpm sandbox share` streams the attach-only desktop to the user's browser over Tailscale and prints `https://<host>.<tailnet>.ts.net/<sandbox-name>/`. Give the user that URL; `pnpm sandbox share --stop` or `pnpm sandbox down` ends it. Without Tailscale: `--no-tailscale`, then an ssh tunnel to the printed loopback port. Server setup and security rules are in `e2e/sandbox/README.md`, "Share".

## 8. Real network (only with an explicit yes)

`pnpm sandbox run mainnet-smoke --chain mainnet --real-funds` runs this worktree's buyer against live sellers with real USDC from the test wallet (capped at `ANTSEED_SANDBOX_MAINNET_MAX_RESERVE_USDC`, default 0.50). It needs `ANTSEED_SANDBOX_MAINNET_IDENTITY_HEX` and `BASE_MAINNET_RPC_URL`. Propose it as a separate step; never start it without a yes for that run. Its failures are read from the report's `desktop-main.log`, screenshots, video and `metrics.json`.

## 9. Report back

Per scenario: passed or failed, the failing checks with their `detail`, `KNOWN` results as known, metrics that moved against the previous report, the report path (and the video for desktop runs), and whether the sandbox is still running and how to stop it.
