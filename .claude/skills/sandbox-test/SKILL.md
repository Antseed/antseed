---
name: sandbox-test
description: Test the current worktree's changes end to end with pnpm sandbox. Covers four cases (isolated seller/buyer network, desktop-only changes, this worktree's buyer against real mainnet sellers with real funds, and runs on a server). Picks the case and scenarios from the diff, runs isolated scenarios without asking (asks only before --live, --real-funds or mainnet runs), and reports checks and metrics. Use when asked to "sandbox test", "test this end to end", "run the sandbox", "verify payments/routing", or before a release.
---

# Sandbox Test

Runs the worktree's changes through `pnpm sandbox` (see `e2e/sandbox/README.md`) and
reports what passed, what failed and which metrics moved. The **verify-antseed** skill
(`.claude/skills/verify-antseed/SKILL.md`) layers on this one: which scenario a change
requires and when a change is proven, the red-to-green bug protocol, and evidence for PR bodies.

## Rules

- **Isolated runs need no approval.** Once the user has discussed the change, build, write
  scenarios, and run `--chain local` (or fork, when `.env.local` has the RPC) and desktop QA
  without asking. Announce the plan (step 3), then run it.
- **Ask before spending.** `--live`, `--real-funds`, `--chain mainnet` and `pnpm sandbox mainnet`
  each need an explicit yes for that run.
- **`--real-funds` spends real USDC** from the user's test wallet on mainnet (case 3). Only
  propose it, after the isolated runs pass; never start it without an explicit yes for that
  run. Check `ANTSEED_SANDBOX_MAINNET_IDENTITY_HEX` exists with `grep -c` and never print it.
- **`--live` spends real money** on upstream provider APIs. Only use it when the user asks
  for it, and say which `apiKeyEnv` names it will read. Never print key values.
- Never touch `~/.antseed`, the keychain, port 8377, or processes the sandbox didn't start. Use
  `pnpm sandbox down`, and only use `--force` if the user approves it.
- Don't commit. Don't "fix" a failing check by weakening it. Report the failure.
- Report a `KNOWN` result (a `knownIssue`) as known, not as a new regression.

## Procedure

### 1. Gather the diff

Two chains: `--chain fork` (Base mainnet fork, production contracts) and `--chain local`
(plain Anvil, this worktree's `packages/contracts` deployed from source, no RPC key; needs
`forge` and `packages/contracts/lib/forge-std`). `payment-flow` defaults to local, other
scenarios to fork.

Fork prerequisite: `BASE_MAINNET_RPC_URL` (a dedicated Base RPC with an API key) must be in the
worktree's gitignored `.env.local` or the shell; a fork `up` refuses to start without it. Check
with `grep -c '^BASE_MAINNET_RPC_URL=' .env.local` and never print the value. If it's
missing, ask the user to add it (or offer `--chain local`); don't fall back to a public RPC.

Node must match `.nvmrc` (24.x); `up` refuses other majors. If `node -v` differs, put a
Node 24 first on `PATH`: Volta on macOS (`PATH=~/.volta/tools/image/node/<24.x>/bin:$PATH`),
`/usr/local/bin` or `nvm use` on Linux. `.claude/skills/verify-antseed/scripts/doctor.mjs`
checks this, Foundry and stale `dist/` in one read-only pass.

```bash
git status --short
git diff --name-only $(git merge-base HEAD origin/main)...HEAD; git diff --name-only
pnpm -s sandbox list
pnpm -s sandbox status
```

Note whether a sandbox is already running for this worktree. `run` reuses it only if
the topology matches; otherwise it refuses. Use `--slot NAME` to run alongside it.

### 2. Pick the case, then map changed paths to runs

`e2e/sandbox/README.md` is organised by four cases:

| Case | When | Runs |
| --- | --- | --- |
| 1. Isolated network | seller, buyer, `packages/node`, payments, routing, contracts | `pnpm sandbox run <scenario>` (table below) |
| 2. Desktop only | only `apps/desktop/**` changed | `desktop-chat` or a new desktop scenario; offer `pnpm sandbox desktop` (hot reload) for hands-on review |
| 3. Real network | buyer, buyer proxy, routing or desktop-buyer changes, after case 1 passes | propose `pnpm sandbox run mainnet-smoke --chain mainnet --real-funds` |
| 4. Server | the user is on a Linux server | case 1/2 runs; wrap desktop scenarios in `xvfb-run -a`; `pnpm sandbox share` for hands-on |

