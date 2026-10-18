---
name: verify-antseed
description: Prove an AntSeed change works end to end on this worktree's isolated sandbox (sandbox sellers with mock upstreams, the buyer proxy, an Anvil chain, the attach-only desktop under Playwright). Says which scenario a changed path requires, runs the red-to-green bug protocol with an issue scenario, and files evidence for PR bodies. Use after changing payments, routing, the buyer proxy, buyer-core, packages/node, provider plugins or the desktop, when fixing a bug that needs a sandbox repro, or when asked to "verify", "prove it works" or "reproduce it in the sandbox". Layers on sandbox-test, which owns run mechanics.
---

# Verify AntSeed

This skill says what to prove, when a scenario is required, and what evidence to keep. The **sandbox-test** skill (`.claude/skills/sandbox-test/SKILL.md`) owns the run mechanics: cases, scenario lists, report reading. `e2e/sandbox/README.md` is the reference for every command and the `sb` API. The feature map in [`features/README.md`](features/README.md) holds one recipe per user journey.

## Autonomy

Once the user has discussed a change, implement and verify it without asking first. That covers builds, unit tests, new scenarios, `pnpm sandbox run <scenario> --chain local`, `--chain fork` when doctor reports a fork RPC, and desktop QA runs (`sb.desktop()`, `xvfb-run`).

Get an explicit yes for each run of:

- `--live` (real upstream spend),
- `--real-funds`, `--chain mainnet` and `pnpm sandbox mainnet` (real USDC).

These rules hold in every run:

- Never touch `~/.antseed`, the OS keychain, port 8377, or processes the sandbox did not start.
- Tear down only with `pnpm sandbox down`. Use `--force` only with the user's approval.
- Report a `KNOWN` result as known. Never turn a `knownIssue` into a pass, and never weaken a check to make a run pass.
- Never commit or push unless asked (`CLAUDE.md`).

## Decide what to prove

A sandbox scenario is required only when a changed path appears in this table. The first matching row wins. For every other path, a unit test in the owning package is enough (`pnpm --filter <pkg> test`). This table is the required minimum. The table in **sandbox-test** step 2 adds broader runs and says when to propose the real-network check.

| Changed path | Required runs (all `--chain local`) |
| --- | --- |
| `packages/buyer-core/**`, `packages/node/src/payments/**`, `packages/node/src/seller-request-handler.ts`, `packages/node/src/storage/migrations/**` | `payment-flow`, `chat-basic`, every `issue-*` scenario |
| `packages/contracts/**` | `forge test`, then `payment-flow`, `chat-basic`, every `issue-*` scenario |
| `packages/node/src/discovery/**`, `packages/router-core/**`, `plugins/router-local/**`, `apps/cli/src/proxy/**` | `routing-smoke`, `chat-basic` |
| other `packages/node/src/**` | `chat-basic`, `routing-smoke` |
| `packages/provider-core/**`, `plugins/provider-openai/**` | `chat-basic` |
| `apps/desktop/src/main/runtime/**` (the desktop buyer) | `desktop-chat`, `chat-basic` |
| other `apps/desktop/**` | `desktop-chat`, plus a `desktop-<feature>` scenario for a UI path no scenario drives |
| `e2e/sandbox/**` | `pnpm test:sandbox`, then each changed scenario |

