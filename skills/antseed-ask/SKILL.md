---
name: antseed-ask
description: Ask another AI model a question through the user's Antseed gateway, without switching the agent's own model. Use when the user says "ask <model> on Antseed", "using Antseed, ask…", wants a second opinion, wants to compare answers across models, or needs a model the agent does not have (for example an open-weight or specialist model). Not for images or videos; use antseed-images and antseed-videos for those.
---

# Antseed Ask

Send one prompt to a text model on the Antseed network through the user's gateway and bring the answer back. The agent keeps its own model; Antseed is a second API it calls when the user asks.

## Prerequisites

- Antseed Desktop (or an Antseed gateway) is running.
- Gateway: the commands set `proxy_url` from `$ANTSEED_PROXY_URL`, and send the key in `$ANTSEED_API_KEY`. Antseed Desktop sets both in its own chat and writes its gateway into the copies it adds to an agent. Run the `proxy_url=` line as written, and always go through `$proxy_url`; never hard-code an address or port.
- When a command stops with "No Antseed gateway found", stop and ask the user which gateway to use. Offer:
  1. Antseed Desktop: in **Agents & apps**, add the skills to this agent, or copy the address and key with **Copy setup prompt**.
  2. Another gateway, such as their team's: its URL and an API key for it.
  3. Their own CLI buyer at `http://127.0.0.1:8377`, only if they say they run `antseed buyer start` themselves. It takes no key and skips a gateway's limits and usage.

  Export the answer as `ANTSEED_PROXY_URL` and `ANTSEED_API_KEY`. Never set `ANTSEED_PROXY_URL` yourself without the user's answer.
- `curl` and `jq`.
- Paid models need a funded balance; the catalog marks free offers.

## Parameters

- `model` — model id or alias; optional when the user has not named one
- `prompt` — what to ask; include the context the other model needs, since it does not see this conversation
- `system` — optional system prompt

## Pick the model

```bash
proxy_url="${proxy_url:-${ANTSEED_PROXY_URL:?No Antseed gateway found. Ask the user which gateway to use and do not pick one yourself.}}"
curl --fail-with-body \
  -H "authorization: Bearer ${ANTSEED_API_KEY:-antseed-desktop}" \
  "$proxy_url/v1/models?type=text" | jq '[.data[] | {id, name, aliases}]'
```

Match a requested model case-insensitively against each entry's `id` and `aliases` and use the bare `id`. If the user named none, pick one that fits the question and say which. When cost matters, read its offers and prices from its entry in that list (`peers`); the gateway serves only the list, not `/v1/models/<id>`.

Send the bare model id. Do not construct `<peer_id>@<model>`: the gateway routes by the user's routing policy and fails over between sellers.

## Ask

Build the body with `jq` so the prompt is escaped. Check the status before reading the answer: an error body has no answer, and piping it straight into `jq` would print `null` and look like success.

```bash
body_file="$(mktemp)"
status="$(curl -sS -o "$body_file" -w '%{http_code}' "$proxy_url/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${ANTSEED_API_KEY:-antseed-desktop}" \
  --data-binary "$(jq -n --arg model "$model" --arg prompt "$prompt" --arg system "${system:-}" \
    '{model: $model, messages: ((if $system == "" then [] else [{role: "system", content: $system}] end) + [{role: "user", content: $prompt}])}')")"
if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "HTTP $status: $(jq -r '.error.message // .' "$body_file" 2>/dev/null || cat "$body_file")" >&2
else
  jq -er '.choices[0].message.content' "$body_file"
fi
rm -f "$body_file"
```

A non-2xx status, or `jq -e` failing on an empty answer, is an error: handle it as below.

Show the answer to the user, attributed to the model that wrote it. To compare models, ask each one the same prompt and show the answers side by side.

## Errors

- `402` or a funds error: the balance is empty or too low for this model. Tell the user to add funds in Antseed Desktop, or pick a free model.
- `403` or a routing-policy error: the user's gateway does not allow this model. Name the model and suggest an allowed one from the catalog.
- No answer or a timeout: retry once, then try another model.
