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

Image and video services are not health-probed, because a probe would generate a paid result. The Venice and fal video plugins instead check for free on each health sweep: Venice reads the key's balance and its public model list, and fal reads its model list, plus the balance when `FAL_VIDEO_API_KEY` has fal's `billing:usage:read` permission. Without that permission the fal seller logs at startup that its balance check is off, and keeps selling. A model that fails these checks is unadvertised, and advertised again once they pass.

## Routing services

A routing service ranks other sellers for a buyer request; it does not serve inference. Routing is a service category, not one API: each routing API is its own service API protocol with its own provider plugin, and none is a default. Today's routing protocol is `irp-suggest` ([Inference Routing Protocol](https://github.com/inference-routing/spec) suggest-only mode). Bill one `completed_requests` unit per well-formed ranking. IRP paths name no service, so a seller can offer only one `irp-suggest` service.

```json title="provider service settings"
{
  "services": ["alpha-route"],
  "serviceApiProtocols": { "alpha-route": ["irp-suggest"] },
  "serviceUnitBillingModels": {
    "alpha-route": {
      "irp-suggest": { "version": 1, "components": [{ "unit": "completed_requests", "priceUsd": 0.001 }] }
    }
  }
}
```

The ranking price is separate from the token price of the seller that serves the inference. Errors and malformed rankings are not billed. Older buyers reject announcements containing `completed_requests`, so run routing services on separate peers until buyers upgrade. See [Model Routing](/docs/model-routing).

Routing plugins:

- `irp-router` serves any IRP router you run or use, forwarding both IRP endpoints to its URL:

```bash
antseed config seller add-provider router --plugin irp-router --base-url https://router.example.com
antseed config seller add-service router my-router --input 0 --output 0
```

- `free-model-router` answers the IRP endpoints itself, lists `*` so buyers send candidates from their own catalog, ranks the free ones by their live Artificial Analysis score, and is free by default:

```bash
antseed config seller add-provider router --plugin free-model-router
antseed config seller add-service router free-model-router --input 0 --output 0
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

At startup the plugin also reads `GET /api/v1/models?type=video` and announces the queue fields each model takes as `supportedParameters`, so buyers send only those. If your server has no model list, set `supportedParameters` in `--capabilities` yourself, for example `["duration","image_url","prompt","resolution"]`.

### fal.ai models

The `fal-video` plugin relays fal's queue API. The service ID must be the fal endpoint ID (at most 64 characters), and every service needs `fal-video` pricing:

```bash
export FAL_VIDEO_API_KEY=<your-fal-key>
antseed config seller add-provider fal --plugin fal-video

antseed config seller add-service fal <fal-endpoint-id> \
  --unit-billing-models '{"fal-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.1}]}}'
```

Requests are passed to fal unchanged, except that `duration` is removed for video edit endpoints that take none. At startup the seller announces each endpoint's input field names from fal's schema as `supportedParameters`, so buyers can use the model's own field names (for example `start_image_url` for Kling V3).

### Video edit models

Video-to-video models take a buyer's source video (`video_url`) and change part of it: a new character from an image (MiniMax H3 Max Recast, Kling V3 motion control), or a text instruction (Kling v4 edit, Wan 2.7 edit). Add them like any other video service; the plugin does the rest at startup:

- It reads the model's inputs (fal's schema, or Venice's model list) and announces `video` in `capabilities.video.inputs`, so buyers route edits only to you when you take them. It also announces the required inputs and resolutions, and, for fal endpoints whose output is as long as the source, the whole-second durations from fal's source limits.
- It does not check the source; the upstream does. Buyers using the `antseed-videos` skill check the source against the provider's published limits before they pay.
- A job the upstream rejects (for example Recast on a video without a person) is reported as `FAILED`, and its payment channel is closed at once at what the buyer signed so far. For a video above $1.00 that is the opening fee. fal bills nothing for a failed job, and Venice refunds it.
- On fal, it removes `duration` for endpoints that take none. On Venice, it turns Venice's HTML `413` for a body above 32.5 MB into a JSON `413 request_too_large`.

Price edits per second of output with `video_seconds`. Buyers send the source length as `duration`, so that is what they pay for. Fold the upstream's input costs into the rate: fal bills Kling v4 edit on input plus output seconds, and Venice bills Recast on the source length.

```bash
# fal: MiniMax H3 Max Recast at fal's list price ($0.30/s 768P, $0.45/s 1080P) plus a margin
antseed config seller add-service fal minimax/h3-max/recast \
  --unit-billing-models '{"fal-video":{"version":1,"components":[
    {"unit":"video_seconds","priceUsd":0.33,"match":{"resolution":"768P"}},
    {"unit":"video_seconds","priceUsd":0.5,"match":{"resolution":"1080P"}}]}}'

# Venice: the same model; Venice quoted about $0.357/s of source at 768P and $0.536/s at 1080P
antseed config seller add-service video minimax-h3-max-recast \
  --unit-billing-models '{"venice-video":{"version":1,"components":[
    {"unit":"video_seconds","priceUsd":0.4,"match":{"resolution":"768P"}},
    {"unit":"video_seconds","priceUsd":0.6,"match":{"resolution":"1080P"}}]}}'
```

Upstream prices change; check fal's model page or Venice's video quote before you set yours. Buyers refuse any single video above $5.00, so at these rates a Recast edit fits up to about 15 s at 768P.

The source travels inside the request: inline up to the 64 MiB request limit (about 47 MB of video; 32.5 MB of request on Venice), or as a public `https` URL the upstream fetches. For an edit whose output is as long as its source, which the upstream bills for the whole source, the seller measures the source, which must be inline, and answers `422 invalid_video_duration` before calling the upstream unless `duration` is its length in whole seconds, rounded down. A large inline source is uploaded to you twice, once before the payment channel opens and once after.

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