Run `ls e2e/sandbox/scenarios/issue-*.mjs` for the `issue-*` scenarios. Each one guards a fixed payment bug. A bug fix in a mapped path also needs an issue scenario (see [Fix a bug red to green](#fix-a-bug-red-to-green)). A bug in an unmapped path gets a failing unit test first. Other provider plugins cannot be mocked (the mock is OpenAI-compatible only), so their unit tests are the proof unless the user approves `--live`.

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

## Drive

- A scenario is `e2e/sandbox/scenarios/<name>.mjs` with `meta`, `topology` and `run(sb)`. Drive the buyer like a client: `sb.chat()` goes through the buyer proxy, `sb.desktop()` through the desktop UI. Read state with `sb.channels()`, `sb.buyerBalance()`, `sb.settledEvents(id)` and `sb.mockRequests(id)`. Control the network with `sb.stopBuyer()`, `sb.stopSeller(id)` and `sb.warp(seconds)`.
- Assert with `sb.check(name, ok, detail)`. Put the observed and expected values in `detail`: the failing line in the output is the evidence.
- `sb.faults.loseNeedAuths(count)` makes the buyer drop its next `count` seller NeedAuth frames, and `sb.faults.lostNeedAuths()` returns what it dropped since that call. Arming clears the list, and every buyer start disarms the fault. Use a fault only to reach a state that no public path produces, and say why in a comment.
- Desktop: `const ui = await sb.desktop()`, then `ui.sendChat(prompt)`, `ui.screenshot(name)` and `ui.page` (Playwright). Prefer `getByRole` and `getByLabel`. On a headless Linux server, run `xvfb-run -a pnpm sandbox run desktop-chat --chain local`. Without `--chain`, `desktop-chat`, `chat-basic` and `routing-smoke` run on their first target, the fork.
- Journeys with exact steps: [`features/README.md`](features/README.md).

## Fix a bug red to green

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
4. **Find the root cause.** Form hypotheses and rule them out with runtime evidence: `pnpm sandbox logs supervisor`, `pnpm sandbox logs seller-<id>`, the report's `events.jsonl` and `logs/`, and a `--keep` run inspected with `pnpm sandbox status`.
5. **Fix it in a worktree from `origin/main`.** Write a failing unit test in the owning package, then the smallest fix that the evidence justifies:

   ```bash
   git fetch origin
   git worktree add -b fix/<N>-<slug> ../<repo>-fix-<N> origin/main
   ```

   Never create the fix branch inside the scratch worktree: the untracked scenario would follow it. Commit only if the user asked for a fix PR (`CLAUDE.md`). Then the PR has two commits, the failing test and then the fix. Without that request, leave the fix uncommitted.
6. **Prove it passes.** Bring the fix into the scratch worktree, rebuild, and rerun the scenario. It must pass.
   - Committed fix: `git cherry-pick <test-sha> <fix-sha>`.
   - Uncommitted fix: `git -C ../<repo>-fix-<N> add -N . && git -C ../<repo>-fix-<N> diff --binary HEAD | git apply`. Plain `git diff` leaves out new files (the new unit test) and staged changes. Check that `git status --short` in the scratch lists every file the fix changed.
   - Rebuild the changed packages (doctor names them), then run `run-with-evidence.mjs issue-<N>-<slug> --chain local`.
7. **Run the regressions** in the scratch worktree: the required runs for the fixed path from [Decide what to prove](#decide-what-to-prove), at least `payment-flow --chain local` and `chat-basic --chain local` for a payment bug. Each reports one `KNOWN` result for the cooperative close defect:
   - `payment-flow`: `KNOWN cooperative close charges exactly the delivered work`, settled 36 against 18 delivered.
   - `chat-basic`: `KNOWN settled amount equals the cost of delivered work`, settled 54 against 36 delivered.

   Unless the issue is about that defect, these `KNOWN` results are expected. After a merge with `origin/main` (checked at 4026643ca), both checks print `PASS` instead: `main` no longer settles the extra request. Both outcomes are expected. Once the sandbox branch includes that fix, turn the two `knownIssue` calls into plain checks.
8. **Run the owning package's checks** in the fix worktree: `pnpm --filter <pkg> test` and `pnpm --filter <pkg> run typecheck`.
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
| `scripts/run-with-evidence.mjs` | `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> [run flags]` | `checks.log`, `run-output.log` and `logs/` in the run's report directory |

Run both from the worktree root.

## Gaps

The sandbox cannot do these yet. Treat each as a known limit, not as a reason to skip a required run.

- **Seller payment knobs.** A topology cannot set a seller's `minBudgetPerRequest`, so scenarios get the default (0.5 USDC). Per-model pricing is settable: `topology.sellers[].providers.<name>.services.<model>.pricing`, which `sb.mockCostPerChat()` reads.
- **`sb.request()` for other endpoints.** `sb.chat()` drives only `/v1/chat/completions`. No helper drives `/v1/responses`.
- **RPC fault injection.** No proxy sits between the nodes and Anvil to delay, drop or fail RPC calls.
- **Transport faults.** The only fault is NeedAuth loss, and it wraps the buyer payment manager's public `handleNeedAuth` (see [`features/payment-catch-up-402.md`](features/payment-catch-up-402.md)). A frame-level fault on the payment channel between buyer and seller would be cleaner.
- **Checkout and wallet flows.** No harness drives the card checkout, deposits or withdrawals in the desktop.
- **Routing beyond the buyer's own routing.** `routing-smoke` covers model-only and pinned routing between sandbox sellers. Scenarios for routing services and other routing behavior live elsewhere.
- **`mainnet-smoke` has never run funded.** Case 3 is untested with a real wallet.
- **`pnpm sandbox share` is untested on a real server with Tailscale.**
- **Network simulation and failpoints** are separate branches, not in this sandbox.

## Keep the map honest

When a feature's entry point or a scenario changes, update the matching file in `features/`. If the pstack plugin is installed, its `/maintain-verification-skill` skill audits this skill and its feature map against the code. Run it when the map looks stale.
