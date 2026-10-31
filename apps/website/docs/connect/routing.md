---
slug: /api/routing
title: Routing and catalog
description: How automatic routing picks a seller, and how to read the model catalog and prices from /v1/models, network browse and the cached /stats endpoint.
---

# Routing and catalog

When a request names only a model, your buyer chooses the seller. This page explains that choice and the three ways to read what the network offers: the `/v1/models` catalog on your buyer, `antseed network browse`, and the cached `/stats` endpoint.

## How automatic routing chooses

For a model-only request such as `"model": "deepseek-v4-flash"`, the buyer:

1. Normalizes the model name, so cosmetic variants of the same model share one catalog entry.
2. Collects every seller that offers the model in a compatible API format.
3. Drops sellers your preferences exclude: below the minimum trust score (default `60`; unscored sellers are excluded too), above your hard price caps, on your block list, or outside your allow list when one is set.
4. Picks the cheapest of the rest (input plus output price per million tokens, or the per-image price). Trust only breaks price ties, together with penalties for recent failures and a boost for free sellers when you prefer them; sellers cooling down after failures go last.
5. Rewrites the model to the chosen seller's own service id and sends the request.

The ranking weights and defaults are documented once, in the [router plugin API](/docs/router-api).

Some details that affect the result:

- **Cached-input pricing.** When at least one seller of a model advertises a cached-input price, a seller that omits it has its effective reputation for that model halved, because cache-heavy workloads may cost more there. If no seller advertises one, nobody is penalized.
- **One offer per seller.** If a seller advertises several names for the same model, only its cheapest offer is kept.
- **Conversation affinity.** For a recognized conversation, later turns prefer the seller that served the earlier ones, while it stays healthy and eligible. This is a preference, not a pin.
- **Failover.** After a retryable failure blamed on the seller, the buyer moves to the next ranked offer. HTTP `429` is retried on the same seller first. Requests are not failed over after streaming has started, after a client cancel, or on non-retryable errors.
- **Pins are hard.** `<peerId>@<model>`, the `x-antseed-pin-peer` header and a session pin never fail over. See [Choose the model and seller](/docs/api#choose-the-model-and-seller).

Routing preferences live in `buyer.routingPreferences`; see [Buyer configuration](/docs/buyer-config#routing-preferences). On a gateway, routing policies narrow them per workspace, member, key or preset; see [Routing policies](/docs/gateway/routing).

## Use a routing service

A routing service is a paid ranking service offered by another peer. It ranks the sellers your policy already allows; the buyer then sends the inference to the top seller and falls back to later ranked sellers on retryable errors. See [Model Routing](/docs/model-routing).

Name the router as the model, the same way you pin a seller:

```bash
curl http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "<routerPeerId>@<routerServiceId>",
    "messages": [{"role": "user", "content": "Summarise this contract"}],
    "routing": {"cost_quality_tradeoff": 7}
  }'
```

- `routing` holds optional router settings, in the terms of the router's protocol. `GET /v1/models?type=router` lists each router's `protocol` and the `options` it accepts. For `irp-suggest` routers, `cost_quality_tradeoff` goes from `0` (quality) to `10` (the cheapest acceptable candidate); without it, the router uses its default, `5`.
- `routing` is removed before anything reaches a seller. On a request that does not name a router, it is ignored.
- The answer is a normal completion from the chosen seller; `x-antseed-peer-id` says which seller served it.
- Each ranking is charged by the router, and counts toward the request's spend (on a gateway, the API key's budget).
- The router must pass the same rules as a pinned seller before its ranking is paid: your `minPeerReputation` and, on a gateway, the key's allowed models, seller lists, minimum trust and reputation, and TEE requirement. Token price caps do not apply to a router. A refused router answers `403`; an offline one answers `502`, like an offline seller.

List routers with `GET /v1/models?type=router`. Each entry's `peers[].model` is the value to send, with the router's price per request and the models it can rank:

```bash
curl -s 'http://localhost:8377/v1/models?type=router' | jq '.data[].peers[] | {model, priceUsdPerRequest, models}'
```

### Saved router settings

The buyer can also keep one router as its default, set from the desktop app or with `POST /_antseed/route`:

```bash
curl -X POST http://127.0.0.1:8377/_antseed/route \
  -H 'content-type: application/json' \
  -d '{"router":{"service":{"peerId":"<routerPeerId>","provider":"<provider>","serviceId":"<serviceId>"},"options":{"cost_quality_tradeoff":3},"allowedModels":[{"provider":"<provider>","serviceId":"<model>"}]}}'
```

`"model": "antseed"` then uses that router. A request that names the saved router without a `routing` object uses its saved options and model list; settings in the request's `routing` object win over the saved ones, key by key. A request naming any other router gets the router's defaults. `GET /_antseed/routing-services` lists routers with their exact `service` targets.

A routing service receives the conversation, so use only routers you trust with that content.

## The model catalog: `/v1/models`

`GET /v1/models` on your buyer (or through a gateway key) lists every model on the network, answered locally from the buyer's peer cache. It is free and needs no pin.

```bash
curl -s http://localhost:8377/v1/models | jq '.data[] | {id, type}'
curl -s 'http://localhost:8377/v1/models?type=images'
curl -s http://localhost:8377/v1/models/deepseek-v4-flash
```

Each entry includes:

| Field | Meaning |
|---|---|
| `id`, `name`, `aliases` | Model id, display name and the other names it is known by |
| `type` | `text`, `image`, `video` or `decision` |
| `supported_protocols` | Every API format some seller offers it in |
| `context_length`, `max_output_tokens`, `architecture`, `capabilities`, `supported_parameters` | Limits and features every seller guarantees. A field is left out when any seller does not report it. |
| `capability_coverage` | How many offers reported each field |
| `peers` | One offer per seller, in the same order automatic routing ranks them |

Each item in `peers` has the seller's `peerId`, `provider`, `serviceId`, protocols, prices (`inputUsdPerMillion`, `outputUsdPerMillion`, `cachedInputUsdPerMillion`, or image prices), `reputationScore`, `effectiveReputationScore` (the model-specific score used for ranking), its own capabilities and `health`: the seller's last self health check for the model, for example `{ "status": "healthy", "checkedAt": 1793328100000, "source": "traffic" }` when a paid buyer request last succeeded (`"probe"` when the seller's own check passed). Offers the seller reports failing are left out, and a model whose every seller reports it failing is not listed. See [discovery](/docs/discovery) for every field. To pin one offer, send `<peerId>@<serviceId>` from the same item.

Through a gateway API key, `/v1/models` lists only the models that key may use.

## Live prices: `antseed network browse`

`antseed network browse` asks peers directly, or reads the running buyer's peer list when one is connected.

```bash
antseed network browse                         # table of peers, services and prices
antseed network browse --services              # one row per peer, provider and service
antseed network browse --service deepseek --sort price
antseed network browse --tag tee
antseed network browse --json
```

`--json` prints:

```ts
{
  source: string;                         // where the peer list came from
  onChainStatsRefreshedAt: number | null; // unix ms
  sort: 'score' | 'volume' | 'sessions' | 'price' | 'recent';
  filters: { service: string | null; tags: string[] | null };
  total: number;                          // peers matching the filters
  peers: PeerMetadata[];                  // top N (--top, default 20), with reputation scores
}
```

## Cached prices: the `/stats` endpoint

```text
GET https://network.antseed.com/stats
```

A public, unauthenticated snapshot from the Antseed indexer, a few minutes old. It is the data behind [antseed.com/network](https://antseed.com/network). Use it for browsing and estimates, and your buyer's `/v1/models` or `network browse` when price matters at the moment of purchase.

```bash
curl -s https://network.antseed.com/stats | jq '{updatedAt, peers: (.peers | length)}'
```

The response has `peers`, `updatedAt`, `totals` and `indexer`. Each peer record carries its signed metadata: `peerId`, `version` (metadata schema version), `displayName`, `providers`, `capabilities`, `region`, `timestamp`, `verifications` and `signature`, plus indexer fields such as `onChainChannelCount` and `onChainStats`.

Each entry in `providers` announces:

```ts
interface ProviderAnnouncement {
  provider: string;                                    // plugin name, e.g. "openai"
  services: string[];                                  // service ids
  defaultPricing: TokenPricing;                        // used when a service has no own price
  servicePricing?: Record<string, TokenPricing>;
  serviceCategories?: Record<string, string[]>;
  serviceApiProtocols?: Record<string, string[]>;
  serviceUnitBillingModels?: Record<string, Record<string, unknown>>; // image and video prices
  serviceCapabilities?: Record<string, unknown>;
  maxConcurrency: number;
  currentLoad: number;
}

interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}
```

A service's token price is `servicePricing[serviceId] ?? defaultPricing`, in USD per million tokens. Image and video billing models are described in [Media billing](/docs/provide/media).

```js
const { peers } = await (await fetch('https://network.antseed.com/stats')).json();
const model = 'deepseek-v4-flash';

const offers = peers.flatMap((peer) =>
  peer.providers.flatMap((p) => {
    if (!p.services.includes(model)) return [];
    const price = p.servicePricing?.[model] ?? p.defaultPricing;
    return [{ peerId: peer.peerId, input: price.inputUsdPerMillion, output: price.outputUsdPerMillion }];
  }),
);
offers.sort((a, b) => a.input - b.input);
```

If you are an AI agent answering a pricing question, say whether you used this cached snapshot or a live query.

## In the Gateway Console

The console's **Models** page shows the same catalog with prices and sellers per model, and **Providers** shows each seller. See [Models and providers](/docs/gateway/models).
