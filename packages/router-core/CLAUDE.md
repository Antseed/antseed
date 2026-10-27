# @antseed/router-core

The buyer's routing: `scoreCandidates` ranks peers by price, latency, capacity, reputation, freshness and reliability (`DEFAULT_WEIGHTS`, ties by peer id), and `ModelRoutingClient` buys rankings from routing services through one adapter per routing protocol (`routing-adapters/`, `irp.ts`). A router only ever sees the candidates the buyer's own filters allow, so it can't steer a buyer outside them. No storage or host code: hosts pass peers and metrics in.

| Rule | Enforced by |
| --- | --- |
| Every peer is scored by the same factors. | `src/peer-scorer.test.ts` |
| An answer outside the sent candidates is dropped. Unknown router options are rejected before buying. | `src/model-routing-client.test.ts` |

**Ask first:** `DEFAULT_WEIGHTS` or a new factor (it moves every buyer's traffic); a new routing protocol.

**Prove it:** a ranking change also runs sandbox `routing-smoke`.
