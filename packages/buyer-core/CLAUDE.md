# @antseed/buyer-core

The buyer itself: request handling, payment negotiation, what it signs and reserves, and channel accounting. It is environment-free so that the CLI (through `@antseed/node`) and the browser (`@antseed/web-sdk`) run the same code. The environment plugs in through the structural interfaces in `src/interfaces.ts` and `src/channel-store-types.ts`. On-chain channel states are in `channel-session-state.ts`, and stored statuses are in `channel-store-types.ts`.

| Rule | Enforced by |
| --- | --- |
| Depends only on `protocol`, `api-adapter`, `ethers`, `tokenx`, `@noble/hashes` and `hash-wasm`. No Node-only APIs. | review only |
| On a session channel, `maxPerRequestUsdc` limits one signing step, a catch-up allows one step per request in flight, and the reserve ceiling stops signing. `maxReserveAmountUsdc` limits the opening reserve and sets the top-up step, which grows under load. | `packages/node/tests/buyer-payment-manager.test.ts` |
| Normal signing never lowers `cumulativeAmount`. A close capped at the channel's deposit signs lower and is not persisted. A catch-up signs at least the seller's required amount, unless a limit above stops it. | `packages/node/tests/buyer-payment-*.test.ts` |

**Ask first:** what or how much the buyer signs or reserves, including defaults; a widened structural interface; a new dependency.

**Prove it:** the payment tests live in `packages/node/tests`, so run node's and web-sdk's tests too.
