---
name: antseed-videos
description: Generate videos from text prompts or images through the user's local Antseed buyer proxy. Use when the user asks to create, generate, or make a video or animation with Antseed, with or without a specific video model.
---

# Antseed Videos

Generate a video through the user's local Antseed buyer proxy using network-wide model discovery and automatic peer routing. Video jobs are asynchronous: queue the job, poll until the finished MP4 arrives, then save it.

## Prerequisites

- Antseed Desktop or `antseed buyer start` must be running.
- The buyer must have enough deposited USDC for the video's price. The buyer pays once, when the finished MP4 is delivered, and refuses videos priced above $5.00.
- The default buyer endpoint is `http://127.0.0.1:8377`. Use a different port only when the user provides one.

## Parameters

- `model` — video model id or alias; optional only when the user has not chosen a model yet
- `prompt` — the user's video description
- `duration` — length in seconds; required (see below)
- `resolution` — required when the model advertises more than one
- `aspect_ratio` — optional; send only a value the model advertises
- `image` — optional path or HTTPS URL of a starting frame, for image-to-video models
- `output` — optional destination path; default `generated-video.mp4`
- `proxy_url` — optional buyer URL; default `http://127.0.0.1:8377`

## Discover the Video Model

Always fetch the current video catalog before generating:

```bash
proxy_url="${proxy_url:-http://127.0.0.1:8377}"
curl --fail-with-body \
  -H 'authorization: Bearer antseed-desktop' \
  "$proxy_url/v1/models?type=videos"
```

The endpoint is answered locally and returns network-wide video models. If `model` was provided, match it case-insensitively against each entry's `id` and `aliases`, then use the matched entry's bare `id`. Several fal models share short aliases such as `text-to-video`, so prefer an exact `id` match and ask the user when an alias matches more than one model. If no model was provided, pick an obvious match for the request (text-to-video when there is no image, image-to-video when there is one) or ask the user when the choice is material.

Then fetch the selected model's offers:

```bash
curl --fail-with-body \
  -H 'authorization: Bearer antseed-desktop' \
  "$proxy_url/v1/models/$(jq -rn --arg id "$model" '$id|@uri')"
```

Each entry in `peers` has:

- `protocol` — `venice-video` or `fal-video`; it decides the request format below
- `capabilities.video` — `durationsSeconds`, `resolutions`, `aspectRatios`, `inputs` (`first_frame`, `last_frame`, `reference_image`, …), `requiredInputs`, and `audio`. A missing field means unknown, not unsupported.
- `unitBillingModels.<protocol>.components` — the price

Do not construct `<peer_id>@<service_id>` and do not send `x-antseed-pin-peer`. A bare model id lets the buyer proxy apply its Price + Trust preferences and fail over between eligible sellers.

## Choose Options and Check the Price

- **Duration**: always send one. Pick a value from `durationsSeconds`; use the user's value when it is listed, otherwise the closest listed value, and tell the user. Never send `auto`: per-second pricing needs an explicit duration, and the buyer rejects the request without one.
- **Resolution**: when `resolutions` is advertised, send one of them exactly as written (case matters, for example `768P`). Sellers price by resolution, and a request that matches no price component is refused. Default to the lowest resolution unless the user asked for more.
- **Aspect ratio**: send only when the user asked for one and it is listed.
- **Image input**: for a model whose `requiredInputs` contains `first_frame`, an image is required; for a text-only model (`inputs: []`), do not send one.

Compute the price before queueing. Add every component whose `match` is absent or equals the request's values (`resolution`, `model`):

- `video_generations`: `priceUsd` once per video
- `video_seconds`: `priceUsd` × duration in seconds

If offers differ in price, quote the cheapest. If the price is above $5.00, pick a shorter duration or lower resolution, because the buyer refuses it. Tell the user the price and get confirmation before queueing anything above $1.00 unless they already set a budget.

## Queue the Job

Build the body with `jq`; do not interpolate an unescaped prompt into JSON.

**`venice-video`** — duration as a string with an `s` suffix:

```bash
queue_file="$(mktemp)"
curl --fail-with-body "$proxy_url/api/v1/video/queue" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer antseed-desktop' \
  --data-binary "$(jq -n \
    --arg model "$model" --arg prompt "$prompt" \
    --arg duration "${duration}s" --arg resolution "$resolution" \
    '{model: $model, prompt: $prompt, duration: $duration}
     + (if $resolution != "" then {resolution: $resolution} else {} end)')" \
  --output "$queue_file"
job_id="$(jq -r '.queue_id // empty' "$queue_file")"
```

For image-to-video, add `image_url` (a public HTTPS URL, or a `data:` URL built from a local file).

**`fal-video`** — the body is the fal model's own input plus `model`. Send `duration` in the form that model's fal input schema uses (many take a string such as `"5"`, some an integer); add `resolution` and `aspect_ratio` when advertised. Image fields are model-specific (`image_url`, `start_image_url`, `end_image_url`); check the model's fal API page when unsure.

```bash
curl --fail-with-body "$proxy_url/fal/v1/video/queue" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer antseed-desktop' \
  --data-binary "$(jq -n \
    --arg model "$model" --arg prompt "$prompt" --arg duration "$duration" \
    --arg resolution "$resolution" \
    '{model: $model, prompt: $prompt, duration: $duration}
     + (if $resolution != "" then {resolution: $resolution} else {} end)')" \
  --output "$queue_file"
job_id="$(jq -r '.request_id // empty' "$queue_file")"
```

A missing job id means the queue failed: read the error from the response (see Errors) instead of retrying blindly. Queue each video once. Re-sending the create starts and pays for a second video.

## Poll and Save

Poll the retrieve endpoint with the same `model` and the job id. The buyer routes it back to the seller that accepted the job. While the job runs, the response is JSON; when it finishes, the response is `video/mp4`. Polling and downloading are free.

```bash
output="${output:-generated-video.mp4}"
case "$protocol" in
  venice-video) retrieve_path=/api/v1/video/retrieve; id_field=queue_id ;;
  fal-video)    retrieve_path=/fal/v1/video/retrieve; id_field=request_id ;;
esac
body="$(jq -n --arg model "$model" --arg id "$job_id" --arg f "$id_field" '{model: $model} + {($f): $id}')"
part="$(mktemp)"
for _ in $(seq 1 120); do
  type="$(curl -s "$proxy_url$retrieve_path" \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer antseed-desktop' \
    --data-binary "$body" \
    -o "$part" -w '%{content_type}')"
  case "$type" in
    video/mp4*) mv "$part" "$output"; break ;;
  esac
  status="$(jq -r '.status // empty' "$part" 2>/dev/null)"
  case "$status" in FAILED|ERROR|CANCELLED) break ;; esac
  sleep 10
done
```

Stop on `FAILED`, `ERROR`, or `CANCELLED`: the job ended and is not charged. Videos commonly take 1 to 10 minutes. If the loop ends without a video, report the last status and the job id so the user can retry the retrieve later; do not queue a new job.

## Safety and Output Rules

- Never print or paste video bytes, base64 image data, download URLs, authorization headers, private keys, or full API responses into chat or logs.
- Do not expose the local buyer proxy beyond loopback.
- Generate one video per request unless the user explicitly asks for more, and state the total price first.
- Do not guess optional parameters; send only values the model advertises or the user supplies.
- After saving, tell the user the file path, model id, duration, resolution, and price. Show the video when the agent environment supports it.

## Errors

- HTTP `402` with `insufficient_deposits` or a credits message: the buyer needs more deposited USDC.
- HTTP `402` with `one_off_channel_required`: the buyer opened the video's payment channel but retried before the seller registered it. Buyers before `@antseed/cli@0.1.171` hit this; update the buyer. Each failed attempt leaves a funded channel that `antseed buyer channels request-close <channelId>` releases.
- Price above $5.00 or "above the configured limit": choose a shorter duration or lower resolution.
- "Explicit video duration is required" or "No billing component matched": send a listed `duration`, and a listed `resolution` when the model advertises any.
- `model_not_found`: refresh `/v1/models?type=videos` and resolve the id again.
- HTTP `502`: no policy-allowed serving peer accepted the job.
- Connection refused: start Antseed Desktop or `antseed buyer start`.
