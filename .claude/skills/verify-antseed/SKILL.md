---
name: verify-antseed
description: Says which checks prove an AntSeed change and what counts as proof, from a one-minute smoke run through the real buyer proxy, the package tests, the local-chain payment flow and the stress job. Use when verifying a change, or when asked to "verify it", "prove it works" or "reproduce this bug". Not for runs that spend real funds or touch mainnet.
---

# Verify AntSeed

## Setup

- Use Node 24 (`.nvmrc`). On another major version, native modules fail with `ERR_DLOPEN_FAILED`. That is the environment, not the change.
- E2E tests and flows load `dist/`, so run `pnpm run build` after an edit.
- Contracts need Foundry and `git submodule update --init packages/contracts/lib/forge-std`.

## Doctor

Run these from the repo root when you start, and again if anything looks off.

```bash
node -v                                   # must print v24
command -v anvil cast forge               # must print all three
test -f apps/cli/dist/cli/index.js && echo built
```

## Smoke run

This is the fastest proof through the real app. Use it for any change to the buyer, seller, payments or contracts, then add the matching row below.

```bash
node e2e/stress/ci.mjs --scenarios smoke --out "$(mktemp -d)/antseed-verify"
```

It starts a local chain, a mock upstream and the real `antseed` seller and buyer from `dist/` with their own data dirs and homes. It sends 6 chats through the buyer proxy, closes the channel and compares what was delivered, signed and settled. It takes about a minute, longer if the contracts need compiling.

It passes when it exits 0 and the `smoke` row shows ✅. A pass means every chat was answered, and the amounts delivered, signed and settled all match, with nothing unpaid or overpaid.

## What to run

Every change runs the owning package's `test` and `typecheck`. Add the matching row.

| If you change | Run | Proven when |
| --- | --- | --- |
| Buyer payments: `packages/buyer-core/**`, `packages/node/src/payments/**`, `packages/node/src/seller-request-handler.ts` | `pnpm --filter @antseed/buyer-core test`, `pnpm --filter @antseed/node exec vitest run tests/buyer-payment-manager.test.ts tests/buyer-payment-negotiator.test.ts tests/payment-flow-integration.test.ts`, the payment flow, the stress job | All pass |
| Buyer proxy or routing: `apps/cli/src/proxy/**`, `packages/node/src/discovery/**`, `packages/router-core/**`, `plugins/router-local/**` | `pnpm --filter @antseed/cli test`, `pnpm --filter @antseed/router-core test`, `pnpm --filter @antseed/e2e exec vitest run tests/router-selection.test.ts tests/routing-payment-flow.test.ts`, the payment flow, the stress job | All pass |
| Contracts: `packages/contracts/**` | `cd packages/contracts && forge test`, the payment flow | All pass |
| Desktop: `apps/desktop/**` | `pnpm --filter @antseed/desktop test`, `pnpm --filter @antseed/desktop run test:renderer`, `pnpm --filter @antseed/desktop run typecheck:renderer` | All pass, and a person has tried a visible change |
| Keys, signing or spend caps: `packages/node/src/p2p/identity.ts`, `packages/protocol/src/signatures.ts`, `apps/desktop/src/main/identity.ts`, `maxPerRequestUsdc`, `maxReserveAmountUsdc` | `pnpm --filter @antseed/node exec vitest run tests/identity.test.ts tests/evm-keypair.test.ts tests/eip712-contract-compat.test.ts tests/buyer-payment-manager.test.ts`, `pnpm --filter @antseed/protocol exec vitest run src/signatures.test.ts` | All pass |

### Payment flow

```bash
anvil &
node e2e/scripts/full-payment-flow.mjs
```

It deploys the contracts, runs a real seller and buyer in temp data dirs, sends paid requests and settles. All 9 phases must print `PASS`. Stop `anvil` afterwards. The first run compiles the contracts, which can take several minutes, so give it a long timeout.

It proves the seller was paid and the reserve was released. It does not check the exact amount, and it calls the node directly, so it never goes through the buyer proxy.

### Stress job

```bash
pnpm --filter @antseed/e2e run stress
```

It runs the real `antseed` seller and buyer from `dist/` with their own data dirs, and sends requests through the buyer proxy on a local chain. It takes about 10 minutes. Every scenario must report `viol=none` and `settled` equal to `expected`. This is the check for exact amounts. To rerun one scenario: `node e2e/stress/ci.mjs --scenarios <name>`.

It sometimes fails on `main` with `served-unpaid`, seen on `restart-seller` and `smallreserve`. Report that with the scenario and numbers, even if a rerun passes.

## Evidence

The smoke run prints its `--out` directory. Keep it, and report from it:

- `runs/smoke-1/result.json`: `client`, `money`, `channels` and `violations`. `buyerTreeInfo` shows which commit and build ran.
- `runs/smoke-1/requests.json`: each request's `stream`, `status` and `usage`. Streamed requests have no `usage`.
- `runs/smoke-1/buyer.log` and `seller.log`.

`--out` wipes its directory first, so give every run a new one. The directory also holds throwaway test keys, so quote from it and don't commit it.

## Cleanup

The smoke run stops everything it started, also when it fails, and leaves the evidence. Stop `anvil` yourself after the payment flow. Never kill by process name: other checkouts and the user's own buyer may be running here. Stop only the PIDs you started.

## What counts as proof

- Show each command, its exit code and the lines that matter.
- **Bug fix:** reproduce it first, with a unit test if one can. It must fail with the reported symptom before the fix and pass after it.
- **Payments:** an HTTP 200 proves nothing. Check what the buyer signed and what settled.
- **User-visible change:** give a CLI transcript or a desktop screenshot.
- **Fails the same way on `main`:** it is pre-existing. Report it, and don't block on it.
- **Broken build or environment:** report it as blocked, not failed.

## Gotchas

- `BuyerPaymentManager` lives in `packages/buyer-core`, but its tests are in `packages/node/tests`.
- The `flow:local-chain` script is broken: it deploys `MockUSDC.sol` from a path that moved. Use the payment flow above.
- With Anvil installed, the `anvil: authorize, refuse a second authorization...` test in `apps/cli/src/gateway/services/operator.test.ts` fails with `nonce too low`. CI skips it, so that failure alone isn't caused by your change.

## Gaps

- The smoke run is scripted. It shuts down when it ends, so you can't keep a buyer running to try a change by hand.
- The smoke run uses one pinned seller with seller verification off, and doesn't call `/v1/models` or `/v1/responses`. It doesn't prove routing or verification.
- Nothing automated drives the desktop UI.
- `scripts/setup-local-test.sh` is the manual route to a desktop on a local chain, and it prints the settings the desktop needs. It hardcodes one developer's home path and writes to `~/.antseed`, so get a yes before running it.
- `apps/cli/src/gateway/**` has unit tests only.
