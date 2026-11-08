---
name: verify-antseed
description: Prove an AntSeed change works end to end on this worktree's isolated testbench (pnpm testbench: testbench sellers with mock upstreams, the buyer proxy, an Anvil chain, the attach-only desktop under Playwright). Says which scenario a changed path requires, how to launch, drive and tear down the testbench, runs the red-to-green bug protocol with an issue scenario, and files evidence for PR bodies. Opt-in only: use it when the user asks to "verify it in the testbench", "prove it works end to end", "reproduce it in the testbench", "run the testbench", "run a scenario", "open the report", "share the desktop", or invokes /verify-antseed, or when their instructions for the task say to. Do not use it on your own after a code change; unit tests and typecheck are the default.
---

# Verify AntSeed

This skill says what to prove, when a scenario is required, how to run it, and what evidence to keep. It is the only map from a changed path to what must run. `e2e/testbench/README.md` is the reference for every command, chain, option and the `tb` API; `docs/testing.md` maps every kind of test and the result classes.

## When to use it

This skill is opt-in (see `CLAUDE.md`). Use it only when the user asks for testbench verification or their instructions for the task say to. Otherwise verify with builds, unit tests and typecheck, and at most mention which scenario would cover the change.

Once the user has opted in, verify without asking again for each step. That covers builds, unit tests, new scenarios, `pnpm testbench run <scenario> --chain local`, `--chain fork` when doctor reports a fork RPC, and desktop QA runs (`tb.desktop()`, `xvfb-run`).

Get an explicit yes for each run of:

- `--live` (real upstream spend),
- `--real-funds`, `--chain mainnet` and `pnpm testbench mainnet` (real USDC).

These rules hold in every run:

- Never touch `~/.antseed`, the OS keychain, port 8377, or processes the testbench did not start.
- Tear down only with `pnpm testbench down`. Use `--force` only with the user's approval.
- Report a `KNOWN` result as known. Never turn a `knownIssue` into a pass, and never weaken a check to make a run pass.
- Commit and push only as `CLAUDE.md` allows.

## Decide what to prove

