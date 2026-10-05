---
name: antseed-images
description: Generate images from text prompts through the user's local Antseed buyer proxy. Use when the user asks to create, generate, or make an image with Antseed, with or without a specific image model.
---

# Antseed Images

Generate an image through the user's local Antseed buyer proxy using network-wide model discovery and automatic peer routing.

## Prerequisites

- Antseed Desktop or `antseed buyer start` must be running.
- The buyer must have enough deposited USDC for an eligible seller serving the selected model.
- The default buyer endpoint is `http://127.0.0.1:8377`. Use a different port only when the user provides one.

## Parameters

Use these values for the request:

- `model` — image model id or alias; optional only when the user has not chosen a model yet
- `prompt` — the user's image description
- `output` — optional destination path
- `proxy_url` — optional buyer URL; default `http://127.0.0.1:8377`

## Discover the Image Model

Always fetch the current image catalog before generating:

```bash
proxy_url="${proxy_url:-http://127.0.0.1:8377}"
curl --fail-with-body \
  -H 'authorization: Bearer antseed-desktop' \
  "$proxy_url/v1/models?type=images"
```

The endpoint is answered locally and returns network-wide image models. If `model` was provided, match it case-insensitively against each entry's `id` and `aliases`, then use the matched entry's bare `id`. If no model was provided, inspect the available models and their capabilities; select an obvious match for the request or ask the user when the choice is material. Use `GET /v1/models/<id>` when you need the selected model's full ranked offers, protocols, pricing, and capabilities.

Do not construct `<peer_id>@<service_id>` and do not send `x-antseed-pin-peer`. A bare model id lets the buyer proxy apply its Price + Trust preferences and fail over when another eligible serving peer is needed.

## Generate an Image

Send an OpenAI-compatible request to `<proxy_url>/v1/images/generations`. Use a JSON encoder such as `jq`; do not interpolate an unescaped prompt into JSON.

Capture the response in a private temporary file, then decode `data[0].b64_json` directly into the output file without printing it:

```bash
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
output="${output:-generated-image.png}"

curl --fail-with-body "$proxy_url/v1/images/generations" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer antseed-desktop' \
  --data-binary "$(jq -n \
    --arg model "$model" \
    --arg prompt "$prompt" \
    '{model: $model, prompt: $prompt, n: 1, response_format: "b64_json"}')" \
  --output "$response_file"

jq -r '.data[0].b64_json // empty' "$response_file" | base64 --decode > "$output"
```

If the response contains `data[0].url` instead, download it immediately to the output file. Accept only an HTTPS URL. Do not follow redirects to private, loopback, link-local, or otherwise unsafe destinations.

## Safety and Output Rules

- Never print or paste image base64, generated-image URLs, authorization headers, private keys, or full API responses into chat or logs.
- Do not expose the local buyer proxy beyond loopback.
- Do not treat image bytes as text tokens.
- Request one image unless the user explicitly asks for more and the selected service supports it.
- Do not guess optional parameters such as `size`, `quality`, or `style`; seller capabilities differ. Send them only when the user supplies a supported value.
- Image generation may take several minutes. Wait for completion unless the user cancels.
- After generation, tell the user the saved file path and model id. Display the saved image when the agent environment supports it.

## Errors

- `missing_routing_target` (or `no_peer_pinned` from a pre-release proxy): the request reached the proxy without a model — ensure the JSON body contains the bare image model id.
- `model_not_found`: refresh `/v1/models?type=images` and resolve the requested id or alias again.
- HTTP `402`: the buyer needs additional deposited USDC or payment-channel capacity.
- HTTP `502`: no policy-allowed serving peer completed the request after proxy routing and fallback.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
