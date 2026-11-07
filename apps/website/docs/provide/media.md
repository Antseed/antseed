---
title: Image, video and speech services
slug: /provide/media
description: Sell image generation and editing, video generation and text-to-speech with per-image, per-video, per-second or per-character pricing instead of token pricing.
---

# Image, video and speech services

Text services charge per token. Image, video and speech services charge per unit instead: per generated image, per delivered video, per second of video, or per character read aloud. You set this with `unitBillingModels` on the service, or the `--unit-billing-models` option of `antseed config seller add-service`.

Three built-in plugins support unit billing:

| Plugin | Protocol key | Units |
|---|---|---|
| `openai` | `openai-images` | `output_images` |
| `openai` | `openai-audio-speech` | `input_characters` |
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

A component can carry a `match` object to price tiers. Match keys are `model`, `size`, `quality`, `resolution`, and for video `aspect_ratio` and `audio` (`"true"` or `"false"`), compared with the request's values. Components that match add up. A model holds up to 64 components (8 for buyers on metadata before v16; services using `aspect_ratio`, `audio` or more than 8 components need v16). Every billed unit must match a component: a request that matches none is refused, not served for free.

Image, video and speech services are not health-probed, because a probe would generate a paid result. The Venice and fal video plugins instead check for free on each health sweep: Venice reads the key's balance and its public model list, and fal reads its model list, plus the balance when `FAL_VIDEO_API_KEY` has fal's `billing:usage:read` permission. Without that permission the fal seller logs at startup that its balance check is off, and keeps selling. A model that fails these checks is announced as failing, so buyers skip it, and as healthy again once they pass.

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

Image services announce `outputs: ["image"]` automatically. Buyers route a multipart `/v1/images/edits` request automatically only to services that list `image` in `supportedParameters`; a request pinned to one seller goes there regardless. Set `inputs` to match:

- Generation only: `inputs: ["text"]`, no `image` parameter.
- Generation and edits: `inputs: ["text","image"]` and `image` in `supportedParameters`.

Announce edits only when this exact upstream model and plugin handle edit requests end to end, not merely because the upstream platform offers editing somewhere.

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

### Venice image edits

Venice has no OpenAI `/v1/images/edits`. Its edits run on separate edit models (`GET https://api.venice.ai/api/v1/models?type=inpaint`), so the `openai` plugin pairs a generation service with its edit model. Buyers call one service id for both: `/v1/images/generations` uses the generation model, `/v1/images/edits` the paired edit model.

```bash
antseed config seller add-service venice qwen-image-3-pro \
  --venice-edit-model qwen-image-3-pro-edit \
  --input 0 --output 0 \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.05}]}}'
```

This stores `"imageEditModel": "qwen-image-3-pro-edit"` under the service in `config.json`. The pairing is only accepted when the provider's base URL is Venice. A paired service announces `inputs: ["text","image"]` and adds `image` and `moderation` to its `supportedParameters`; an unpaired one announces `inputs: ["text"]` and answers edits with `400`.

The seller translates each edit:

| Buyer sends | Venice receives |
|---|---|
| One `image` file | `POST /api/v1/image/edit` |
| Several images (`image[]` parts, as the OpenAI SDK sends a list), or a `quality` field | `POST /api/v1/image/multi-edit`, first image as the base |
| `moderation: "low"` / `"auto"` | `safe_mode: false` / `true` |
| `aspect_ratio`, `resolution`, `output_format`, `quality`, `safe_mode`, `enhance_prompt`, `disable_prompt_optimization_thinking` | Passed through |

Venice answers with the image file; the seller returns it as an OpenAI images response, `{"created": …, "data": [{"b64_json": "…"}]}`, so the edit is billed as one `output_images` like a generation. Venice errors keep their status and are not billed. `mask`, `n` other than `1`, `response_format=url` and any other field are refused with `400` before calling Venice. How many images a model takes is up to Venice (`maxInputImages` in its model list, usually up to 6).

Generation and edits share the service's `openai-images` price, and seller startup warns when a paired service has none. Venice can charge more for an edit than for a generation (for some models, also per extra input image or for `2K`/`4K` output), so set the price to cover the dearer case.

## Speech services

The `openai` plugin serves the OpenAI speech API, `POST /v1/audio/speech` (JSON in, an audio file out), as the `openai-audio-speech` protocol. It advertises a service as a speech service when the upstream model ID is a text-to-speech model: OpenAI's `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts`, and Venice's `tts-…` models (`GET https://api.venice.ai/api/v1/models?type=tts`). Speech services announce `inputs: ["text"]` and `outputs: ["audio"]`.

Price speech per character of the `input` text with `input_characters`; `priceUsd` is the price of one character. Venice lists its prices per million characters, so divide by 1,000,000:

