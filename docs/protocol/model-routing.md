# Model routing protocol

`model-routing` lets a seller recommend which inference destination should
serve a request. The router only recommends; the buyer still sends the inference to
the recommended seller and pays that seller normally.

A routing seller advertises a service with API protocol `model-routing` and
a completed-request unit billing model (see
[unit-billing-services.md](unit-billing-services.md)).

## Endpoints

| Endpoint | Cost | Purpose |
| --- | --- | --- |
| `GET /v1/routing/describe?service=<id>` | Free, rate limited | Models the router understands and the preferences it accepts |
| `POST /v1/routing/rank` | One completed request | Recommended destinations, best first, for one user turn |

## Describe

```json
{
  "version": 1,
  "revision": "2026-09-30.1",
  "supportedServiceIds": ["gpt-5.5", "claude-sonnet-4-6", "kimi-k2.6"],
  "preferences": {
    "tradeoff": {
      "options": ["1", "3", "5", "7", "9"],
      "default": "5",
      "title": "Cost-quality tradeoff",
      "description": "1 favors lower cost; 9 favors higher quality."
    }
  },
  "name": "Alpha"
}
```

- `revision` is an opaque router-chosen string. Change it whenever the models
  or preferences change.
- `supportedServiceIds` are AntSeed service IDs. Buyers never send other models.
- `preferences` lists the router's settings by name. Each setting has
  `options` (unique, nonempty strings) and may carry a `title`, `description`
  and `default` (one of the options). No other keys are allowed. A setting the
  buyer leaves unset falls back to its `default`, or is omitted if there is none.

A second router exposes its own policy in the same format:

```json
"preferences": {
  "policy": { "options": ["quality", "balanced", "cost"], "default": "balanced" }
}
```

## Rank

Request:

```json
{
  "version": 1,
  "service": "alpha-route",
  "revision": "2026-09-30.1",
  "preferences": { "tradeoff": "7" },
  "input": { "text": "Refactor this function", "estimatedTokens": 1200 },
  "candidates": [
    {
      "model": "gpt-5.5",
      "peer": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "openai",
      "price": { "inputUsdPerMillion": 1.25, "outputUsdPerMillion": 10, "cachedInputUsdPerMillion": 0.125 },
      "expectedCachedInputTokens": 900
    }
  ]
}
```

- `service` is the purchased routing service ID.
- `input.text` is the latest user message; `estimatedTokens` is the buyer's
  estimate for the whole prompt.
- `candidates` are the exact destinations the buyer allows, after its own
  trust, price and pin filters. `expectedCachedInputTokens` is the buyer's
  estimate of prompt tokens that destination can serve from its cache.

Response:

```json
{
  "version": 1,
  "recommendations": [
    { "model": "gpt-5.5", "peer": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "provider": "openai" }
  ]
}
```

The rank response has only `version` and `recommendations`. The buyer keeps recommendations that exactly match a sent candidate, in the
router's order. Duplicates and entries with fields other than `model`, `peer`
and `provider` are dropped. If none remain, the response is rejected and not paid.

## Errors

| Status | Meaning | Buyer action |
| --- | --- | --- |
| 409 | `revision` is stale | Refresh describe and retry once |
| 422 | No candidate can be ranked | Fail the turn without inference |
| 402 | Payment problem | Existing payment negotiation |

Non-success responses are not charged.

## Buyer flow

1. Describe the selected routing service (cached for 60 seconds).
2. Build candidates from eligible sellers whose model is in
   `supportedServiceIds`.
3. Resolve the buyer's choices against the described `preferences` and call rank.
4. Validate the response (a well-formed ranking is billed as one completed request) and
   send the inference to the first recommendation. Later recommendations are
   fallbacks for retryable inference errors.

The buyer-side implementation is the built-in `ModelRoutingClient` in
`@antseed/router-core`. It is selected by the advertised `model-routing`
service API protocol, not by a router plugin.
Types and validators are in `@antseed/protocol` (`@antseed/protocol/model-routing`).