Case 3 is always a separate, explicit proposal: say it spends real USDC from the test wallet
(capped at `ANTSEED_SANDBOX_MAINNET_MAX_RESERVE_USDC`, default 0.50) and needs
`ANTSEED_SANDBOX_MAINNET_IDENTITY_HEX` plus `BASE_MAINNET_RPC_URL`. If the wallet env is
missing, tell the user how to set it (README, case 3) instead of running.

The required minimum per changed path is the table in **verify-antseed** ("Decide what to prove");
run that first. This table adds broader runs and the case 3 proposals.

| Changed paths | Runs |
| --- | --- |
| `packages/node/src/payments/**`, buyer/seller payment managers, channel store, `storage/migrations/**` | `payment-flow` (local), `chat-basic`, every `issue-*` scenario, then `routing-smoke` |
| routing, discovery, DHT, `packages/router-core/**`, `apps/cli/src/proxy/**` (buyer proxy) | `routing-smoke`, then `chat-basic`; then propose case 3 `mainnet-smoke` |
| `packages/buyer-core/**`, `plugins/router-local/**`, desktop buyer runtime (`apps/desktop/src/main/runtime/**`) | `chat-basic`, `desktop-chat`; then propose case 3 `mainnet-smoke` |
| `packages/provider-core/**`, `plugins/provider-*/**` | `chat-basic`; offer `--live` with the user's config if the change touches the real upstream path |
| `packages/node/src/node.ts`, connection/transport/metering | `chat-basic` + `routing-smoke` |
| `apps/desktop/**` | rebuild the desktop, then `desktop-chat`; for UI not covered yet, propose a new desktop scenario (see Desktop feature QA) |
| `e2e/sandbox/**` | `pnpm test:sandbox`, then `pnpm test:sandbox:e2e` (add scenario names if scenarios changed) |
| `packages/contracts/**` | `forge test`, then `forge build` and `payment-flow --chain local` + `chat-basic --chain local` (local deploys the changed contracts); keep `Deploy.s.sol` creation order or `base-local` addresses break |
| docs, website, CHANGELOG only | nothing to run; say so |

Always run the package's own unit tests for changed code first (for example
`cd packages/node && pnpm test`). They're faster, and a broken unit makes sandbox
failures noisy.

If none of the existing scenarios cover the changed behaviour (for example channel
expiry, a seller dying mid-stream, a deposit top-up), write a new scenario in
`e2e/sandbox/scenarios/<name>.mjs` with its `topology`, the `sb` calls, and the checks it
asserts. For a bug, name it `issue-<N>-<slug>.mjs` and follow the red-to-green protocol in
**verify-antseed**.

### 3. State the plan, then run it

Before the first run, tell the user in a few lines:

- the changed areas and why each run was picked
- the exact commands, in order, including whether a build is needed (`pnpm run build`
  if any `dist/` the sandbox loads is older than the changed sources)
- mock or `--live`, which slot, and whether to `--keep` it running afterwards
- the chain per scenario (`--chain local` or fork) and why
- a rough cost: a local chain takes seconds, a cold fork about a minute, a warm one a few seconds; `--live` costs real API money

Then continue to step 4 without waiting. Stop and ask only if the plan needs `--live`,
`--real-funds` or a mainnet run; propose those as a separate step after the isolated runs pass.

### 4. Run

```bash
pnpm run build                       # only if needed
pnpm sandbox run <scenario> [--chain fork|local] [--strict] [--keep] [--slot NAME]
pnpm sandbox run mainnet-smoke --chain mainnet --real-funds   # case 3, only after an explicit yes
```

Case 3 failures: read the report's `desktop-main.log`, the screenshots and video, and
`metrics.json` (`signedThisRunMicroUsdc`, deposit before/after). There are no supervisor logs:
the desktop runs its own buyer in `~/.antseed-sandbox/<name>/profiles/mainnet/home`.