```bash
# Kokoro, an open-weight model, at $3.50 per million characters
antseed config seller add-service venice tts-kokoro \
  --unit-billing-models '{"openai-audio-speech":{"version":1,"components":[{"unit":"input_characters","priceUsd":0.0000035}]}}'
```

- A request is charged only when audio comes back (a `2xx` answer that is not JSON). A refused voice or any other error is free, even when the upstream labels its JSON error as audio.
- Characters are counted as Unicode code points of `input`, the same way on the buyer and the seller. Prices travel in peer metadata as 32-bit floats, about seven significant digits, which is far below a cent per request.
- The price is known before the request is sent (characters × `priceUsd`), and the buyer refuses a charge for more characters than it sent.

### Voices

Each speech service announces its voices under `capabilities.speech`:

| Field | Values |
|---|---|
| `voices` | Every voice name the service accepts, up to 128 |
| `customVoices` | `true` when the upstream also takes account-specific voice IDs that are not listed |
| `formats` | `response_format` values it can return, for example `["mp3","wav"]` |

A Venice speech service reads all three from Venice's model list at startup, unless you set `capabilities.speech.voices` yourself. Buyers see them in `GET /v1/models?type=speech`. When a service lists its voices and does not take custom voice IDs, the seller refuses any other voice with `400 unsupported_voice` and the list of voices, before calling the upstream or charging: a buyer never gets a different voice than the one it asked for. A request without `voice` gets the upstream's default voice where it has one; OpenAI requires a voice.

Speech services need metadata v15. Sellers leave them out of the metadata they serve to buyers that predate it, so those buyers keep seeing the seller's other services.

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

### Audio input (lip sync)

Some video models take an audio file and animate a character to it, for example a narration a face should speak (on Venice: models whose `model_spec.constraints.audio_input` is `true`, such as `seedance-2-5-reference-to-video-basic`, `wan-2.6-image-to-video` and `minimax-h3-reference-to-video`). Buyers send it as `audio_url`: a data URL or a public `https` URL, WAV or MP3, at most 30 s and 15 MB on Venice.

Announce `audio` in `capabilities.video.inputs`. The `venice-video` plugin then announces `audio_url` in `supportedParameters`, and buyers that send `audio_url` are routed only to services that announce it. When you set no `inputs`, the plugin follows Venice's `audio_input`. The audio is passed to the upstream unchanged and billed as part of the video, by the same `video_generations` or `video_seconds` price.

```bash
antseed config seller add-service video seedance-2-5-reference-to-video-basic \
  --capabilities '{"video":{"durationsSeconds":[5,10,15],"resolutions":["720p","480p"],"aspectRatios":["16:9","9:16","1:1"],"inputs":["first_frame","reference_image","audio"],"audio":true}}' \
  --unit-billing-models '{"venice-video":{"version":1,"components":[
    {"unit":"video_seconds","priceUsd":0.3,"match":{"resolution":"720p"}},
    {"unit":"video_seconds","priceUsd":0.13,"match":{"resolution":"480p"}}]}}'
```

Don't confuse it with `audio`, a `true`/`false` request field that turns on generated sound for models that make their own.

### Prices by aspect ratio and audio

Some upstreams charge differently for the same resolution and length depending on the aspect ratio or on generated sound (on Venice, Seedance at 480p for 4 s costs $0.51 at 16:9 and $0.67 at 21:9, and Veo costs less without audio). Match `aspect_ratio` and `audio` next to `resolution` to charge each its own price:

```json
{"venice-video":{"version":1,"components":[
  {"unit":"video_seconds","priceUsd":0.0701,"match":{"resolution":"480p","aspect_ratio":"16:9","audio":"true"}},
  {"unit":"video_seconds","priceUsd":0.0921,"match":{"resolution":"480p","aspect_ratio":"21:9","audio":"true"}}]}}
```

A create that leaves out `aspect_ratio` is priced at the first entry of `capabilities.video.aspectRatios`, and one that leaves out `audio` at `capabilities.video.audio`. The `venice-video` plugin sends Venice those same values, and refuses an aspect ratio you don't list (`422 unsupported_video_option`, before payment), so every create it serves has a price. On `fal-video` nothing is filled in: a create is priced by the options it names, so one that leaves out an option your components require is refused. A request no component matches is refused, not served for free.

### fal.ai models

The `fal-video` plugin relays fal's queue API. The service ID must be the fal endpoint ID (at most 64 characters), and every service needs `fal-video` pricing:

```bash
export FAL_VIDEO_API_KEY=<your-fal-key>
antseed config seller add-provider fal --plugin fal-video

antseed config seller add-service fal <fal-endpoint-id> \
  --unit-billing-models '{"fal-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.1}]}}'
```

Requests are passed to fal unchanged, except that `duration` is removed for video edit and talking-avatar endpoints that take none. At startup the seller announces each endpoint's input field names from fal's schema as `supportedParameters`, so buyers can use the model's own field names (for example `start_image_url` for Kling V3).

