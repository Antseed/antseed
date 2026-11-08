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
4. Ranks the rest by the expected cost of one good answer: the price plus the value of the time it takes, divided by the chance it succeeds. Sellers close to the best share the traffic. Sellers failing lately come after the healthy ones, and sellers cooling down go last. Trust doesn't affect the order above the minimum. **Answer length and speed** below gives the numbers.
5. Rewrites the model to the chosen seller's own service id and sends the request.

The ranking weights and defaults are documented once, in the [router plugin API](/docs/router-api).

Some details that affect the result:

- **Cached-input pricing.** When at least one seller of a model advertises a cached-input price, a seller that omits it has its effective reputation for that model halved, because cache-heavy workloads may cost more there. If no seller advertises one, nobody is penalized.
- **Model verification.** A seller service with a live DIFF result on-chain (two independent auditors found it very likely serves a different model; see [Model verification](/docs/verify/overview)) keeps 10% of its effective reputation for that service, free or paid. Its other services are not affected, and a DIFF reported by one auditor that is still waiting for a second changes nothing. The two penalties multiply: a seller at 100 with both lands at 5. With the default minimum trust of `60`, a DIFF service drops out of automatic routing; a pin still reaches it. The buyer reads results from the verification contract at most every two minutes per seller. If the contract can't be read, the last result is used for up to 15 minutes; after that no penalty applies.
- **Answer length and speed.** Automatic routing weighs a seller's price against the time it takes, at $0.0002 per second of waiting, divided by its recent success rate. The time is the seller's usual time to first token plus the expected answer length at its usual output speed, counting `max_tokens` (or `max_completion_tokens`, `max_output_tokens`) up to 2,000 tokens, or 400 when the request sets none. Speeds come from your buyer's own requests, else the seller's reported figures. A first request to a paid seller you have no payment channel with counts 5 seconds more. So the same model can go to a cheaper seller for a short answer and to a faster, pricier one for a long answer. Sellers within 30% of the best share the traffic, and about 5% of requests try a seller your buyer has not heard from lately.
- **One offer per seller.** If a seller advertises several names for the same model, only its cheapest offer is kept.
- **Seller-reported performance.** Each seller announces, per model, how its last hour of buyer traffic went: requests, success rate, time to first token and output speed. Until your buyer has its own record of a seller on a model, it starts from these figures instead of fixed defaults, so a seller that reports failures is tried after healthier ones from the first request. A reported success rate counts once it covers at least 10 requests and never above 95%; your buyer's own requests outweigh it quickly. See [discovery](/docs/discovery).
- **Conversation affinity.** For a recognized conversation, later turns prefer the seller that served the earlier ones, while it stays healthy and eligible. This is a preference, not a pin.
- **Failover.** After a retryable failure blamed on the seller, the buyer moves to the next ranked offer. HTTP `429` is retried on the same seller first. Requests are not failed over after streaming has started, after a client cancel, or on non-retryable errors. A buyer without deposits that a paid seller asks to pay (`402`) moves on to the model's free sellers and free allowances; the `402` comes back only when none is left.
- **Pins are hard.** `<peerId>@<model>`, the `x-antseed-pin-peer` header and a session pin never fail over. See [Choose the model and seller](/docs/api#choose-the-model-and-seller).

To see why a request went where it did, read the `x-antseed-route-selection` response header (see [Which seller served a request](#which-seller-served-a-request)).

Routing preferences live in `buyer.routingPreferences`; see [Buyer configuration](/docs/buyer-config#routing-preferences). On a gateway, routing policies narrow them per workspace, member, key or preset; see [Routing policies](/docs/gateway/routing).

## Which seller served a request

Every response names its seller in `x-antseed-peer-id`. A model-routed response also carries `x-antseed-route-selection`: base64url-encoded JSON with how the seller was picked. Decode it with:

```bash
curl -s -D - -o /dev/null http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","max_tokens":64,"messages":[{"role":"user","content":"Reply with: ok"}]}' \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="x-antseed-route-selection"{print $2}' \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(Buffer.from(String(d).trim(),"base64url"))))'
```

The most useful fields:

| Field | Meaning |
|---|---|
| `rank`, `of` | Position of the serving seller among the eligible ones, and how many there were |
| `pick` | `best`, `spread` (drawn from the sellers sharing traffic), `conversation`, `exploration`, `failover` (the sellers before it failed) or `order` |
| `ordering` | `expected-cost` (the buyer's automatic order), `trust`, or a gateway policy's `price` or `latency` sort |
| `expectedCostUsd` | Price plus waiting time, over the success rate. Lower ranks first. |
| `expectedPriceUsd`, `expectedSeconds` | The price and time behind it |
| `successRate`, `observations`, `record` | Chance of a good answer, and how much of your buyer's own record it rests on |
| `channel` | `free`, `open` (you already pay this seller) or `new` (the first request reserves funds) |

Pinned requests don't carry it.

## Using only free models

A buyer with no deposits can only be served by free sellers. Automatic routing can still rank a paid seller first, for example a faster one for a long answer, and coding tools such as Claude Code and OpenCode send large `max_tokens`. With CLI 0.1.234 and earlier, the request then fails with `402` ("You are out of AntSeed credits") and is not retried on a free seller, unless a gateway routing policy applies to it.

To stay on free sellers:

- **Cap token prices at zero (text models).** Only sellers with free token prices stay eligible, for automatic and pinned requests. Restart the buyer to apply:

  ```bash
  antseed config buyer set maxPricing.defaults.inputUsdPerMillion 0
  antseed config buyer set maxPricing.defaults.outputUsdPerMillion 0
  ```

  Check the result with `antseed config buyer show`: `maxPricing` should list only `defaults`, both at `0`. The buyer also prints `max pricing defaults (USD/1M): input=0, output=0` at start. If your `config.json` has a `buyer.maxPricing.providers` block (per-provider or per-service caps), delete it or set its prices to `0` too. CLI 0.1.231 doesn't read that block, but the router applies those caps before the defaults whenever it gets them. `antseed buyer start --max-input-usd-per-million 0 --max-output-usd-per-million 0` sets only the defaults, for one run.

  A model with no free seller that passes your minimum trust score then fails with `502 model_not_found` instead of `402`.

  These are token caps, so they cover only what they price:
  - **Image models** are priced per image, not per token, and the buyer has no per-image cap. An image seller with zero token prices and a per-image price still gets the request, which then fails with `402`. Pick a seller whose catalog offer has `maxImageUsdPerImage` of `0` (or none), and pin it. `minImageUsdPerImage` isn't enough: an offer with one free and one paid image size has a minimum of `0`. Other priced units, such as per-second video or per-character speech, also make an offer paid.
  - **Video and speech** sellers advertise no token price, so these caps leave them out.
  - **Routing services** (`<routerPeerId>@<routerServiceId>`) charge per ranking and aren't judged by these caps, so a request that names one still tries to pay.
- **Pin a free seller.** Find one in the catalog and send `<peerId>@<model>`:

  ```bash
  curl -s http://localhost:8377/v1/models/deepseek-v4-flash \
    | jq -r '.peers[] | select(.inputUsdPerMillion == 0 and .outputUsdPerMillion == 0 and (.cachedInputUsdPerMillion // 0) == 0 and (.maxImageUsdPerImage // 0) == 0) | "\(.peerId)@\(.serviceId)  trust \(.effectiveReputationScore)"'
  ```

  A pin never fails over, so if that seller goes offline, pick another.
- **On a gateway,** create a preset that allows only free sellers, then call it as the model `@preset/<slug>`. A gateway policy can also cap the per-image price, which has no flag, so set it from a policy file:

  ```bash
  echo '{"maxImageUsdPerImage": 0}' > free-only.json
  antseed gateway preset create --slug free-oss --name "Free gpt-oss" --model gpt-oss-120b \
    --file free-only.json --max-input-price 0 --max-output-price 0 --max-cached-input-price 0
  ```

  Use `--prefer-free` instead of the caps to try free sellers first but still allow paid ones. Routing services aren't judged by these caps either. See [Routing policies](/docs/gateway/routing).

Some sellers list a model at $0 but serve it only to buyers staked in their pool; they answer others with `429`. Their catalog offer has `freeTier.base.stakersOnly: true`.

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
| `peers` | One offer per seller: sellers your preferences allow first, then by total price. This is not the order automatic routing tries them in, which also weighs speed and success rate per request (see [How automatic routing chooses](#how-automatic-routing-chooses)). |

Each item in `peers` has the seller's `peerId`, `provider`, `serviceId`, protocols, prices (`inputUsdPerMillion`, `outputUsdPerMillion`, `cachedInputUsdPerMillion`, or image prices), `reputationScore`, `effectiveReputationScore` (the model-specific score used for ranking), its own capabilities, `performance` (the seller's figures for its last hour of buyer traffic, for example `{ "requests": 312, "successRate": 0.97, "firstTokenMsP50": 420, "tokensPerSecondP50": 78 }`) and `health`: the seller's last self health check for the model, for example `{ "status": "healthy", "checkedAt": 1793328100000, "source": "traffic" }` when a paid buyer request last succeeded (`"probe"` when the seller's own check passed). Offers the seller reports failing are left out, and a model whose every seller reports it failing is not listed. See [discovery](/docs/discovery) for every field. To pin one offer, send `<peerId>@<serviceId>` from the same item.

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
