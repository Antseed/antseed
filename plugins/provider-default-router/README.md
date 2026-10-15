# @antseed/provider-default-router

AntSeed's default [model-routing](../../docs/protocol/model-routing.md) provider. A seller runs it to offer buyers a router that sends each request to the best free model among the buyer's candidates. It answers the routing endpoints itself; it has no upstream, needs no API key, and forwards nothing.

- `GET /v1/routing/models` lists `*` (it scores any model the buyer sends) plus any `DEFAULT_ROUTER_MODELS`, each with a zero `max_pricing` so buyers only send free candidates (no limit with `DEFAULT_ROUTER_INCLUDE_PAID=true`). The buyer builds candidates from its own model catalog, so the router depends on no central model list.
- `POST /v1/routing/rank` ranks the buyer's free candidates, best model first. Paid candidates are dropped unless `DEFAULT_ROUTER_INCLUDE_PAID=true`, which ranks them after the free ones, cheapest first. If nothing is free and paid ranking is off, it answers `422 no-scorable-candidate`, which is not billed.
- Rankings are free by default: the service announces zero token prices and a `completed_requests` price of `0`, so buyer and seller both take the free-service path and no payment channel is opened. Set `DEFAULT_ROUTER_PRICE_USD` to charge per ranking.

## Run it

```bash
antseed config seller add-provider router --plugin default-router
antseed config seller add-service router default-router --input 0 --output 0
antseed seller start
```

A seller offers at most one routing service, so run the router on its own seller node. To limit abuse, set the seller free tier, which applies to free rankings like any other free service:

```bash
antseed config seller set freeTier.maxRequestsPerAddress 1000
```

Buyers pick it like any routing service:

```bash
curl http://127.0.0.1:8377/_antseed/routing-services
curl -X POST http://127.0.0.1:8377/_antseed/route \
  -H 'content-type: application/json' \
  -d '{"router":{"service":{"peerId":"<routerPeerId>","provider":"default-router","serviceId":"default-router"}}}'
```

## How it ranks

1. **Candidates.** Only what the buyer sends in `routing.candidates` is ranked; a candidate is free when its input, cached-input and output prices are all `0`.
2. **Scores.** Each model is scored by its live [Artificial Analysis](https://artificialanalysis.ai) Intelligence Index, or Coding Index with `DEFAULT_ROUTER_METRIC=coding`, read from the free, keyless [modelgrep API](https://modelgrep.com/api). Names are matched by canonical model key; deployment variants such as `-fast`, `-preview`, `-exl3` or a date take their base model's score, but the parameter size is never dropped.
3. **Unscored models** are still offered, after every scored model, in the buyer's order.
4. **Same model, several sellers:** the buyer's order is kept, which already reflects trust, recent failures and cooldowns.
5. **Seller override:** models in `DEFAULT_ROUTER_MODELS` outrank every scored model, in the order given.

Scores refresh every 6 hours. A failed refresh keeps the last good scores; if scores were never loaded, free candidates keep the buyer's order.

## Use it in code

The plugin wraps the `FreeModelRouter` class, which is also exported for embedding:

```ts
import { FreeModelRouter } from '@antseed/provider-default-router';

const router = new FreeModelRouter({ metric: 'coding', preferredModels: ['glm-5.3-flash'] });
const response = await router.handleRequest(request); // IRP GET /v1/routing/models or POST /v1/routing/rank
```

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `ANTSEED_ALLOWED_SERVICES` | `default-router` | Routing service id; exactly one |
| `DEFAULT_ROUTER_PRICE_USD` | `0` | USD per ranking |
| `DEFAULT_ROUTER_METRIC` | `intelligence` | `intelligence` or `coding` |
| `DEFAULT_ROUTER_MODELS` | -- | Comma-separated preferred models, best first |
| `DEFAULT_ROUTER_INCLUDE_PAID` | `false` | Also rank paid candidates after free ones |
| `DEFAULT_ROUTER_SCORES_URL` | `https://modelgrep.com/api/v1/models` | Model scores; empty ranks by buyer order only |
| `DEFAULT_ROUTER_REFRESH_SECONDS` | `21600` | Refresh interval |
| `ANTSEED_MAX_CONCURRENCY` | `50` | Max concurrent rankings |

The router receives each buyer's conversation, like every routing service. It reads only the candidates and never stores or forwards the request.