### Alibaba Cloud Model Studio models

The `alibaba-video` plugin relays Model Studio's video models, such as Wan 3.0 and HappyHorse. It serves the `fal-video` protocol, so buyers use it like any fal service, and every service needs `fal-video` pricing:

```bash
export ALIBABA_VIDEO_API_KEY=<your-model-studio-key>
antseed config seller add-provider alibaba-video --plugin alibaba-video

antseed config seller add-service alibaba-video wan3.0-video \
  --unit-billing-models '{"fal-video":{"version":1,"components":[
    {"unit":"video_seconds","priceUsd":0.06,"match":{"resolution":"480p"}},
    {"unit":"video_seconds","priceUsd":0.12,"match":{"resolution":"720p"}},
    {"unit":"video_seconds","priceUsd":0.24,"match":{"resolution":"1080p"}}]}}'
```

API keys belong to one region. The plugin uses the Singapore endpoint unless you set `baseUrl`. Buyers must send `duration`, and video and audio inputs are refused before payment, because Model Studio bills an input video on top of the output. The plugin translates text, first and last frames, and reference images. Each health sweep checks the key only: Model Studio has no free per-model check for video or a balance API, so an account out of credit shows up as a rejected create.

### Video edit models

Video-to-video models take a buyer's source video (`video_url`) and change part of it: a new character from an image (MiniMax H3 Max Recast, Kling V3 motion control), or a text instruction (Kling v4 edit, Wan 2.7 edit). Add them like any other video service; the plugin does the rest at startup:

- It reads the model's inputs (fal's schema, or Venice's model list) and announces `video` in `capabilities.video.inputs` and `video_url` in `supportedParameters`, so buyers route edits only to you when you take them. It also announces the required inputs and resolutions, and, on fal, the whole-second durations from fal's source limits.
- It checks only the source's length: `duration` must be the inline source's length in whole seconds, rounded down, or the create is answered `422 invalid_video_duration` before any payment, without calling the upstream. Otherwise the upstream checks the source. Buyers using the `antseed-videos` skill check the source against the provider's published limits before they pay.
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

The source travels inside the request: inline up to the 64 MiB request limit (about 47 MB of video; 32.5 MB of request on Venice), or as a public `https` URL the upstream fetches. For a video edit, which the upstream bills for at least the whole source, the seller measures the source, which must be inline, and answers `422 invalid_video_duration` before calling the upstream unless `duration` is its length in whole seconds, rounded down. A large inline source is uploaded to you twice, once before the payment channel opens and once after.

### Talking-avatar models

Some fal models animate a face image to an audio file and make a video exactly as long as the audio, with no `duration` field of their own, for example Kling AI Avatar v2 (`fal-ai/kling-video/ai-avatar/v2/pro` and `/standard`). fal bills them per second of that video. The plugin recognises them from fal's schema: `audio_url` is required, there is no `video_url`, and no field sets the length (`duration`, `num_frames`). For those it:

- announces `first_frame` (the face, `image_url`) and `audio` in `capabilities.video.inputs` and `requiredInputs`, and no `durationsSeconds`;
- measures the buyer's inline audio (MP3 or PCM WAV, read from its bytes) and answers `422 invalid_video_duration` before any payment, unless `duration` is its length in whole seconds, rounded down. Audio sent as a URL or in another format is refused the same way, because the seller cannot measure it;
- removes `duration` and uploads the audio to fal's file storage (kept for one day), because some of these endpoints take `audio_url` only as a URL.

If fal's schema can't be read at startup, a request with `audio_url` and no `video_url` is checked the same way, unless the service's configured `supportedParameters` include `duration` or `num_frames`.

Price them per second with `video_seconds`: the buyer's `duration` is the audio length, and the video is about as long, so the delivery check (at least 90% of `duration`) passes.

```bash
# Kling AI Avatar v2 at fal's list price ($0.115/s Pro, $0.0562/s Standard) plus a margin
antseed config seller add-service fal fal-ai/kling-video/ai-avatar/v2/pro \
  --capabilities '{"video":{"audio":true}}' \
  --unit-billing-models '{"fal-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.13}]}}'
antseed config seller add-service fal fal-ai/kling-video/ai-avatar/v2/standard \
  --capabilities '{"video":{"audio":true}}' \
  --unit-billing-models '{"fal-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.065}]}}'
```

Buyers refuse any single video above $5.00, so at these rates a Pro avatar fits up to about 38 s of audio.

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
| `inputs` | Accepted media inputs: `first_frame`, `last_frame`, `reference_image`, `video`, `reference_video`, `audio` (an audio file to lip-sync to, sent as `audio_url`). Empty means text only. |
| `requiredInputs` | Inputs every request must include; each must also be in `inputs` |
| `audio` | Whether the output has audio |

For all other service settings, see [Seller configuration](/docs/provide/config).
