# @antseed/router-core

Two parts. `ModelRoutingClient` is the live path: it buys rankings from routing services through one adapter per routing protocol (`routing-adapters/`). `scoreCandidates` ranks peers by price, latency, capacity, reputation, freshness and reliability (`DEFAULT_WEIGHTS`, ties by peer id) for `router-local`'s `selectPeer`, which the buyer proxy never calls. The proxy ranks with `rankModelRoutes` in `packages/node`. A router only ever sees the candidates the buyer's own filters allow, so it can't steer a buyer outside them. No storage or host code: hosts pass peers and metrics in.

## Inside

- `src/model-routing-client.ts` — `ModelRoutingClient` and `ModelRoutingClientApi`, the surface the buyer proxy uses.
- `src/routing-adapters/` — one adapter per routing protocol (`irp.ts`), registered in `index.ts`. A new routing protocol adds its adapter there.
- `src/peer-scorer.ts`, `src/peer-metrics.ts` — `scoreCandidates`, `DEFAULT_WEIGHTS`, `PeerMetricsTracker`.
- `src/cache-observations.ts`, `src/router-model-names.ts`, `src/tool-hints.ts` — cache-reuse credit, catalog name mapping, the env hints `antseed buyer start` prints.

| Rule | Enforced by |
| --- | --- |
| Every peer is scored by the same factors. | `src/peer-scorer.test.ts` |
| An answer outside the sent candidates is dropped. Unknown router options are rejected before buying. | `src/model-routing-client.test.ts` |
| Nothing is paid until the request has user text, candidates exist, options validate and the peer advertises exactly one service of a one-service-per-seller protocol. | `src/model-routing-client.test.ts` |
| A same-turn follow-up reuses the saved ranking while one pick is still usable. New user text or new options buy a new one. | `src/model-routing-client.test.ts` |
| The rank request is plain IRP: no `x-antseed-*` headers, no `model` or `stream`; other bodies are converted to Chat Completions. A candidate with no cached-input price is sent at the input price. | `src/model-routing-client.test.ts` |
| Cache reuse is credited only to the exact peer, provider and service, expires, and is capped by the current prompt. | `src/cache-observations.test.ts` |
| OpenAI-style env vars get `<proxy>/v1`; `ANTHROPIC_BASE_URL` gets the proxy root. | `src/tool-hints.test.ts` |

## Connections

- Peer-depends on `@antseed/node` (IRP wire types come from `packages/protocol/src/irp.ts` through it). Build tier 1. Imported by `apps/cli/src/proxy/` and `plugins/router-local`.
- Two release paths: the CLI pins it exactly, so a `ModelRoutingClient` fix needs router-core and the CLI bumped; `router-local` pins its own copy in `~/.antseed/plugins`, so a scorer fix reaches buyers only when the plugin refreshes.
- A new routing protocol touches `ROUTING_PROTOCOLS` and `ROUTING_WIRES` in `packages/protocol/src/routing.ts`, an adapter here, and a seller plugin. `oneServicePerSeller` is read here and in `packages/node/src/seller-request-handler.ts`.

## Traps

- `README.md` is stale: its weights and `recordSuccess`/`recordFailure`/`isOnCooldown` calls do not exist. Read `src/peer-scorer.ts` and `peer-metrics.ts`.
- `scoreCandidates` normalizes price on `inputUsdPerMillion` only.
- `RouterCannotRankError` (IRP 422) tells `apps/cli/src/proxy/router-execution.ts` to drop its cached model list and rank once more. Use it only for that answer.
- The prompt-size estimate in `selectRoute` only caps expected cache reuse. Never use it for billing.
- `irpCandidateId` is for logs; long ids become hashes. Never parse an id.
- A printed `OPENAI_BASE_URL` without `/v1` once sent OpenAI SDKs to a 404.

**Ask first:** `DEFAULT_WEIGHTS` or a new factor (it changes `selectPeer` for anything built on `scoreCandidates`); a new routing protocol; what the rank request sends to a router, or when a ranking is reused instead of bought.

**Prove it:** `pnpm --filter @antseed/router-core test` and `typecheck`. A `scoreCandidates` change also runs `e2e/tests/router-selection.test.ts` and `pnpm --filter @antseed/router-local test`. That test does not cover `rankModelRoutes`. The CLI reads `dist`, so a `ModelRoutingClient` change builds this package, then runs `pnpm --filter @antseed/cli test`.
