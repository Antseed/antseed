---
name: verify-antseed
description: Prove an AntSeed change works end to end on this worktree's isolated sandbox (sandbox sellers with mock upstreams, the buyer proxy, an Anvil chain, the attach-only desktop under Playwright). Says which scenario a changed path requires, runs the red-to-green bug protocol with an issue scenario, and files evidence for PR bodies. Use after changing payments, routing, the buyer proxy, buyer-core, packages/node, provider plugins or the desktop, when fixing a bug that needs a sandbox repro, or when asked to "verify", "prove it works" or "reproduce it in the sandbox". Layers on sandbox-test, which owns run mechanics.
---

# Verify AntSeed

This skill says what to prove, when a scenario is required, and what evidence to keep. It is the only map from a changed path to what must run. `features/` is the user-facing feature map (pstack's create-verification-skill shape): one recipe per feature, from the user's point of view, and the table below links each row to it. The **sandbox-test** skill (`.claude/skills/sandbox-test/SKILL.md`) is the how-to for running it: prerequisites, commands, chains, reports, desktop under `xvfb-run`, share. `e2e/sandbox/README.md` is the reference for every command and the `sb` API.

## Autonomy

Once the user has discussed a change, implement and verify it without asking first (pstack's never-block-on-the-human). That covers builds, unit tests, new scenarios, `pnpm sandbox run <scenario> --chain local`, `--chain fork` when doctor reports a fork RPC, and desktop QA runs (`sb.desktop()`, `xvfb-run`).

Get an explicit yes for each run of:

- `--live` (real upstream spend),
- `--real-funds`, `--chain mainnet` and `pnpm sandbox mainnet` (real USDC).

These rules hold in every run:

- Never touch `~/.antseed`, the OS keychain, port 8377, or processes the sandbox did not start.
- Tear down only with `pnpm sandbox down`. Use `--force` only with the user's approval.
- Report a `KNOWN` result as known. Never turn a `knownIssue` into a pass, and never weaken a check to make a run pass (pstack: never relax the predicate).
- Commit and push only as `CLAUDE.md` allows.

## Decide what to prove

Add a sandbox scenario only when a unit test can't reproduce the bug. Every change runs the row it matches. For any other path, the owning package's unit tests are the proof (`pnpm --filter <pkg> test`). A change to CLI output also gets the transcript from [CLI](features/cli.md). `packages/contracts/**` also needs `cd packages/contracts && forge test` and `pnpm sandbox run payment-flow --chain local`. `e2e/sandbox/**` needs `pnpm test:sandbox` and a run of each changed scenario. Provider plugins other than `plugins/provider-openai` have no mock upstream, so their unit tests are the proof unless the user approves `--live`. For buyer, buyer-proxy or routing changes, propose the real-network check (`pnpm sandbox run mainnet-smoke --chain mainnet --real-funds`, case 3 in `e2e/sandbox/README.md`) as a separate step after these runs pass: it spends real USDC and needs an explicit yes.

| If you change… | Run | It's proven when |
| --- | --- | --- |
| buyer payments or SpendingAuth: `packages/buyer-core/**`, `packages/node/src/payments/**`, `packages/node/src/seller-request-handler.ts` | [payments](features/payments.md): `pnpm --filter @antseed/buyer-core test` (`buyer-payment-negotiator.test.ts`, `channel-usage-accounting.test.ts`, `pricing.test.ts`), `pnpm --filter @antseed/node test tests/buyer-payment-manager.test.ts tests/buyer-payment-negotiator.test.ts tests/payment-flow-integration.test.ts`, then `pnpm sandbox run payment-flow --chain local` and every `e2e/sandbox/scenarios/issue-*.mjs` | The tests pass and `payment-flow` prints `PASSED`. That means: three paid chats on one channel with a growing cumulative SpendingAuth, a reserve locked on-chain, settle-on-disconnect that charges exactly the delivered work and releases the reserve, a fresh channel after reconnect, and on-chain settlement equal to what the buyer signed. |
| the buyer proxy or routing: `apps/cli/src/proxy/**`, `packages/node/src/discovery/**`, `packages/router-core/**`, `plugins/router-local/**` | [proxy chat](features/proxy-chat.md) and [routing](features/routing.md): `pnpm sandbox run chat-basic --chain local`. For pinned or multi-seller routing, also `pnpm sandbox run routing-smoke --chain local` | `chat-basic` prints `PASSED`: the catalog lists the seller's models, a non-streaming and a streaming chat through the proxy answer with usage, the upstream saw exactly two chats, one channel holds both receipts, and settlement is exact. `chat-basic` sends model-only requests to one seller and does not pin. `routing-smoke` pins `<peerId>@<model>` to each of two sellers, auto-routes six more chats, and checks that the buyer sees only sandbox sellers. |
| the desktop chat UI: `apps/desktop/**` | [desktop chat](features/desktop-chat.md): `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`, then `pnpm sandbox run desktop-chat --chain local`. On a headless Linux server or VPS: `xvfb-run -a pnpm sandbox run desktop-chat --chain local` | `desktop-chat` prints `PASSED`: the desktop shows `Port: <proxy port>`, a chat sent from the composer shows the sandbox seller's reply, the upstream saw it, the channel signed a nonzero amount, the renderer logged no errors, and settlement is exact. Open `screenshots/` and `video/desktop.webm` in the report and say what they show. |
| keys, signing or spend caps: `packages/node/src/p2p/identity.ts`, `packages/protocol/src/signatures.ts`, `apps/desktop/src/main/identity.ts`, `maxPerRequestUsdc`, `maxReserveAmountUsdc` | `pnpm --filter @antseed/node test tests/identity.test.ts tests/evm-keypair.test.ts tests/eip712-contract-compat.test.ts tests/buyer-payment-manager.test.ts` and `pnpm --filter @antseed/protocol test src/signatures.test.ts` | All pass. These cover identity persistence, the derived EVM wallet, SpendingAuth and ReserveAuth EIP-712 signatures against the contract's typehash and golden vectors, and the overdraft (`verifiedCost + maxPerRequestUsdc`) and reserve-ceiling caps. No sandbox scenario covers keys or caps. There is no dedicated always-run security suite: CI runs every package's tests (`pnpm -r run test`). `apps/desktop/src/main/identity.ts` has no test. |

### Gotchas

- `issue-1200-spendingauth-catchup` needs the lose-NeedAuth fault (`sb.faults.loseNeedAuths`). Without it, the seller's cost-free NeedAuth wins the race against the buyer's 402 negotiator, and the scenario passes on buggy code. Arm the fault right before the chat it targets, and wait for `sb.faults.lostNeedAuths()` to return the dropped frame before you read `cumulativeSigned`. Arming clears that list, and every buyer start disarms the fault.
- The roughly 5-second delay on a 402 catch-up chat is the seller waiting for a catch-up SpendingAuth (`DEFAULT_CATCH_UP_WAIT_MS` in `packages/node/src/seller-request-handler.ts`). It is not a buyer timeout.
- The cooperative-close `knownIssue` checks are stale against `origin/main`. On this branch's base, `payment-flow` reports `KNOWN cooperative close charges exactly the delivered work` (36 settled for 18 delivered) and `chat-basic` reports `KNOWN settled amount equals the cost of delivered work` (54 for 36). After a merge with `origin/main` (checked at 4026643ca) both print `PASS`. Both outcomes are expected. Turn them into plain checks once the sandbox branch includes that fix.
- Pricing is a topology knob (`topology.sellers[].providers.<name>.services.<model>.pricing`, read by `sb.mockCostPerChat()`). A seller's `minBudgetPerRequest` is not. Scenarios get the default of 0.5 USDC, which is the amount the #1200 bug over-signs (500018 signed for 54 delivered).
- When doctor flags a stale `dist/`, run `pnpm run build`, or the changed package's build plus its dependents. The sandbox loads `dist/`, so an unbuilt fix looks like a fix that does not work.
- The `BuyerPaymentManager` tests live in `packages/node/tests/`, not in `packages/buyer-core`. The class moved to buyer-core, and `packages/node/src/payments/buyer-payment-manager.ts` re-exports it.
- On this base, `payment:spend` events do not report the negotiator's catch-up. Read `cumulativeSigned` from `sb.channels()` instead. It is a decimal string of micro-USDC, so compare it as `BigInt`.
- Inside an agent's Bash sandbox (macOS Seatbelt), the desktop test `Linux afterPack sets the sandbox helper mode before archiving` fails with `actual: 493, expected: 2541`: the sandbox refuses the setuid bit. That is the environment, not the change. Run `pnpm --filter @antseed/desktop test` outside the sandbox (the operator's shell or CI) for that one result, and never skip or loosen the test.
- `--chain fork` runs the production contracts. A contract change shows up only on `--chain local`.
- `withdraw()` after `sb.buyerRequestClose()` needs `sb.warp(15 * 60 + 60)` first. Waiting in wall-clock time does not move Anvil's clock.
- A desktop chat that times out saves `screenshots/chat-timeout.png` and puts the visible screen text in the error. Read those and the video before you change the scenario.

## Launch

1. Put Node 24 and Foundry on `PATH`. `up` refuses other Node majors.
   - macOS: Volta (`export PATH=~/.volta/tools/image/node/<24.x>/bin:$PATH`) or `nvm use`.
   - Linux: `/usr/local/bin` or nvm. Foundry: `export PATH=/usr/local/bin:$HOME/.foundry/bin:$PATH`.
2. Build what the sandbox loads. It imports `dist/`, not `src/`.
   - Fresh worktree: `git submodule update --init packages/contracts/lib/forge-std && pnpm install && pnpm run build`.
   - After an edit: rebuild the changed package and its dependents (`pnpm --filter @antseed/buyer-core run build && pnpm --filter @antseed/node run build`), or `pnpm run build`.
   - Desktop scenarios: `pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`.
3. Run `scripts/doctor.mjs` (below) and fix every `FAIL`.
4. Start a run: `pnpm sandbox run <scenario> --chain local`. With no sandbox running, it starts one with the scenario's topology, runs the scenario, writes a report, and stops the sandbox. If this worktree's sandbox is already running with the same topology, `run` reuses it: same chain, same channels, and it stays up afterwards. Scenarios assume a fresh sandbox, so run `pnpm sandbox down` before the next run after `--keep` or `up`. The evidence helper refuses to run on a running sandbox.
   - Give the Bash tool a timeout of at least 10 minutes for a run, or run it in the background. The default 2-minute timeout kills a first run mid-compile.
   - Ready means the supervisor printed `READY proxy=http://127.0.0.1:<port> rpc=... control=...`. The buyer has discovered every seller by then.
   - The first `--chain local` run in a worktree compiles `packages/contracts` (about 2.5 minutes). Later runs reach `READY` in about 5 seconds. `chat-basic` takes about 10 seconds end to end and `payment-flow` about a minute.
   - To poke at a running network: `pnpm sandbox up --chain local`, then `eval "$(pnpm -s sandbox status --env)" && curl "$ANTSEED_PROXY_URL/v1/models"`.
5. Teardown is `pnpm sandbox down` (see [Cleanup](#cleanup)).

Each worktree gets its own sandbox (`wt-<basename>-<hash>`, state in `~/.antseed-sandbox/<name>/`). If a sandbox with another topology is running, `run` refuses: run `pnpm sandbox down` first or add `--slot NAME`. Never drive a sandbox another worktree started.

## Doctor

```bash
.claude/skills/verify-antseed/scripts/doctor.mjs [--slot NAME]
```

Read-only. It checks the Node major against `.nvmrc`, `pnpm`, `anvil`, `forge` with forge-std, whether a fork RPC is configured (without printing it), that every package the sandbox loads has `dist/` newer than `src/`, the desktop build, `DISPLAY` or `xvfb-run` on Linux, and the live sandbox (chain, upstream, sellers online, peers the buyer sees, open channels). It prints `OK`, `WARN` or `FAIL` lines. It exits 1 on any `FAIL` and 2 outside an AntSeed worktree. Run it before the first drive and whenever a run behaves unexpectedly. A stale `dist/` is the most common reason a fix "does not work" in the sandbox.

## Money and key paths

A change is on a money or key path when it touches one of these paths, or adds or removes a line that matches `maxPerRequestUsdc|maxReserveAmountUsdc`, `signTypedData|SpendingAuth|ReserveAuth` or `privateKey|mnemonic|keychain|keytar`:

- keys and identity: `packages/node/src/p2p/identity.ts`, `packages/node/src/p2p/identity-envelope.ts`, `packages/web-sdk/src/identity.ts`, `apps/desktop/src/main/identity.ts`, `apps/cli/src/cli/wallet-passphrase.ts`
- peer channel and payment frames: `packages/node/src/p2p/secure-channel.ts`, `packages/node/src/p2p/payment-codec.ts`, `packages/node/src/p2p/payment-mux.ts`
- signing and payments: `packages/protocol/src/signatures.ts`, `packages/node/src/payments/**`, `packages/node/src/seller-request-handler.ts`, `packages/buyer-core/**`, `apps/desktop/src/main/payments/**`, `apps/cli/src/gateway/services/operator.ts`, `apps/cli/src/gateway/console-api/handlers/wallet*.ts`
- contracts: `packages/contracts/**`

Such a change always runs the keys, signing or spend caps row, on top of its own row. Its PR body has a line `Money and key paths: <paths>` naming which ones it touches.

## What counts as proof

pstack's playbooks say what proof each kind of change needs (Bug fix steps 1, 4 and 5, Refactoring, Feature step 5, the tdd skill) and who gives the verdict (Shipping step 1). This section adds only AntSeed's surfaces and commands. Show each command, its exit code and the lines that matter.

- **Bug fix.** The surface the report names is the proxy, the desktop or the chain, driven through its feature recipe. When a cheap unit test reproduces the bug, a test-only first commit fails on `main` with the bug's own words (the red signature) and the head passes, per Bug fix step 5. When reproducing it needs a seller, the buyer proxy and an on-chain settlement, the red is an `issue-*` sandbox scenario per [Fix a bug red to green](#fix-a-bug-red-to-green). Check both with `scripts/prove.sh`. It uses a fresh worktree so local leftovers cannot fake a result, and it rejects a red caused by a setup error such as `Cannot find module`.
  `scripts/prove.sh <first commit> fail "<test command>" "<red signature>" <owning package>`, then `scripts/prove.sh HEAD pass "<test command>" "" <owning package>`.
- **Refactor.** Pin today's behavior first (Refactoring), then check it with `prove.sh <first commit> pass ...` and `prove.sh HEAD pass ...`.
- **User-visible change.** A change to what a user sees in the desktop or the CLI also gets review evidence for the operator. For the desktop, that is the run's screenshots and video plus an agent-browser walk through the changed screens (`pnpm sandbox desktop --cdp-port N`, recipe in [desktop chat](features/desktop-chat.md)). For the CLI, it is the transcript. Name the evidence in the PR's Verification.
- **Every kind.** The matching row of [Decide what to prove](#decide-what-to-prove) passes, and so do the owning packages' checks named in their `CLAUDE.md`.
- **Sandbox rows.** Run each required scenario once without the change and once with it, in the scratch worktree, doctor first. A scenario that fails the same way without the change is pre-existing: report it, do not block on it, and say whether the change could be involved. A scenario that fails only with the change fails the verification.
- **Blocked.** A doctor `FAIL` or a broken build means the environment, not the change. Report it as blocked (`verifier-blocked`), not as failed.

## Drive

- A scenario is `e2e/sandbox/scenarios/<name>.mjs` with `meta`, `topology` and `run(sb)`. Drive the buyer like a client: `sb.chat()` goes through the buyer proxy, `sb.desktop()` through the desktop UI. Read state with `sb.channels()`, `sb.buyerBalance()`, `sb.settledEvents(id)` and `sb.mockRequests(id)`. Control the network with `sb.stopBuyer()`, `sb.stopSeller(id)` and `sb.warp(seconds)`.
- Assert with `sb.check(name, ok, detail)`. Put the observed and expected values in `detail`: the failing line in the output is the evidence.
- `sb.faults.loseNeedAuths(count)` makes the buyer drop its next `count` seller NeedAuth frames, and `sb.faults.lostNeedAuths()` returns what it dropped since that call. Arming clears the list, and every buyer start disarms the fault. Use a fault only to reach a state that no public path produces, and say why in a comment.
- Desktop: `const ui = await sb.desktop()`, then `ui.sendChat(prompt)`, `ui.screenshot(name)` and `ui.page` (Playwright). Prefer `getByRole` and `getByLabel`. On a headless Linux server, run `xvfb-run -a pnpm sandbox run desktop-chat --chain local`. Without `--chain`, `desktop-chat`, `chat-basic` and `routing-smoke` run on their first target, the fork.

## Fix a bug red to green

Try a failing unit test in the owning package first. If it reproduces the bug, that test is the red and the green, the fix PR is the failing test plus the fix (steps 5 and 8), and the regressions are the matching row of [Decide what to prove](#decide-what-to-prove). Follow steps 1 to 9 only when a unit test can't reproduce the bug: when it shows only across a seller, the buyer proxy and an on-chain settlement. `issue-1200-spendingauth-catchup.mjs` is the worked example. It proves on-chain what #1200's unit test proves for one method: the seller settles the over-signed amount.

The sandbox lives on a sandbox branch, not on `main`. The fix lives on a branch from `origin/main`. A scratch worktree combines both for the sandbox runs and is never pushed.

1. **Make the scratch worktree.** Branch it from the sandbox branch. If the sandbox branch is behind `origin/main`, merge `origin/main` into the scratch branch, so red and green run on the code the fix PR targets:

   ```bash
   git worktree add -b scratch/<N> ../<repo>-<N>-scratch <sandbox-branch>
   cd ../<repo>-<N>-scratch
   git fetch origin
   git merge-base --is-ancestor origin/main HEAD || git merge origin/main
   git submodule update --init packages/contracts/lib/forge-std && pnpm install && pnpm run build
   ```

   Resolve merge conflicts minimally and record each resolution. `CHANGELOG.md` conflicts most often.
2. **Write the scenario first.** In the scratch worktree, create `e2e/sandbox/scenarios/issue-<N>-<slug>.mjs`. Encode the bug as plain `sb.check`s, never `knownIssue`. Start with a fresh-sandbox check, as `issue-1200-spendingauth-catchup.mjs` does. Add the name to the scenario list in `e2e/sandbox/test/config-topology.test.mjs`.
3. **Prove it fails.** Run `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs issue-<N>-<slug> --chain local` on the unfixed code. It must fail on the check that states the issue, with the issue's numbers in `detail`. Keep the report directory. Its `checks.log` is the red evidence. If the scenario will not fail, stop and report why before you change product code.
4. **Find the root cause** (pstack's Bug fix and fix-root-causes). The runtime evidence here: `pnpm sandbox logs supervisor`, `pnpm sandbox logs seller-<id>`, the report's `events.jsonl` and `logs/`, and a `--keep` run inspected with `pnpm sandbox status`.
5. **Fix it in a worktree from `origin/main`.** Make the smallest fix the evidence justifies. Add a unit test only where one can pin the mechanism the scenario found (pstack's tdd: no test beats a bad test):

   ```bash
   git fetch origin
   git worktree add -b fix/<N>-<slug> ../<repo>-fix-<N> origin/main
   ```

   Never create the fix branch inside the scratch worktree: the untracked scenario would follow it. Commit only if the user asked for a fix PR (`CLAUDE.md`). With a unit test, the PR has two commits, the failing test and then the fix. Without that request, leave the fix uncommitted.
6. **Prove it passes.** Bring the fix into the scratch worktree, rebuild, and rerun the scenario. It must pass.
   - Committed fix: `git cherry-pick <test-sha> <fix-sha>`.
   - Uncommitted fix: `git -C ../<repo>-fix-<N> add -N . && git -C ../<repo>-fix-<N> diff --binary HEAD | git apply`. Plain `git diff` leaves out new files (the new unit test) and staged changes. Check that `git status --short` in the scratch lists every file the fix changed.
   - Rebuild the changed packages (doctor names them), then run `run-with-evidence.mjs issue-<N>-<slug> --chain local`.
7. **Run the regressions** in the scratch worktree: the matching row of [Decide what to prove](#decide-what-to-prove), plus `chat-basic --chain local` for a payment bug. The cooperative-close `KNOWN` results are expected (see [Gotchas](#gotchas)).
8. **Run the owning package's checks** in the fix worktree, as its `CLAUDE.md` names them under Prove it.
9. **Tear down:** `pnpm sandbox down` in every worktree that ran a sandbox.

Sandbox files never go into the fix PR. The issue scenario lands on the sandbox branch in its own commit, when the user asks for one. Paste the red and green `checks.log` lines verbatim into the PR body (see [Evidence](#evidence)).

## Evidence

Run scenarios through the evidence helper:

```bash
.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> --chain local [--keep] [--strict] [--slot NAME]
```

It runs `node e2e/sandbox/cli.mjs run` (what `pnpm sandbox run` runs) with the same flags, shows the output, and exits with the run's code. It refuses to start while this worktree's sandbox is running or starting. On Ctrl+C, SIGTERM or SIGHUP it stops the run, then runs `node e2e/sandbox/cli.mjs down` itself, because the killed run never reaches its own teardown and the supervisor runs detached. It still files the transcript: into the report directory if the scenario had started, else into `~/.antseed-sandbox/<name>/logs/evidence-<timestamp>-<scenario>.log`. It adds three things to the report directory `~/.antseed-sandbox/<name>/reports/<timestamp>-<scenario>/`:

- `checks.log`: the `PASS`, `FAIL` and `KNOWN` lines, the error, and the report path. Paste these lines into PR bodies.
- `run-output.log`: the whole console transcript.
- `logs/`: the supervisor, seller, Anvil and forge log lines written during the run. The sandbox appends to its logs across runs, so these are the only per-run copy.

The sandbox itself writes `index.html`, `report.json`, `events.jsonl` and `metrics.json` there, plus `screenshots/`, `video/desktop.webm` and `desktop-main.log` for desktop runs. `pnpm sandbox down` keeps the whole directory.

Proof standards:

- Drive the real user path: the proxy, the desktop UI, on-chain reads. A fault (`sb.faults`) may set up a precondition. It never stands in for the behavior under test.
- Check the action and the resulting state: what the buyer signed (`sb.channels()`), what settled on-chain (`sb.settledEvents()`, `sb.buyerBalance()`), and what the upstream served (`sb.mockRequests()`). An HTTP 200 alone proves nothing about payments.
- Mocks stand only at the upstream boundary (the seller's provider API).
- For a desktop run, open the screenshots and the video and say what they show.

To show a report from a server, start `pnpm sandbox report --serve --port 8799` there (it binds to loopback). The reader runs `ssh -L 8799:127.0.0.1:8799 <host>` and opens `http://127.0.0.1:8799/`. Never bind to `0.0.0.0`: reports contain wallet addresses and logs. A fix PR body gets the verbatim red and green lines, the regression results, and the report directory name, not the files.

## Cleanup

- Run `pnpm sandbox down` in each worktree (and with each `--slot`) that ran a sandbox. `run` without `--keep` stops its own sandbox, and `down` on a stopped sandbox is harmless.
- Confirm with `pnpm sandbox list`: every sandbox you started shows `stopped`.
- Never kill by process name, and never stop a sandbox another worktree owns.
- Remove a scratch worktree only after its PR merges, with `git worktree remove <path>`. Reports live in `~/.antseed-sandbox/`, outside the worktree, so they survive the removal.
- Cleanup never deletes `reports/`. After teardown, `ls <report dir>` must still show `checks.log` and `index.html`.

## Helpers

| Script | Invocation | Writes |
| --- | --- | --- |
| `scripts/doctor.mjs` | `.claude/skills/verify-antseed/scripts/doctor.mjs [--slot NAME]` | nothing (read-only) |
| `scripts/prove.sh` | `.claude/skills/verify-antseed/scripts/prove.sh <commit> fail\|pass "<test command>" [red signature] [owning package]` | nothing (a temporary worktree it removes) |
| `scripts/run-with-evidence.mjs` | `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> [run flags]` | `checks.log`, `run-output.log` and `logs/` in the run's report directory |

Run them from the worktree root, or by absolute path from another worktree.

## Gaps

The sandbox cannot do these yet. Treat each as a known limit, not as a reason to skip a required run.

- **Seller payment knobs.** A topology cannot set a seller's `minBudgetPerRequest`, so scenarios get the default (0.5 USDC). Per-model pricing is settable: `topology.sellers[].providers.<name>.services.<model>.pricing`, which `sb.mockCostPerChat()` reads.
- **`sb.request()` for other endpoints.** `sb.chat()` drives only `/v1/chat/completions`. No helper drives `/v1/responses`.
- **RPC fault injection.** No proxy sits between the nodes and Anvil to delay, drop or fail RPC calls.
- **Transport faults.** The only fault is NeedAuth loss, and it wraps the buyer payment manager's public `handleNeedAuth`. No public setting leaves a buyer under-signed: the buyer's `costToleranceMultiplier` is not in the node's payment config, and the sandbox fixes `maxPerRequestUsdc` at 5 USDC. A frame-level fault on the payment channel between buyer and seller would be cleaner.
- **Money and key path tests.** There is no dedicated always-run suite for keys, signing and spend caps. CI runs every package's tests, and the desktop's `apps/desktop/src/main/identity.ts` has no test.
- **Checkout and wallet flows.** No harness drives the card checkout, deposits or withdrawals in the desktop.
- **Gateway.** No scenario covers `apps/cli/src/gateway/**` or its console. Its unit tests and typecheck are the proof, and the PR says no scenario proves it.
- **CLI driver.** No scenario drives the CLI. [CLI](features/cli.md) captures a transcript by hand.
- **Routing beyond the buyer's own routing.** `routing-smoke` covers model-only and pinned routing between sandbox sellers. Scenarios for routing services and other routing behavior live elsewhere.
- **`mainnet-smoke` has never run funded.** Case 3 is untested with a real wallet.
- **`pnpm sandbox share` is untested on a real server with Tailscale.**
- **Network simulation and failpoints** are separate branches, not in this sandbox.
- **Desktop on headless Linux.** On a Debian VPS under `xvfb-run -a`, `desktop-chat` timed out at `page.waitForLoadState` and the run never exited after the failed launch (the Electron process tree stayed up until killed). The cause is unverified; `--disable-gpu` does not fix it. Give `desktop-chat` a hard deadline there and report a timeout as blocked.

## Keep this skill honest

When a scenario, a test file or a command named in [Decide what to prove](#decide-what-to-prove) changes, update its row. pstack's maintain-verification-skill audits `features/` against the code: run it with this skill's path (`.claude/skills/verify-antseed`). When a feature changes, update its file, and add a file for a new user-facing feature.
