---
sidebar_position: 2
slug: /router-api
title: Router Plugin
hide_title: true
---

# Router Plugin

Router plugins enforce general buyer policy and record request results. For model-only requests, the buyer proxy first resolves the canonical model and uses the shared model-route ranking from `@antseed/node/model-routing`, so the desktop catalog, `/v1/models/:id`, internal chat, and CLI proxy agree on seller order. Retryable peer failures may advance to the next eligible seller; recognized conversations softly prefer their previous successful route, while explicit pins remain hard.

## Router Plugins vs. Routing Services

A **router plugin** is local buyer code implementing the `Router` interface
below. The CLI's `antseed buyer start --router <name>` selects that plugin; it
does not select a remote model-ranking service.

A **routing service** is a seller's advertised `model-routing` service. Select
its exact peer, provider, and service in the desktop's Router picker or through
[`POST /_antseed/route`](/docs/guides/using-the-api#select-a-routing-service).
The built-in `ModelRoutingClient` in `@antseed/router-core` uses
[Inference Routing Protocol (IRP)](https://github.com/inference-routing/spec/blob/main/SPEC.md)
suggest-only mode without replacing the installed router plugin:

1. `listModels` fetches free `GET /v1/routing/models` from the selected service.
2. The buyer filters eligible destinations by its own policy and optional
   `allowedModels`, then matches their model names to the router's list using
   canonical model keys.
3. `POST /v1/routing/rank` sends the conversation and candidates with IDs, model
   names, and pricing. The response ranks those candidates by `candidate_id`.
4. The buyer sends inference to the chosen seller and pays that seller separately.
   The router only ranks; it does not execute or forward inference.

Each successful ranking is billed as one `completed_requests` unit at the
routing service's advertised price. Reused rankings during a tool loop do not
require another ranking purchase. The router receives the whole conversation
included in the request, so only choose services you trust with that content.

The service setting `costQualityTradeoff` is an optional integer from **0 (best
quality)** to **10 (cheapest)**; unset uses the router default **5**. On the IRP
wire it is `routing.cost_quality_tradeoff`. It is separate from the buyer's
Price + Trust policy below. Routing-service selection does not add model-ranking
methods to the local `Router` interface or require a service-specific adapter.

To offer a ranking service rather than write a buyer-policy plugin, see
[offering a model-routing service](/docs/guides/become-a-provider#offering-a-model-routing-service).

## Model-Only Routing Preferences

The shared defaults are:

```typescript
const DEFAULT_MODEL_ROUTING_PREFERENCES = {
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
};
```

`minTrustScore` and the allow/block lists determine eligibility against the buyer's [trust score](/docs/reputation#trust-score). Eligible offers are ordered using trust, token or image price, cached-input pricing coverage, recent failures, cooldowns, and free-peer preference. The buyer proxy watches `buyer.routingPreferences` in `config.json`, so desktop preference changes also affect connected apps and direct API calls without maintaining a second routing implementation.

## Default Scoring Weights

The `@antseed/router-core` scores peers with:

```typescript title="scoring weights"
const DEFAULT_WEIGHTS = {
  price:       0.30,   // lower price scores higher (inverted min-max)
  latency:     0.25,   // lower latency scores higher (EMA)
  capacity:    0.20,   // more available capacity scores higher
  reputation:  0.10,   // higher trust score scores higher (0-100)
  freshness:   0.10,   // recently seen peers score higher
  reliability: 0.05,   // lower failure rate scores higher
} as const;
```

These legacy router-core weights remain available to router-plugin authors for non-model-specific selection. They are not the ordering used by the buyer proxy's model-only route planner described above. Model-only routing defaults to the hard `minTrustScore: 60` gate, and cooling or recently failing peers are deprioritized by the shared model-route ranking.

## Router Interface

```typescript title="router interface"
interface Router {
  // Select a peer for a request
  selectPeer(
    req: SerializedHttpRequest,
    peers: PeerInfo[]
  ): PeerInfo | null

  // Called after each request completes
  onResult(
    peer: PeerInfo,
    result: {
      success: boolean
      latencyMs: number
      tokens: number
    }
  ): void
}
```

If you don't provide a router, the SDK supplies the default policy router. The CLI buyer proxy still applies the shared model-route ranking before dispatching a model-only request.
