---
title: Image and video services
slug: /provide/media
description: Sell image generation and video generation with per-image, per-video or per-second pricing instead of token pricing.
---

# Image and video services

Text services charge per token. Image and video services charge per unit instead: per generated image, per delivered video, or per second of video. You set this with `unitBillingModels` on the service, or the `--unit-billing-models` option of `antseed config seller add-service`.

Three built-in plugins support unit billing:

| Plugin | Protocol key | Units |
|---|---|---|
| `openai` | `openai-images` | `output_images` |
| `venice-video` | `venice-video` | `video_generations`, `video_seconds` |
| `fal-video` | `fal-video` | `video_generations`, `video_seconds` |

If you configure unit billing on a provider whose plugin doesn't support it, `antseed seller start` warns that the setting is ignored.

## Unit billing models

A unit billing model maps a protocol key to a list of priced components:

```json
{
  "openai-images": {
    "version": 1,
    "components": [
      { "unit": "output_images", "priceUsd": 0.003 }
    ]
  }
}
```

A component can carry a `match` object to price tiers. Match keys are `model`, `size`, `quality` and `resolution`, compared with the request's values. Every billed unit must match a component: a request that matches none is refused, not served for free.

Image and video services stay advertised without health checks, because a probe would generate a paid result.

## Routing services

A routing service ranks other sellers for a buyer request; it does not serve inference. Advertise it with the `model-routing` API protocol and bill one `completed_requests` unit per well-formed ranking. A seller can offer only one routing service.

```json title="provider service settings"
{
  "services": ["alpha-route"],
  "serviceApiProtocols": { "alpha-route": ["model-routing"] },
  "serviceUnitBillingModels": {
    "alpha-route": {
      "model-routing": { "version": 1, "components": [{ "unit": "completed_requests", "priceUsd": 0.001 }] }
    }
  }
}
```

The ranking price is separate from the token price of the seller that serves the inference. Errors and malformed rankings are not billed. Older buyers reject announcements containing `completed_requests`, so run routing services on separate peers until buyers upgrade. See [Model Routing](/docs/model-routing).

To offer routing without building a router, run the `default-router` plugin. It answers the routing endpoints itself, ranks the best free models on the network by their live Artificial Analysis score, and is free by default:

```bash
antseed config seller add-provider router --plugin default-router
antseed config seller add-service router default-router --input 0 --output 0
```

Free rankings count toward `seller.freeTier` like any other free service.

## Image services

The `openai` plugin serves the OpenAI Images API (`/v1/images/generations`, and `/v1/images/edits` when the service accepts image input). It advertises a service as an image service when the upstream model ID belongs to a known image model family, such as `qwen-image`, `flux-2-…`, `seedream-v4…`, `hunyuan-image-…`, `z-image-…` or `gpt-image-…`. Image services behind OpenRouter are not advertised.

```bash
antseed config seller add-provider images --plugin openai \
  --base-url https://api.example-inference.com

antseed config seller add-service images qwen-image \
  --input 0 --output 0 \
  --categories creative \
  --capabilities '{"inputs":["text"],"outputs":["image"],"supportedParameters":["size","output_format","seed"]}' \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.003}]}}'
```

Image services announce `outputs: ["image"]` automatically. The `inputs` you set is a routing promise:

- `["text"]`: generation only.
- `["text","image"]`: the service also accepts multipart `/v1/images/edits` requests.

Advertise image input only when this exact upstream model and plugin handle edit requests end to end, not merely because the upstream platform offers editing somewhere.

To price by size or quality, add one component per tier:

```json
{
  "openai-images": {
    "version": 1,
    "components": [
      { "unit": "output_images", "priceUsd": 0.003, "match": { "size": "1024x1024" } },
      { "unit": "output_images", "priceUsd": 0.006, "match": { "size": "1536x1024" } }
    ]
  }
}
```

## Video services

### Your own video model

Implement the [Venice video API](https://docs.venice.ai/api-reference/endpoint/video/queue) on your server, then point the `venice-video` plugin at it:

| Endpoint | Returns |
|---|---|
| `POST /api/v1/video/queue` | JSON with a `queue_id` |
| `POST /api/v1/video/retrieve` | JSON status while the job runs; `video/mp4` when it is finished |

```bash
export VENICE_VIDEO_API_KEY=<your-api-key>
antseed config seller add-provider video --plugin venice-video \
  --base-url https://video.example.com

antseed config seller add-service video <video-model> \
  --capabilities '{"video":{"durationsSeconds":[5,10],"resolutions":["720p"]}}' \
  --unit-billing-models '{"venice-video":{"version":1,"components":[{"unit":"video_generations","priceUsd":0.5}]}}'
```

The service ID is sent unchanged as `model` to your API, so don't set `--upstream`. A `status` of `FAILED`, `ERROR` or `CANCELLED` ends the job unpaid.

### fal.ai models

The `fal-video` plugin relays fal's queue API. The service ID must be the fal endpoint ID (at most 64 characters), and every service needs `fal-video` pricing:

```bash
export FAL_VIDEO_API_KEY=<your-fal-key>
antseed config seller add-provider fal --plugin fal-video

antseed config seller add-service fal <fal-endpoint-id> \
  --unit-billing-models '{"fal-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.1}]}}'
```

### Video pricing

| Unit | Charge |
|---|---|
| `video_generations` | `priceUsd` per delivered video |
| `video_seconds` | `priceUsd` × the requested `duration` in seconds |

Components can match the request's `resolution`:

```json
{
  "venice-video": {
    "version": 1,
    "components": [
      { "unit": "video_seconds", "priceUsd": 0.05, "match": { "resolution": "720p" } },
      { "unit": "video_seconds", "priceUsd": 0.1, "match": { "resolution": "1080p" } }
    ]
  }
}
```

- Buyers pay only when the finished video is delivered: a complete MP4 at least 90% of the requested duration and at most 64 MiB.
- `video_seconds` needs an explicit `duration` in the request. Use `video_generations` if buyers may send `auto`.
- Buyers refuse video requests priced above $5.00.

### Video capabilities

Describe what the model accepts under `capabilities.video`. Every field is optional, and buyers don't guess from absence.

| Field | Values |
|---|---|
| `durationsSeconds` | Whole seconds, for example `[5, 10]` |
| `resolutions` | For example `["720p", "1080p"]` |
| `aspectRatios` | For example `["16:9", "9:16"]` |
| `inputs` | Accepted media inputs: `first_frame`, `last_frame`, `reference_image`, `video`, `reference_video`, `audio`. Empty means text only. |
| `requiredInputs` | Inputs every request must include; each must also be in `inputs` |
| `audio` | Whether the output has audio |

For all other service settings, see [Seller configuration](/docs/provide/config).
