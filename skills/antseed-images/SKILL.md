---
name: antseed-images
description: Generate images from text prompts, or edit and combine existing images, through the user's local Antseed buyer proxy. Use when the user asks to create, generate, make, edit, restyle, or combine an image with Antseed, with or without a specific image model.
---

# Antseed Images

Generate an image, or edit one or more images the user has, through the user's local Antseed buyer proxy using network-wide model discovery and automatic peer routing.

## Prerequisites

- Antseed Desktop or `antseed buyer start` must be running.
- The buyer must have enough deposited USDC for an eligible seller serving the selected model.
- Buyer endpoint: use `$ANTSEED_PROXY_URL` when it is set (Antseed Desktop and `pnpm testbench` set it to the active buyer proxy); otherwise `http://127.0.0.1:8377`. Never hard-code a port in commands; always go through `$proxy_url`.

## Parameters

Use these values for the request:

- `model` — image model id or alias; optional only when the user has not chosen a model yet
- `prompt` — the user's image description, or for an edit, what to change
- `images` — optional input image paths for an edit, base image first
- `output` — optional destination path
- `proxy_url` — optional buyer URL; default `$ANTSEED_PROXY_URL`, then `http://127.0.0.1:8377`

## Discover the Image Model

Always fetch the current image catalog before generating:

```bash
proxy_url="${proxy_url:-${ANTSEED_PROXY_URL:-http://127.0.0.1:8377}}"
curl --fail-with-body \
  -H 'authorization: Bearer antseed-desktop' \
  "$proxy_url/v1/models?type=images"
```

The endpoint is answered locally and returns network-wide image models. If `model` was provided, match it case-insensitively against each entry's `id` and `aliases`, then use the matched entry's bare `id`. If no model was provided, inspect the available models and their capabilities; select an obvious match for the request or ask the user when the choice is material. Use `GET /v1/models/<id>` when you need the selected model's full ranked offers, protocols, pricing, and capabilities.

Do not construct `<peer_id>@<service_id>` and do not send `x-antseed-pin-peer`. A bare model id lets the buyer proxy apply its Price + Trust preferences and fail over when another eligible serving peer is needed.

## Generate an Image

Send an OpenAI-compatible request to `<proxy_url>/v1/images/generations`. Use a JSON encoder such as `jq`; do not interpolate an unescaped prompt into JSON.

Capture the response in a private temporary file, then decode the image directly into the output file without printing it. Most sellers return `data[0].b64_json`; some return Venice's `images[0]`:

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

jq -r '.data[0].b64_json // .images[0] // empty' "$response_file" | base64 --decode > "$output"
[ -s "$output" ] || echo "no base64 image in response; check data[0].url" >&2
```

If the response contains `data[0].url` instead, download it immediately to the output file. Accept only an HTTPS URL. Do not follow redirects to private, loopback, link-local, or otherwise unsafe destinations.

## Edit Images

Use an edit when the user brings one or more images and wants them changed (restyle, change one thing, put a product or person from one image into another). Pick a model whose catalog entry lists `image` in `capabilities.supportedParameters`; automatic routing only sends edits to sellers that announce it. Address it with the same bare generation model id, for example `qwen-image-3-pro`.

Send OpenAI's multipart form to `<proxy_url>/v1/images/edits`: `model`, `prompt`, and each input image as an `image[]` file part, in order. The first image is the base; describe the others in the prompt by position ("the cat from the second image"). Use `-F` file parts so the images are never pasted into a command line or a JSON body:

```bash
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
output="${output:-edited-image.png}"

image_args=()
for image in "${images[@]}"; do image_args+=(-F "image[]=@$image"); done

curl --fail-with-body "$proxy_url/v1/images/edits" \
  -H 'authorization: Bearer antseed-desktop' \
  -F "model=$model" \
  -F "prompt=$prompt" \
  "${image_args[@]}" \
  --output "$response_file"

jq -r '.data[0].b64_json // empty' "$response_file" | base64 --decode > "$output"
[ -s "$output" ] || echo "no base64 image in response" >&2
```

- Edits are billed per delivered output image, like a generation. Ask for one output.
- Send optional fields (`quality`, `resolution`, `aspect_ratio`, `background`) only when the user asks for them and the model lists them in `supportedParameters`; send each one once. A seller refuses fields it does not take with `400`.
- Do not send a `mask`: sellers that edit through Venice refuse it. Describe the area to change in the prompt instead.
- Use PNG, JPEG, or WebP inputs. Keep each under a few MB; scale large photos down first.

## Safety and Output Rules

- Never print or paste image base64, generated-image URLs, authorization headers, private keys, or full API responses into chat or logs.
- Do not expose the local buyer proxy beyond loopback.
- Do not treat image bytes as text tokens.
- Report the saved image's path; do not open it with a file-reading tool to check it unless the user asks. Every image read stays in the chat and is resent on each turn.
- Request one image unless the user explicitly asks for more and the selected service supports it.
- Do not guess optional parameters such as `size`, `quality`, or `style`; seller capabilities differ. Send them only when the user supplies a supported value.
- Image generation may take several minutes. Wait for completion unless the user cancels.
- After generation, tell the user the saved file path and model id. Display the saved image when the agent environment supports it.

## Errors

- `missing_routing_target` (or `no_peer_pinned` from a pre-release proxy): the request reached the proxy without a model — ensure the JSON body contains the bare image model id.
- `model_not_found`: refresh `/v1/models?type=images` and resolve the requested id or alias again.
- HTTP `400` on an edit: the seller refused a field or the input; the `error.param` names it. Remove that field or fix the image and try once more.
- HTTP `402`: the buyer needs additional deposited USDC or payment-channel capacity.
- HTTP `502`: no policy-allowed serving peer completed the request after proxy routing and fallback.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
