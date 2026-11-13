# @antseed/router-core

Two parts. `ModelRoutingClient` is the live path: it buys rankings from routing services through one adapter per routing protocol (`routing-adapters/`). `scoreCandidates` ranks peers by price, latency, capacity, reputation, freshness and reliability (`DEFAULT_WEIGHTS`, ties by peer id) for `router-local`'s `selectPeer`, which the buyer proxy never calls. The proxy ranks with `rankModelRoutes` in `packages/node`. A router only ever sees the candidates the buyer's own filters allow, so it can't steer a buyer outside them. No storage or host code: hosts pass peers and metrics in.

| Rule | Enforced by |
| --- | --- |
| Every peer is scored by the same factors. | `src/peer-scorer.test.ts` |
| An answer outside the sent candidates is dropped. Unknown router options are rejected before buying. | `src/model-routing-client.test.ts` |

**Ask first:** `DEFAULT_WEIGHTS` or a new factor (it changes `selectPeer` for anything built on `scoreCandidates`); a new routing protocol.

**Prove it:** a `scoreCandidates` change also runs `e2e/tests/router-selection.test.ts`. That test does not cover `rankModelRoutes`.
