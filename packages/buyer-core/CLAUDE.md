# @antseed/buyer-core

Owns the buyer's money path: request handling, payment negotiation, SpendingAuth and ReserveAuth signing decisions, channel accounting, pricing. `@antseed/node` re-exports it from its old paths. Read `README.md` here first.

## Boundaries

- Depends only on `@antseed/protocol`, `@antseed/api-adapter`, `ethers` and `tokenx`. No sqlite, sockets or Node-only APIs: `web-sdk` runs it in a browser.
- The environment plugs in through the structural interfaces in `src/interfaces.ts` and `src/channel-store-types.ts`. Implementations never import this package.

## Invariants

| Invariant | Enforced by |
| --- | --- |
| USDC is `bigint` base units (6 decimals). Format and parse only through `usdc-utils.ts`. | `src/pricing.test.ts` (positive values only) |
| The buyer never signs more than `verifiedCost + maxPerRequestUsdc` and never reserves more than `maxReserveAmountUsdc`. | `packages/node/tests/buyer-payment-manager.test.ts` |
| A channel's signed `cumulativeAmount` never decreases. After a catch-up the buyer signs the seller's required amount, not more. | `packages/node/tests/buyer-payment-*.test.ts`, sandbox `issue-1200-spendingauth-catchup` |
| No Node-only import in `src/`. | review only |

## Ask first

- Any change to what or how much the buyer signs or reserves, including defaults.
- A new dependency, or a widened structural interface.

## Prove it

The verify-antseed skill decides what proves a change here. `pnpm --filter @antseed/buyer-core test` and `typecheck` always run.
