# @antseed/buyer-core

The buyer itself: request handling, payment negotiation, what it signs and reserves, and channel accounting. It is environment-free so that the CLI (through `@antseed/node`) and the browser (`@antseed/web-sdk`) run the same code. The environment plugs in through the structural interfaces in `src/interfaces.ts` and `src/channel-store-types.ts`. Channel states are in `channel-session-state.ts`.

| Rule | Enforced by |
| --- | --- |
| Depends only on `protocol`, `api-adapter`, `ethers` and `tokenx`. No Node-only APIs. | review only |
| Never signs more than `verifiedCost + maxPerRequestUsdc`, never reserves more than `maxReserveAmountUsdc`. | `packages/node/tests/buyer-payment-manager.test.ts` |
| A channel's signed `cumulativeAmount` never decreases. After a catch-up it signs exactly the seller's required amount. | `packages/node/tests/buyer-payment-*.test.ts`, sandbox `issue-1200-spendingauth-catchup` |

**Ask first:** what or how much the buyer signs or reserves, including defaults; a widened structural interface; a new dependency.

**Prove it:** the payment tests live in `packages/node/tests`, so run node's and web-sdk's tests too.
