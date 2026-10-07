---
sidebar_position: 6
slug: /model-routing
title: Model Routing
hide_title: true
---

# Model Routing

A **routing service** is a seller service that ranks where a buyer should send a request. It does not run the inference. The buyer sends the inference to the chosen seller and pays that seller normally.

Routing services use [Inference Routing Protocol](https://github.com/inference-routing/spec/blob/main/SPEC.md) (IRP) **suggest-only mode** without AntSeed-specific headers or fields. Seller identity stays with the buyer.

:::note Routing service vs. router plugin
A [router plugin](/docs/router-api) is local buyer policy. A routing service is a paid service offered by another peer on the network. Buyers use the built-in `ModelRoutingClient` in `@antseed/router-core` for routing services; no router plugin is required.
:::

## Endpoints

| Endpoint | Cost | Purpose |
| --- | --- | --- |
| `GET /v1/routing/models` | Free, rate limited | Models the router can score |
| `POST /v1/routing/rank` | One completed request | Ranks the buyer's allowed candidates for one user turn |

A seller advertises a routing service with the `model-routing` API protocol and offers **at most one** routing service. Buyers ignore peers that advertise more than one.

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

Buyers cache the list for 60 seconds and only send candidates whose model the router lists. A seller service matches a listed model exactly, or otherwise by canonical model key, so `claude-opus-5` can match `anthropic/claude-opus-5`.

## Rank request

```json
{
  "request": {
    "messages": [
      { "role": "system", "content": "You are a coding agent." },
      { "role": "user", "content": "Refactor this function" }
    ],
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
      }
    ]
  }
}
```

- `request` is the request as an OpenAI Chat Completions body. Anthropic Messages and OpenAI Responses requests are converted first. `model`, `stream`, and `stream_options` are omitted.
- `cost_quality_tradeoff` is an integer from `0` (best quality) to `10` (cheapest acceptable candidate). If it is omitted, the router uses IRP's default, `5`.
- `candidates` contains only destinations allowed by the buyer's trust, price, pin, and model filters. The same model from two sellers is two candidates.
- `id` is `provider:model@peer`, or a `sha256:` hash when that would exceed 128 characters.
- `model` uses the router's model name. The buyer still sends the seller's own service ID with the inference request.
- `pricing` is in USD per 1M tokens. `expected_usage.cache_read_tokens` is present when the buyer has observed cache reads for that destination earlier in the conversation.

## Rank response

```json
{
  "id": "rank_01J9",
  "object": "routing.ranking",
  "created": 1790000000,
  "router": { "id": "alpha", "version": "2026-10-01" },
  "ranked": [
    { "candidate_id": "openai:gpt-5.5@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expected_cost_usd": 0.0041 }
  ]
}
```

The buyer maps `candidate_id` values back to the candidates it sent and never parses them. Unknown and duplicate IDs are dropped. If none remain, the ranking is rejected and not charged.

## Billing

A well-formed ranking is one `completed_requests` unit, regardless of how many candidates it ranks. Errors and malformed rankings are zero units, so the buyer and seller both treat them as free. Routing uses the normal payment-channel flow; see [Payments](/docs/payments).

## Errors

Routers use IRP problem details (`application/problem+json`).

| Status | Type | Buyer action |
| --- | --- | --- |
| 400 | `urn:irp:problem:invalid-request` | Fail the turn |
| 402 | `urn:irp:problem:payment-required` | Run normal payment negotiation |
| 422 | `urn:irp:problem:no-scorable-candidate` | Refresh models and retry once |
| 503 | `urn:irp:problem:unavailable` | Fail the turn; `Retry-After` may be set |

## Buyer flow

1. Fetch the routing service's model list.
2. Build candidates from eligible sellers whose models the router lists.
3. Pay for one ranking and send the inference to the first candidate.
4. On retryable inference errors, try later ranked candidates without buying another ranking.

Tool-loop continuations of the same user turn reuse the ranking. Routing charges count toward the conversation's spend.

:::warning Privacy
The routing service receives the full conversation needed to rank the turn. Select only routers you trust with that content.
:::