Run scenarios one at a time. Each prints `PASS`/`FAIL`/`KNOWN` lines and the path of
`report.json`. On failure, collect evidence before tearing down:

```bash
pnpm sandbox logs supervisor
pnpm sandbox logs seller-<id>
pnpm sandbox status --json
```

Read `report.json`, `events.jsonl` and `metrics.json` in the reported directory
(`~/.antseed-sandbox/<name>/reports/<timestamp>-<scenario>/`).

### 5. Hand the user the evidence

Every run writes `index.html` in its report directory: result, checks, metrics, screenshots,
the desktop video (`video/desktop.webm`) and events. Always give the user a way to open it:

- Same machine: `pnpm sandbox report --open` (latest run), or the printed `index.html` path.
- Remote machine or server: start `pnpm sandbox report --serve --port 8799` in a background
  session and tell the user to run `ssh -L 8799:127.0.0.1:8799 <host>` and open
  `http://127.0.0.1:8799/`. Never bind to `0.0.0.0` unless the user asks: reports contain
  wallet addresses and logs.
- Add `--trace` to `run` when a failure needs a step-by-step replay
  (`npx playwright show-trace <report>/trace.zip`). Traces are large (100+ MB).

### 6. Compare and report

If an earlier report for the same scenario exists in that sandbox's `reports/`, compare
its metrics with the new run (settled amounts, fees, routing shares, latency).

Report briefly:

- per scenario: passed/failed, failing checks with their `detail`, and any known issues
- metrics that changed against the previous report
- likely cause of each failure, with file references from the diff and log lines
- the report link (path or served URL) and the video path, for every desktop run
- whether the sandbox is still running (`--keep`) and how to stop it (`pnpm sandbox down`)

Leave the sandbox running only if the user asked for `--keep` or for desktop QA.

## Desktop feature QA

Desktop QA is agent-run: `sb.desktop()` launches the built attach-only desktop under
Playwright on the sandbox buyer (sandbox wallet, chats stored in the sandbox, telemetry off).

1. Run the desktop unit tests and typecheck, then rebuild so Playwright runs the changed
   code: `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`.
2. Run `pnpm sandbox run desktop-chat --chain local` (the chat send/reply/payment path) plus any new
   scenario for the changed feature. A visible window opens while it runs; tell the user.
   On a headless Linux server, use `xvfb-run -a pnpm sandbox run desktop-chat --chain local`.
3. For a feature not covered yet, write a scenario in `e2e/sandbox/scenarios/desktop-<name>.mjs`
   with `requires: ['desktop']`. Pattern:
   ```js
   const ui = await sb.desktop();
   await ui.page.getByRole('button', { name: 'Models' }).click();   // role/label selectors
   await ui.screenshot('models');
   sb.check('sandbox model listed', (await ui.text()).includes('sandbox-chat'));
   await sb.stopSeller('seller');                                   // drive backend state
   sb.check('no renderer errors', ui.errors.length === 0, ui.errors);
   ```
   Prefer `getByRole`/`getByLabel`/visible text. If an element has no accessible name,
   add an `aria-label` (or `data-testid`) in the component as part of the change.
4. After the run, open the screenshots in `reports/<run>/screenshots/` and look at them
   (layout, empty/error states), and read `desktop-main.log` for main-process errors.
5. Report each check, the screenshot paths with what you saw, and any mismatch between the
   UI and the back end (status, channels, mock requests).
   On a failure, look at `screenshots/*chat-timeout*.png` and the video first: the error
   text includes what the screen showed.
6. For pure visual review the user wants to do by hand, offer `pnpm sandbox run desktop-chat --chain local --keep`
   then `pnpm sandbox desktop`. On a Linux server with Tailscale, offer `pnpm sandbox share` instead:
   the user gets a tailnet link to the running desktop in their browser (see "Share" in
   `e2e/sandbox/README.md`). Give them the printed URL, and remind them that `pnpm sandbox down`
   or `share --stop` ends it.
