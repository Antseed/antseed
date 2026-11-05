---
name: antseed-ask
description: Ask another AI model a question through the user's Antseed gateway, without switching the agent's own model. Use when the user says "ask <model> on Antseed", "using Antseed, ask…", wants a second opinion, wants to compare answers across models, or needs a model the agent does not have (for example an open-weight or specialist model). Not for images or videos; use antseed-images and antseed-videos for those.
---

# Antseed Ask

Send one prompt to a text model on the Antseed network through the user's gateway and bring the answer back. The agent keeps its own model; Antseed is a second API it calls when the user asks.

## Prerequisites

- Antseed Desktop (or an Antseed gateway) is running.
- Gateway URL: `$ANTSEED_PROXY_URL` when it is set, otherwise `http://127.0.0.1:8377`. API key: `$ANTSEED_API_KEY`, otherwise `antseed-desktop`. Always go through `$proxy_url`; never hard-code a port.
- `curl` and `jq`.
- Paid models need a funded balance; the catalog marks free offers.

## Parameters

- `model` — model id or alias; optional when the user has not named one
- `prompt` — what to ask; include the context the other model needs, since it does not see this conversation
- `system` — optional system prompt

## Pick the model

```bash
proxy_url="${proxy_url:-${ANTSEED_PROXY_URL:-http://127.0.0.1:8377}}"
curl --fail-with-body \
  -H "authorization: Bearer ${ANTSEED_API_KEY:-antseed-desktop}" \
  "$proxy_url/v1/models?type=text" | jq '[.data[] | {id, name, aliases}]'
```

Match a requested model case-insensitively against each entry's `id` and `aliases` and use the bare `id`. If the user named none, pick one that fits the question and say which. Use `GET /v1/models/<id>` for its offers and prices when cost matters.

Send the bare model id. Do not construct `<peer_id>@<model>`: the gateway routes by the user's routing policy and fails over between sellers.

## Ask

Build the body with `jq` so the prompt is escaped:

```bash
curl --fail-with-body "$proxy_url/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${ANTSEED_API_KEY:-antseed-desktop}" \
  --data-binary "$(jq -n --arg model "$model" --arg prompt "$prompt" --arg system "${system:-}" \
    '{model: $model, messages: ((if $system == "" then [] else [{role: "system", content: $system}] end) + [{role: "user", content: $prompt}])}')" \
  | jq -r '.choices[0].message.content'
```

Show the answer to the user, attributed to the model that wrote it. To compare models, ask each one the same prompt and show the answers side by side.

## Errors

- `402` or a funds error: the balance is empty or too low for this model. Tell the user to add funds in Antseed Desktop, or pick a free model.
- `403` or a routing-policy error: the user's gateway does not allow this model. Name the model and suggest an allowed one from the catalog.
- No answer or a timeout: retry once, then try another model.