When the user has opted in: add a testbench scenario only when a unit test can't reproduce the bug, and run the row the change matches. For any other path, the owning package's unit tests are the proof (`pnpm --filter <pkg> test`). A change to CLI output also gets a transcript (see [Drive](#drive)). `packages/contracts/**` also needs `cd packages/contracts && forge test` and `pnpm testbench run payment-flow --chain local`. `e2e/testbench/**` needs `pnpm test:testbench` and a run of each changed scenario. Run the stress and issue scenarios with `--mode cli`, so they prove the shipped CLI, except `issue-1200-spendingauth-catchup`, which needs `--mode sdk` for its buyer fault. Provider plugins other than `plugins/provider-openai` have no mock upstream, so their unit tests are the proof unless the user approves `--live`. For buyer, buyer-proxy or routing changes, propose the real-network check (`pnpm testbench run mainnet-smoke --chain mainnet --real-funds`, case 3 in `e2e/testbench/README.md`) as a separate step after these runs pass: it spends real USDC and needs an explicit yes.

| If you change… | Run | It's proven when |
| --- | --- | --- |
| buyer payments or SpendingAuth: `packages/buyer-core/**`, `packages/node/src/payments/**`, `packages/node/src/seller-request-handler.ts` | `pnpm --filter @antseed/buyer-core test` (`buyer-payment-negotiator.test.ts`, `channel-usage-accounting.test.ts`, `pricing.test.ts`), `pnpm --filter @antseed/node test tests/buyer-payment-manager.test.ts tests/buyer-payment-negotiator.test.ts tests/payment-flow-integration.test.ts`, then `pnpm testbench run payment-flow --chain local`, `pnpm testbench run stress-smoke --chain local` and every `e2e/testbench/scenarios/issues/issue-*.mjs`; for top-up, reserve, channel rotation, concurrency or restart changes also `stress-c32`, `stress-smallreserve`, `stress-faults`, `stress-restart-buyer` and `stress-restart-seller` (`--chain local`) | All pass and each scenario prints `PASSED`. A `stress-*` run also prints `PASS payment oracle: delivered work paid exactly ...`. For a change that could slow payments, add `--budgets` and read any `DRIFT` lines. |
| the buyer proxy or routing: `apps/cli/src/proxy/**`, `packages/node/src/discovery/**`, `packages/router-core/**`, `plugins/router-local/**` | `pnpm testbench run chat-basic --chain local`. For pinned or multi-seller routing, also `pnpm testbench run routing-smoke --chain local` | Each prints `PASSED`. `chat-basic` sends model-only requests and does not pin; `routing-smoke` pins each of two sellers and auto-routes. |
| the desktop chat UI: `apps/desktop/**` | `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`, then `pnpm testbench run desktop-chat --chain local`. On a headless Linux server or VPS: `xvfb-run -a pnpm testbench run desktop-chat --chain local` | It prints `PASSED`. Open `screenshots/` and `video/desktop.webm` in the report and say what they show. |
| the buyer CLI commands: `apps/cli/src/cli/commands/buyer/**` | `pnpm --filter @antseed/cli test` for the command's test file, then `pnpm testbench run cli-buyer-commands --chain local`; for `withdraw` or `channels request-close`/`withdraw` also `pnpm testbench run buyer-withdraw-and-exit --chain local` | Each prints `PASSED`: the commands exit 0 and match the proxy and the chain. |
| the free tier: `packages/node/src/payments/seller-free-tier-limiter.ts`, `free-tier-*.ts`, `apps/cli/src/cli/commands/buyer/free-tier.ts` | `pnpm --filter @antseed/node test` for the limiter and delegation tests, then `pnpm testbench run free-tier --chain local` | It prints `PASSED`. |
| keys, signing or spend caps: `packages/node/src/p2p/identity.ts`, `packages/protocol/src/signatures.ts`, `apps/desktop/src/main/identity.ts`, `maxPerRequestUsdc`, `maxReserveAmountUsdc` | `pnpm --filter @antseed/node test tests/identity.test.ts tests/evm-keypair.test.ts tests/eip712-contract-compat.test.ts tests/buyer-payment-manager.test.ts` and `pnpm --filter @antseed/protocol test src/signatures.test.ts` | All pass. No testbench scenario covers keys or caps, and `apps/desktop/src/main/identity.ts` has no test. |

When a scenario, a test file or a command named here changes, update its row.

### Gotchas

- `issue-1200-spendingauth-catchup` needs `tb.faults.loseNeedAuths`, armed right before the chat it targets. Without it the scenario passes on buggy code. A delay of about 5 s on a 402 catch-up is the seller waiting (`DEFAULT_CATCH_UP_WAIT_MS`), not a timeout.
- Read `cumulativeSigned` from `tb.channels()` as `BigInt`: `payment:spend` events do not report the negotiator's catch-up.
- Without `topology.payments.minBudgetPerRequestUsdc`, SDK sellers use 0.5 USDC, the amount the #1200 bug over-signs. `stressTopology()` sets the CLI seller's 0.01.
- Waiting does not move Anvil's clock: use `tb.warp`, for example 15 min + 60 s before `withdraw()` after `tb.buyerRequestClose()`. CLI commands that check the time need `tb.cli(args, { clock: 'chain' })`.
- A seller caches the epoch for 10 minutes. After `tb.warpToNextEpoch()`, restart it before it must see a stake that activates in the new epoch.
- `BuyerPaymentManager`'s tests live in `packages/node/tests/`, though the class is in buyer-core.
- Inside an agent's macOS sandbox, the desktop test `Linux afterPack sets the sandbox helper mode` fails with `actual: 493, expected: 2541`. That is the environment: run it outside the sandbox, and never skip or loosen it.

## Launch

1. Put Node 24 and Foundry on `PATH`. `up` refuses other Node majors.
   - macOS: Volta (`export PATH=~/.volta/tools/image/node/<24.x>/bin:$PATH`) or `nvm use`.
   - Linux: `/usr/local/bin` or nvm. Foundry: `export PATH=/usr/local/bin:$HOME/.foundry/bin:$PATH`.
2. Build what the testbench loads. It imports `dist/`, not `src/`.
   - Fresh worktree: `git submodule update --init packages/contracts/lib/forge-std && pnpm install && pnpm run build`.
   - After an edit: rebuild the changed package and its dependents (`pnpm --filter @antseed/buyer-core run build && pnpm --filter @antseed/node run build`), or `pnpm run build`.
   - Desktop scenarios: `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`, plus Playwright's ffmpeg once per machine (`pnpm exec playwright install ffmpeg`; `run` refuses a desktop scenario without it). On a headless Linux server, wrap the run in `xvfb-run -a`.
3. Run `scripts/doctor.mjs` (below) and fix every `FAIL`.
4. Start a run: `pnpm testbench run <scenario> --chain local`. It starts a testbench, runs the scenario, writes a report and stops. Scenarios assume a fresh testbench, so run `pnpm testbench down` before the next run after `--keep` or `up`.
   - Give the command a timeout of at least 10 minutes, or run it in the background: the first `--chain local` run in a worktree compiles the contracts (about 2.5 minutes).
   - Ready means the supervisor printed `READY proxy=http://127.0.0.1:<port> rpc=... control=...`.
   - To poke at a running network: `pnpm testbench up --chain local`, then `eval "$(pnpm -s testbench status --env)" && curl "$ANTSEED_PROXY_URL/v1/models"`.
5. Teardown is `pnpm testbench down` (see [Cleanup](#cleanup)).

Use `--chain local` for contracts, payments and offline work. `--chain fork` runs the production contracts and needs `BASE_MAINNET_RPC_URL` in the gitignored `.env.local`; never fall back to a public RPC. Pass `--chain` explicitly. The other commands you need:

```bash
pnpm -s testbench scenarios                     # every scenario by group, with targets
pnpm -s testbench list | status [--env]         # testbenches on this machine / this worktree's
pnpm testbench logs supervisor|anvil|seller-<id> [--follow]
pnpm testbench report --open | --serve --port 8799   # latest report; --serve binds to loopback
pnpm testbench run <scenario> --trace           # adds a Playwright trace.zip to a desktop run
pnpm testbench desktop                          # hands-on attach-only desktop on a running testbench
pnpm testbench share [--stop]                   # Linux server: the desktop in the user's browser (README, Case 4)
```

A run's `result` is `passed`, `failed`, `error`, `timeout` or `blocked` (exit 0, 1, 4, 3, 2; `docs/testing.md`), `--strict` fails a `KNOWN` result (CI uses it), and anything but `passed` prints a `rerun:` line with the run's seed.

A testbench with a different topology or upstream is refused: run `pnpm testbench down` first or add `--slot NAME`. Never drive a testbench another worktree started.

## Doctor

```bash
.claude/skills/verify-antseed/scripts/doctor.mjs [--slot NAME]
```

Read-only. It checks the Node major against `.nvmrc`, `pnpm`, `anvil`, `forge` with forge-std, whether a fork RPC is configured (without printing it), that every package the testbench loads has `dist/` newer than `src/`, the desktop build, `DISPLAY` or `xvfb-run` on Linux, and the live testbench (chain, upstream, sellers online, peers the buyer sees, open channels). It prints `OK`, `WARN` or `FAIL` lines. It exits 1 on any `FAIL` and 2 outside an AntSeed worktree. Run it before the first drive and whenever a run behaves unexpectedly. A stale `dist/` is the most common reason a fix "does not work" in the testbench.

## High blast radius paths

A change has a high blast radius when it touches one of these paths, or adds or removes a line that matches `maxPerRequestUsdc|maxReserveAmountUsdc`, `signTypedData|SpendingAuth|ReserveAuth` or `privateKey|mnemonic|keychain|keytar`:

- keys and identity: `packages/node/src/p2p/identity.ts`, `packages/node/src/p2p/identity-envelope.ts`, `packages/web-sdk/src/identity.ts`, `apps/desktop/src/main/identity.ts`, `apps/cli/src/cli/wallet-passphrase.ts`
- peer channel and payment frames: `packages/node/src/p2p/secure-channel.ts`, `packages/node/src/p2p/payment-codec.ts`, `packages/node/src/p2p/payment-mux.ts`
- signing and payments: `packages/protocol/src/signatures.ts`, `packages/node/src/payments/**`, `packages/node/src/seller-request-handler.ts`, `packages/buyer-core/**`, `apps/desktop/src/main/payments/**`, `apps/cli/src/gateway/services/operator.ts`, `apps/cli/src/gateway/console-api/handlers/wallet*.ts`
- contracts: `packages/contracts/**`

Such a change always runs the keys, signing or spend caps row, on top of its own row. Its PR body lists the paths it touches under a `## Blast Radius` heading.

## What counts as proof

Show each command, its exit code and the lines that matter. Someone other than the author of the change gives the verdict: a reviewer or an independent agent.

- **Bug fix.** The surface the report names is the proxy, the desktop or the chain, driven the way a user reaches it. When a cheap unit test reproduces the bug, a test-only first commit fails on `main` with the bug's own words (the red signature) and the head passes. When reproducing it needs a seller, the buyer proxy and an on-chain settlement, the red is an `issue-*` testbench scenario per [Fix a bug red to green](#fix-a-bug-red-to-green). Check both with `scripts/prove.sh`. It uses a fresh worktree so local leftovers cannot fake a result, and it rejects a red caused by a setup error such as `Cannot find module`.
  `scripts/prove.sh <first commit> fail "<test command>" "<red signature>" <owning package>`, then `scripts/prove.sh HEAD pass "<test command>" "" <owning package>`.
- **Refactor.** Pin today's behavior with a test first, then check it with `prove.sh <first commit> pass ...` and `prove.sh HEAD pass ...`.
- **User-visible change.** A change to what a user sees in the desktop or the CLI also gets review evidence for the operator. For the desktop, that is the run's screenshots and video, with a screenshot at each changed state (`ui.screenshot(name)` in the scenario). For the CLI, it is the transcript. Name the evidence in the PR's Verification.
- **Every kind.** The matching row of [Decide what to prove](#decide-what-to-prove) passes, and so do the owning packages' checks named in their `CLAUDE.md`.
- **Testbench rows.** Run each required scenario once without the change (a worktree at the base commit) and once with it, doctor first. A scenario that fails the same way without the change is pre-existing: report it, do not block on it, and say whether the change could be involved. A scenario that fails only with the change fails the verification.
- **Blocked.** A doctor `FAIL`, a broken build or a run with `result: 'blocked'` (exit code 2) means the environment, not the change. Report it as blocked, not as failed.

## Drive

- A scenario is a file in `e2e/testbench/scenarios/features/`, `stress/`, `issues/` or `mainnet/` (the real-funds run) with `meta`, `topology` and `run(tb)`. Drive the buyer like a client: `tb.chat()` goes through the buyer proxy, `tb.desktop()` through the desktop UI. Read state with `tb.channels()`, `tb.buyerBalance()`, `tb.settledEvents(id)` and `tb.mockRequests(id)`. Control the network with `tb.stopBuyer()`, `tb.stopSeller(id)` and `tb.warp(seconds)`.
- Assert with `tb.check(name, ok, detail)`. Put the observed and expected values in `detail`: the failing line in the output is the evidence.
- `tb.faults.loseNeedAuths(count)` makes the buyer drop its next `count` seller NeedAuth frames, and `tb.faults.lostNeedAuths()` returns what it dropped since that call. Arming clears the list, and every buyer start disarms the fault. Use a fault only to reach a state that no public path produces, and say why in a comment.
- HTTP: `tb.chat()` drives only `/v1/chat/completions`; use `tb.request()` for other proxy endpoints. Pin a seller with the model `<peerId>@<model>`.
- CLI: in a scenario, `tb.cli(args)` (or `tb.sellerCli(id, args)`) returns `{ code, stdout, stderr, json }` and records the transcript. By hand, for a command with no scenario: `node apps/cli/dist/cli/index.js --data-dir <run>/cli <command> > <run>/cli/<name>.out 2>&1; echo "exit $?" >> <run>/cli/<name>.out`. Always pass `--data-dir`: without it the CLI uses the real `~/.antseed`. For a changed output, show the before and after transcripts.
- Desktop: `const ui = await tb.desktop()`, then `ui.sendChat(prompt)`, `ui.screenshot(name)` and `ui.page` (Playwright). Prefer `getByRole` and `getByLabel`. On a headless Linux server, run `xvfb-run -a pnpm testbench run desktop-chat --chain local`.
- A new desktop scenario goes in `e2e/testbench/scenarios/features/desktop-<name>.mjs` with `requires: ['desktop']`, a `ui.screenshot(name)` at each state and `tb.check('no renderer errors', ui.errors.length === 0, ui.errors)`. If an element has no accessible name, add an `aria-label`. Never launch a desktop outside the testbench commands: it would start its own buyer on the operator's state.
- If you cannot reach an entry point, report the command you tried and the unmet precondition. Do not report it as verified another way.

## Fix a bug red to green

Try a failing unit test in the owning package first. If it reproduces the bug, that test is the red and the green, the fix PR is the failing test plus the fix (steps 5 and 8), and the regressions are the matching row of [Decide what to prove](#decide-what-to-prove). Follow steps 1 to 9 only when a unit test can't reproduce the bug: when it shows only across a seller, the buyer proxy and an on-chain settlement. `issue-1200-spendingauth-catchup.mjs` is the worked example. It proves on-chain what #1200's unit test proves for one method: the seller settles the over-signed amount.

The fix and its issue scenario ship in one PR from `origin/main`, so the regression stays covered from then on.

1. **Make a worktree from `origin/main`:**

   ```bash
   git fetch origin
   git worktree add -b fix/<N>-<slug> ../<repo>-fix-<N> origin/main
   cd ../<repo>-fix-<N>
   git submodule update --init packages/contracts/lib/forge-std && pnpm install && pnpm run build
   ```

2. **Write the scenario first.** Create `e2e/testbench/scenarios/issues/issue-<N>-<slug>.mjs`. Encode the bug as plain `tb.check`s, never `knownIssue`. Start with a fresh-testbench check, as `issue-1200-spendingauth-catchup.mjs` does.
3. **Prove it fails.** Run `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs issue-<N>-<slug> --chain local` on the unfixed code. It must fail on the check that states the issue, with the issue's numbers in `detail`. Keep the report directory. Its `checks.log` is the red evidence. If the scenario will not fail, stop and report why before you change product code.
4. **Find the root cause**, not just the symptom. The runtime evidence here: `pnpm testbench logs supervisor`, `pnpm testbench logs seller-<id>`, the report's `events.jsonl` and `logs/`, and a `--keep` run inspected with `pnpm testbench status`.
5. **Fix it.** Make the smallest fix the evidence justifies. Add a unit test only where one can pin the mechanism the scenario found (no test beats a bad test). Commit only if the user asked for a fix PR (`CLAUDE.md`): first the failing scenario and any failing unit test, then the fix.
6. **Prove it passes.** Rebuild the changed packages (doctor names them) and run `run-with-evidence.mjs issue-<N>-<slug> --chain local` again. It must pass.
7. **Run the regressions:** the matching row of [Decide what to prove](#decide-what-to-prove), plus `chat-basic --chain local` for a payment bug.
8. **Run the owning package's checks**, as its `CLAUDE.md` names them under Prove it.
9. **Tear down:** `pnpm testbench down` in every worktree that ran a testbench.

Paste the red and green `checks.log` lines verbatim into the PR body (see [Evidence](#evidence)). If the bug is sensitive and not fixed yet, keep the scenario and its details out of public branches until the fix ships.

## Evidence

Run scenarios through the evidence helper:

```bash
.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> --chain local [--seed N] [--run-timeout SECONDS] [--keep] [--strict] [--slot NAME]
```

It runs the scenario with those flags and exits with the run's code. It refuses to start while this worktree's testbench is running, and it stops the testbench itself on Ctrl+C. To replay a failure, run its `rerun:` line on a fresh testbench. It adds to the report directory `~/.antseed-testbench/<name>/reports/<timestamp>-<scenario>/`:

- `checks.log`: the `PASS`, `FAIL` and `KNOWN` lines, the error, the run's seed, the report path, and on any result but `passed` the `rerun:` line. Paste these lines into PR bodies.
- `run-output.log`: the whole console transcript.
- `logs/`: the log lines written during this run.

The testbench itself writes `index.html`, `report.json`, `events.jsonl` and `metrics.json` there, plus `screenshots/`, `video/desktop.webm` and `desktop-main.log` for desktop runs. `pnpm testbench down` keeps the whole directory.

Proof standards:

- Drive the real user path: the proxy, the desktop UI, on-chain reads. A fault (`tb.faults`) may set up a precondition. It never stands in for the behavior under test.
- Check the action and the resulting state: what the buyer signed (`tb.channels()`), what settled on-chain (`tb.settledEvents()`, `tb.buyerBalance()`), and what the upstream served (`tb.mockRequests()`). An HTTP 200 alone proves nothing about payments.
- Mocks stand only at the upstream boundary (the seller's provider API).
- For a desktop run, open the screenshots and the video and say what they show.

To show a report from a server: `pnpm testbench report --serve --port 8799` there (it binds to loopback), then `ssh -L 8799:127.0.0.1:8799 <host>`. Never bind to `0.0.0.0`: reports contain wallet addresses and logs. A fix PR body gets the verbatim red and green lines, the regression results and the report directory name.

Report back per scenario: passed or failed, the failing checks with their `detail`, `KNOWN` results as known, `DRIFT` lines, the report path, and whether the testbench is still running.

## Cleanup

- Run `pnpm testbench down` in each worktree (and with each `--slot`) that ran a testbench. `run` without `--keep` stops its own testbench, and `down` on a stopped testbench is harmless.
- Confirm with `pnpm testbench list`: every testbench you started shows `stopped`. `stopping` means channels are still settling: wait for it. `down` is still the teardown, even though a killed run's testbench now stops on its own.
- Never kill by process name, and never stop a testbench another worktree owns.
- Remove a fix worktree only after its PR merges, with `git worktree remove <path>`. Reports live in `~/.antseed-testbench/`, outside the worktree, so they survive the removal.
- Cleanup never deletes `reports/`. After teardown, `ls <report dir>` must still show `checks.log` and `index.html`.

## Helpers

| Script | Invocation | Writes |
| --- | --- | --- |
| `scripts/doctor.mjs` | `.claude/skills/verify-antseed/scripts/doctor.mjs [--slot NAME]` | nothing (read-only) |
| `scripts/prove.sh` | `.claude/skills/verify-antseed/scripts/prove.sh <commit> fail\|pass "<test command>" [red signature] [owning package]` | nothing (a temporary worktree it removes) |
| `scripts/run-with-evidence.mjs` | `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> [run flags]` | `checks.log`, `run-output.log` and `logs/` in the run's report directory |

Run them from the worktree root, or by absolute path from another worktree.

## Gaps

The testbench cannot do these yet. Treat each as a known limit, not as a reason to skip a required run.

When a change touches a feature no scenario covers, say so in the PR: the unit tests are the proof. Close a gap with a scenario that has real checks; never add a scenario without them.

- RPC faults are fixed at `up` (`chain.rpc: 'base'`): nothing changes them during a run or fails one chosen call. The only transport fault is NeedAuth loss.
- `topology.payments.minBudgetPerRequestUsdc` applies to every seller at once, not to one.
- There is no dedicated always-run suite for keys, signing and spend caps.
- No scenario drives card checkout, deposits or withdrawals in the desktop.
- No scenario covers the gateway and its console, or the seller, network and `ants` CLI commands. Capture those transcripts by hand (see [Drive](#drive)).
- Routing services and other routing beyond the buyer's own are not covered.
- `pnpm testbench share` has run on a Linux server, but not through a real Tailscale route.
- Network simulation and failpoints are not part of the testbench yet.
