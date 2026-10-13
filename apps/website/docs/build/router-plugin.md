---
title: Router plugin API
slug: /router-api
sidebar_label: Router plugins
description: How the buyer chooses a seller for each request, the routing defaults and weights, and how to write a router plugin that enforces your own policy.
---

# Router plugin API

When a request names a model but not a seller, the buyer has to choose one. This page describes how that choice is made, lists every default and weight involved, and shows how to plug in your own policy with a router plugin. This is the only page that documents the routing weights; other pages link here.

To change routing without code, use the buyer's `buyer.routingPreferences` settings (see [Buyer configuration](/docs/buyer-config)) or, behind a gateway, [routing policies](/docs/gateway/routing).

## How the buyer chooses a seller

The CLI buyer proxy, the desktop app and the gateway share one ranking, from `@antseed/node/model-routing`, so the model catalog and actual routing agree on seller order.

1. **Hard limits.** Only sellers that offer the requested service are considered. The router plugin then rejects sellers below `buyer.minPeerReputation` or priced above `buyer.maxPricing`.
2. **Eligibility.** A seller is eligible when it isn't in `blockedPeerIds`, is in `allowedPeerIds` (when that list is non-empty), and has a trust score of at least `minTrustScore`. A seller without a usable score is ineligible unless `minTrustScore` is `0`.
3. **Order.** Eligible sellers come first, then sellers that aren't cooling down after failures, then sellers with a known price. Among those, the **cheapest total price wins**: input plus output price per million tokens, or the per-image price for image services. Trust is a gate, not a ranking factor above the minimum.
4. **Tie-break.** Sellers at the same price are ordered by the blended score below, then by peer ID.
5. **Conversation affinity.** For a recognized conversation, the seller that served it last is moved to the front if it is still allowed and not cooling down. A pinned seller (`--peer`, the `x-antseed-pin-peer` header or `<peerId>@deepseek-v4-flash`) always wins.

If a seller fails with a retryable error, the buyer tries the next one in this order.

### Routing preference defaults

| Setting (`buyer.routingPreferences`) | Default | Effect |
|---|---|---|
| `minTrustScore` | `60` | Hard eligibility gate on the buyer's [trust score](/docs/reputation#trust-score); `0` disables it |
| `maxInputUsdPerMillion` | `25` | Sellers above this input price lose 50 points in the tie-break score; not a hard cap |
| `preferFreePeers` | `false` | Free sellers gain 25 points in the tie-break score |
| `allowedPeerIds` | `[]` | When non-empty, only these sellers are eligible |
| `blockedPeerIds` | `[]` | These sellers are never eligible |

| Hard limit | Default | Effect |
|---|---|---|
| `buyer.minPeerReputation` | `0` | Router-level minimum reputation; separate from `minTrustScore` |
| `buyer.maxPricing.defaults` | `100` / `100` USD per million input / output tokens | Sellers priced above are rejected |

### Tie-break score

Every candidate starts at 100 points:

| Adjustment | Points |
|---|---|
| Cooling down after repeated failures | −1000 |
| Each consecutive recent failure (when not cooling down) | −3 |
| Free, with `preferFreePeers` on | +25 |
| Input price above `maxInputUsdPerMillion` | −50 |
| Trust score below `minTrustScore` | −50 |
| Trust score | + min(trust, 100) ÷ 5 |
| Total price known | − total price |
| Total price unknown | −10 |

The trust score used here is the buyer-computed score, or the seller-reported one if the buyer hasn't scored the seller yet. If any seller of a model advertises a cached-input price, offers of that model without one count at half their trust score; free offers are exempt.

### Failure cooldown

A seller enters cooldown after 3 consecutive failures. The cooldown starts at 30 seconds and doubles with each further failure, up to 8 minutes. Latency is tracked as an exponential moving average with α = 0.3.

## Router plugins

A router plugin is an npm package, loaded the same way as a [provider plugin](/docs/provider-api#package-layout): an ES module with `dist/index.js` that exports an object with `type: 'router'` and `createRouter()`. Any package name works. The buyer uses the built-in `local` router (`@antseed/router-local`) unless you choose another:

```bash
antseed buyer start --router my-router-plugin
```

```typescript
import type { AntseedRouterPlugin, Router } from '@antseed/node'

interface AntseedRouterPlugin {
  type: 'router'
  name: string
  displayName: string
  version: string
  description: string
  configSchema?: ConfigField[]
  createRouter(config: Record<string, string>): Router | Promise<Router>
}

interface Router {
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null
  onResult(peer: PeerInfo, result: { success: boolean; latencyMs: number; tokens: number }): void
}
```

`createRouter()` receives the keys you declare in `configSchema` that are set in the environment, plus `ANTSEED_MIN_REPUTATION` (from `buyer.minPeerReputation`) and `ANTSEED_MAX_PRICING_JSON` (from `buyer.maxPricing`).

### What the buyer proxy uses

The CLI buyer proxy orders sellers with the shared ranking above, not with `selectPeer`. It uses your router for:

- **Policy filtering**, through optional methods. Define them to enforce your own rules; a seller they reject is never used.

  ```typescript
  allowsPeerForPolicy?(req: SerializedHttpRequest, peer: PeerInfo): boolean
  allowsPeerForPricing?(req: SerializedHttpRequest, peer: PeerInfo): boolean   // used when allowsPeerForPolicy is absent
  explainPolicyRejection?(req: SerializedHttpRequest, peer: PeerInfo): string | null  // shown in route previews
  ```

- **Feedback**: `onResult` is called after each request with success, latency and tokens.

`selectPeer` is still required. It is the selection method for applications that embed `@antseed/node` and pick sellers themselves.

### The `local` router

`@antseed/router-local` rejects sellers below `ANTSEED_MIN_REPUTATION`, sellers in cooldown, sellers without the requested service and sellers above `ANTSEED_MAX_PRICING_JSON`. Its `selectPeer` scores the remaining sellers with `scoreCandidates` from `@antseed/router-core`:

| Factor | Weight | Scoring |
|---|---|---|
| Price | 0.30 | Lower input price scores higher (inverted min-max across candidates) |
| Latency | 0.25 | Lower latency (EMA) scores higher |
| Capacity | 0.20 | More free capacity scores higher |
| Reputation | 0.10 | Trust score ÷ 100 |
| Freshness | 0.10 | Recently seen sellers score higher |
| Reliability | 0.05 | Fewer failures score higher |

| Config key | Default |
|---|---|
| `ANTSEED_MIN_REPUTATION` | `0` |
| `ANTSEED_MAX_PRICING_JSON` | none |
| `ANTSEED_MAX_FAILURES` | `3` |
| `ANTSEED_FAILURE_COOLDOWN_MS` | `30000` |
| `ANTSEED_MAX_PEER_STALENESS_MS` | `300000` |

You can reuse these pieces in your own router: `@antseed/router-core` exports `scoreCandidates`, `DEFAULT_WEIGHTS` (overridable per call with `weights`) and `PeerMetricsTracker`.

If an application that embeds the SDK sets no router, the node's built-in default picks the cheapest seller at or above a minimum reputation (default `0`), then the higher trust score, then the lower latency.

A starting template lives in [`docs/protocol/templates/router-plugin`](https://github.com/AntSeed/antseed/tree/main/docs/protocol/templates/router-plugin).
