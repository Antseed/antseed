# Model routing protocol

`model-routing` lets a seller rank which inference destination should serve a
request. The router only ranks; the buyer still sends the inference to the
chosen seller and pays that seller normally.

The wire format is [Inference Routing Protocol](https://github.com/inference-routing/spec/blob/main/SPEC.md)
(IRP) **suggest-only mode**, unchanged. AntSeed adds nothing to IRP bodies:
which routing service is being bought travels in a header, and seller identity
stays on the buyer.

A routing seller advertises a service with API protocol `model-routing` and
a completed-request unit billing model (see
[unit-billing-services.md](unit-billing-services.md)).

## Endpoints

| Endpoint | Cost | Purpose |
| --- | --- | --- |
| `GET /v1/routing/models` | Free, rate limited | IRP §4: models the router can score |
| `POST /v1/routing/rank` | One completed request | IRP §5: candidates ranked best first, for one user turn |

Both requests carry two AntSeed transport headers:

| Header | Meaning |
| --- | --- |
| `x-antseed-provider` | Seller provider that serves the routing service (as for every AntSeed request) |
| `x-antseed-service` | Routing service ID being described or bought. Sellers use it to pick the provider and the paid offer |

## Models

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5.5", "object": "model" },
    { "id": "claude-sonnet-4-6", "object": "model" }
  ]
}
```

Buyers only send candidates whose model is listed, cache the list for 60
seconds and ignore members they do not recognise. AntSeed routers run in
suggest-only mode, so entries carry no `candidates`.

## Rank

Request:

```json
{
  "request": {
    "messages": [
      { "role": "system", "content": "You are a coding agent." },
      { "role": "user", "content": "Refactor this function" }
    ],
    "tools": [{ "type": "function", "function": { "name": "read_file", "parameters": { "type": "object" } } }],
    "max_tokens": 4096
  },
  "routing": {
    "cost_quality_tradeoff": 3,
    "candidates": [
      {
        "id": "openai:gpt-5.5@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "model": "gpt-5.5",
        "pricing": { "input": 1.25, "cache_read": 0.125, "output": 10 },
        "expected_usage": { "cache_read_tokens": 900 }
      },
      {
        "id": "openai:gpt-5.5@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "model": "gpt-5.5",
        "pricing": { "input": 1.1, "cache_read": 1.1, "output": 9 }
      }
    ]
  }
}
```

- `request` is the inference request as an
  [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
  body (system prompt, history, tool calls and results, tools, images). Anthropic
  Messages and OpenAI Responses requests are converted with the `@antseed/api-adapter`
  request adapters; the buyer still sends the original request to the chosen seller.
  `model`, `stream` and `stream_options` are omitted. Content with no Chat Completions
  equivalent (Anthropic thinking and document blocks, cache markers) is dropped.
- `cost_quality_tradeoff` is an integer from `0` (best quality regardless of price)
  to `10` (cheapest acceptable candidate). It is omitted when the buyer has not chosen
  one, and the router uses IRP's default, `5`.
- `candidates` are the exact destinations the buyer allows, after its own trust, price
  and pin filters. The same model from two sellers is two candidates.
  - `id` is `provider:model@peer`. If that is longer than 128 characters, it is
    `sha256:` followed by the hex SHA-256 of the same string. Routers may use the ID to
    tell sellers apart and to learn per seller.
  - `model` is the AntSeed service ID.
  - `pricing` is the seller's price in USD per 1M tokens. Sellers that publish no
    cached-input price bill cache reads at the input price, so `cache_read` equals `input`.
  - `expected_usage.cache_read_tokens` is the buyer's estimate of prompt tokens this
    destination can serve from its cache, observed on earlier turns of the conversation.
    It is omitted when nothing was observed.

Response:

```json
{
  "id": "rank_01J9",
  "object": "routing.ranking",
  "created": 1790000000,
  "router": { "id": "alpha", "version": "2026-10-01" },
  "ranked": [
    { "candidate_id": "openai:gpt-5.5@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "expected_cost_usd": 0.0041, "reasoning_effort": "low" },
    { "candidate_id": "openai:gpt-5.5@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  ]
}
```

The buyer maps each `candidate_id` back through the candidates it sent and never
parses it, so a router cannot name a destination the buyer filtered out. Unknown and
duplicate IDs are dropped. If none remain, the response is rejected and not paid.
Optional predictions (`expected_quality`, `expected_cost_usd`, `expected_usage`,
`reasoning_effort`) are kept when well-formed. `reasoning_effort` is carried with the
recommendation but not yet applied to the inference request.

## Errors

Routers answer errors with IRP problem details (`application/problem+json`, RFC 9457).
The seller node uses the same format for the free models endpoint.

| Status | `type` | Buyer action |
| --- | --- | --- |
| 400 | `urn:irp:problem:invalid-request` | Fail the turn |
| 402 | `urn:irp:problem:payment-required` | Existing payment negotiation |
| 422 | `urn:irp:problem:no-scorable-candidate` | Refresh the model list and retry once, then fail the turn |
| 503 | `urn:irp:problem:unavailable` | Fail the turn; `Retry-After` may be set |

Non-success responses are not charged, so the 422 retry is free.

## Buyer flow

1. List the selected routing service's models (cached for 60 seconds).
2. Build candidates from eligible sellers whose model is listed.
3. Call rank with the buyer's `cost_quality_tradeoff`, if set.
4. Validate the response (a well-formed ranking is billed as one completed request) and
   send the inference to the first ranked candidate. Later candidates are fallbacks for
   retryable inference errors. Tool-loop continuations of the same user turn reuse the
   ranking instead of paying again (IRP §7).

The router receives the whole conversation, so buyers should only select routers
they would trust with that content.

The buyer-side implementation is the built-in `ModelRoutingClient` in
`@antseed/router-core`. It is selected by the advertised `model-routing`
service API protocol, not by a router plugin.
Types and validators are in `@antseed/protocol` (`@antseed/protocol/model-routing`).
