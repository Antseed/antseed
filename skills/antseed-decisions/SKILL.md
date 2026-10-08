---
name: antseed-decisions
description: Ask a System One decision model (TypeSafe Jev) typed questions about some state through the user's local Antseed buyer proxy. Use when the user needs a classification, a score against a rubric, or a yes/no probability over text or structured data, when code must branch on the answer, or when the user names Jev, System One, TypeSafe, or a decision model. Not for generating text or chatting.
---

# Antseed Decisions

Get typed, calibrated answers from a System One decision model through the user's local Antseed buyer proxy. The model does not write text. It evaluates a `state` against typed `questions` and returns one `answer` per question with probabilities and confidence, so the calling code can branch on the result.

Upstream reference for the request contract: https://docs.typesafe.ai/ (Quick start, Primitives, Confidence). This skill only covers what is specific to sending those requests through Antseed.

## When to use it

Use a decision model instead of a chat model when the output is a decision, not prose:

- Classify a message, ticket, record, or event into one of a fixed set of options.
- Score content against ordered, described levels (severity, sentiment, quality, urgency).
- Answer a yes/no question with a probability the code can threshold.
- Route work: pick a handler, a queue, a specialist model, or a human.
- Gate an action on confidence: act automatically when confident, escalate otherwise.

Ask several questions in one call; they are evaluated in parallel against the same state and the cost is dominated by the state, not the question count. Do not use a decision model to draft, summarize, translate, or converse.

## Prerequisites

- Antseed Desktop or `antseed buyer start` must be running on CLI 0.1.161 or later.
- The buyer must have enough deposited USDC for an eligible seller serving the model.
- The default buyer endpoint is `http://127.0.0.1:8377`. Use a different port only when the user provides one.

## Parameters

- `model` — decision model id or alias; optional when the user has not chosen one
- `state` — the content to evaluate: a string, or a JSON object or array for structured data such as a chat log or a record
- `questions` — a JSON object keyed by question id; each entry is one of the three primitives below
- `proxy_url` — optional buyer URL; default `http://127.0.0.1:8377`

### Question primitives

- `noul` — a yes/no question. Returns `noul`, a probability from 0 (no) to 1 (yes). Optional `criteria: { "true": "...", "false": "..." }` describes what each end means.
- `choice` — pick one option. Requires `criteria`, a map of option name to rubric description (use `null` for an option that needs no detail). Returns `choice`, `probabilities` per option, and `confidence`.
- `score` — rate against ordered levels. `criteria` is an ordered array of level descriptions. Returns `score` (probability-weighted, may fall between levels), `legend`, `probabilities` per level, and `confidence`.

Every question has `type` and `instructions`. Write instructions as a plain question or statement about the state.

## Discover the Decision Model

Always fetch the current decision catalog before sending:

```bash
proxy_url="${proxy_url:-http://127.0.0.1:8377}"
curl --fail-with-body \
  -H 'authorization: Bearer antseed-desktop' \
  "$proxy_url/v1/models?type=decisions"
```

The endpoint is answered locally and returns network-wide decision models. Each entry has `type: "decision"` and `supported_protocols` containing `typesafe-systemone`. If `model` was provided, match it case-insensitively against each entry's `id` and `aliases`, then use the matched entry's bare `id`. If no model was provided and exactly one decision model is listed, use it; otherwise ask the user. Use `GET /v1/models/<id>` for the model's ranked offers, pricing, and `context_length`.

Do not construct `<peer_id>@<service_id>` and do not send `x-antseed-pin-peer`. A bare model id lets the buyer proxy apply its Price + Trust preferences and fail over when another eligible serving peer is needed.

## Ask the Questions

Send the request to `<proxy_url>/v1/systemone`. Build the JSON with `jq` or another encoder; do not interpolate unescaped user content into JSON.

```bash
proxy_url="${proxy_url:-http://127.0.0.1:8377}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

curl --fail-with-body "$proxy_url/v1/systemone" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer antseed-desktop' \
  --data-binary "$(jq -n \
    --arg model "$model" \
    --arg state "$state" \
    '{
      model: $model,
      state: $state,
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: {
            billing: "Payments, invoicing, refunds",
            technical: "Bugs, outages, integrations",
            sales: "Pricing or account questions"
          }
        },
        frustration: {
          type: "score",
          instructions: "How frustrated does the customer appear?",
          criteria: ["Calm, stating facts", "Frustrated but civil", "Very angry, strong language"]
        },
        is_urgent: {
          type: "noul",
          instructions: "The message conveys urgency or time sensitivity"
        }
      }
    }')" \
  --output "$response_file"

jq '.answers' "$response_file"
```

The response is a single JSON document, never a stream:

```json
{
  "model": "jev-latest",
  "answers": {
    "department": { "type": "choice", "choice": "billing", "probabilities": { "billing": 0.84, "technical": 0.15, "sales": 0.01 }, "confidence": 0.6 },
    "frustration": { "type": "score", "score": 1.04, "legend": { "0": "Calm, stating facts", "1": "Frustrated but civil", "2": "Very angry, strong language" }, "probabilities": { "0": 0.2, "1": 0.56, "2": 0.24 }, "confidence": 0.84 },
    "is_urgent": { "type": "noul", "noul": 0.99 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```

Read `answers[<id>]` by the question id you sent. Treat `probabilities` and `confidence` as the signal: a `choice` with low confidence should be escalated or confirmed, not acted on blindly. Set thresholds in code rather than asking the model to decide what "confident enough" means.

### Using the TypeSafe SDKs instead of curl

The official TypeSafe Python and JavaScript clients work unchanged against the buyer proxy. Point them at it and the proxy handles discovery, routing, and payment:

```bash
export TYPESAFE_BASE_URL=http://127.0.0.1:8377
export TYPESAFE_API_KEY=antseed-desktop
```

## Safety and Output Rules

- Never print authorization headers, private keys, or full API responses into chat or logs. Show the user the `answers` object, or the specific fields they asked for.
- Do not expose the local buyer proxy beyond loopback.
- Keep `state` within the model's advertised `context_length`. Pass structured data as JSON, not as a stringified blob, when the source is structured.
- Do not add fields beyond `model`, `state`, and `questions`. Sellers relay the request as-is; unsupported fields are rejected upstream.
- Requests are billed on input tokens. Batch related questions into one call instead of repeating the state per question.
- After the call, tell the user which model answered and summarize each answer with its probability or confidence.

## Errors

- `missing_routing_target`: the request reached the proxy without a model. Ensure the JSON body contains the bare decision model id.
- `model_not_found`: refresh `/v1/models?type=decisions` and resolve the requested id or alias again.
- `unsupported_protocol` (HTTP 400): the model was requested on a chat path, or a chat model was sent to `/v1/systemone`. Use `/v1/systemone` only with models listed under `type=decisions`.
- HTTP 402: the buyer needs additional deposited USDC or payment-channel capacity.
- HTTP 404 on `/v1/systemone`: the buyer proxy predates decision support. Update Antseed Desktop or `@antseed/cli` to 0.1.161 or later.
- HTTP 502: no policy-allowed serving peer completed the request after proxy routing and fallback.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
