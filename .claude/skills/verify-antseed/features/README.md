# AntSeed verification map

This directory is the maintained source for verifying AntSeed's paid request path on the worktree sandbox. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- `.claude/skills/verify-antseed/scripts/doctor.mjs` prints no `FAIL` line.
- Every package the sandbox loads is built from the code under test (doctor checks `dist/` against `src/`).
- No sandbox from this worktree is running with a different topology (`pnpm sandbox status`).
- `--chain local` unless the recipe says otherwise. It deploys this worktree's `packages/contracts` and needs no RPC key.
- The built-in seller config: one OpenAI-compatible mock upstream per seller, fixed usage of 10 input and 8 output tokens, so one chat costs exactly `sb.mockCostPerChat(sellerId, model)` (18 micro-USDC by default).
- The buyer deposits 10 USDC. Each channel reserves at most 1 USDC (`maxReserveAmountUsdc` 1000000).

## Driving conventions

- Drive journeys through a scenario in `e2e/sandbox/scenarios/`. Run it with `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> --chain local`.
- Talk to the buyer the way a client does: `sb.chat()` through the buyer proxy, or `sb.desktop()` through the UI.
- Read state from the buyer (`sb.channels()`), the chain (`sb.buyerBalance()`, `sb.settledEvents()`, `sb.channelState()`) and the upstream (`sb.mockRequests()`).
- Treat every command, check name and handle in the recipes as literal.
- Start every journey on a fresh sandbox. `pnpm sandbox run` reuses a running sandbox with the same topology (same chain, channels and spent deposit), so run `pnpm sandbox down` after any `--keep` or `up`. The evidence helper refuses to run on a running sandbox.

## Proof and skip reporting

- A proof is the run's `checks.log` plus its report directory under `~/.antseed-sandbox/<name>/reports/`.
- Prove the payment side effect (signed amount, on-chain settlement, reserve release), not only the HTTP reply.
- A desktop proof also includes the screenshots and `video/desktop.webm`, and says what they show.
- Report a `KNOWN` result as known, with its issue text.
- If a journey cannot run, report the command you tried and the precondition that was missing. Do not report a journey as verified through a different journey.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with pnpm sandbox` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact call and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Channel open and reserve](./channel-reserve.md) covers the first paid request, the ReserveAuth and the on-chain reserve.
- [Per-request SpendingAuth](./spending-auth.md) covers cumulative signing after each paid request, streaming included.
- [402 catch-up](./payment-catch-up-402.md) covers a seller's budget-exhausted `402` and the buyer's catch-up SpendingAuth (#1200).
- [Close, settle and withdraw](./close-and-withdraw.md) covers cooperative close, settle-on-disconnect and the buyer's unilateral exit.
- [Desktop chat](./desktop-chat.md) covers a paid chat sent from the desktop UI.
- [Routing](./routing.md) covers the buyer's own model-only and pinned routing between sellers.
