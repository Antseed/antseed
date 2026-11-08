---
slug: /api
title: Use the local buyer proxy (no gateway)
sidebar_label: Local buyer proxy
description: Call Antseed through the local buyer proxy on localhost:8377, without a gateway, API keys or budgets.
---

# Use the local buyer proxy (no gateway)

The local buyer proxy is the part of Antseed that finds sellers and pays them. It serves an OpenAI- and Anthropic-compatible API on `http://localhost:8377`, bound to `127.0.0.1` only, with no API keys, budgets or usage logs.

:::tip Need keys, budgets, or access from other machines?
Use the gateway instead. It puts API keys, spend limits, routing policies and logs in front of the same buyer. See [Gateway API](/docs/gateway/api).
:::

## Start the buyer

The desktop app runs the buyer for you while its router is on. Without the desktop app:

```bash
npm install -g @antseed/cli
antseed buyer start
```

`antseed buyer start` works without a config file, using built-in defaults (port `8377`). Free models work right away. For paid models, run `antseed buyer deposit` to get a funding address for USDC on Base.

Base URLs:

- OpenAI-compatible clients: `http://localhost:8377/v1`
- Anthropic clients: `http://localhost:8377` (they add `/v1/messages` themselves)

The proxy does not check API keys. If a client insists on one, use any non-empty placeholder such as `antseed`.

```bash
curl http://localhost:8377/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "<peerId>@deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Reach it from other machines

The buyer proxy only listens on `127.0.0.1`. `antseed buyer start` has no `--host` flag, and `config.json` has no buyer host setting: a `host` key there is ignored. This is deliberate. The proxy has no API keys and spends from your deposit, so anything that can reach it can spend your funds.

To call it from another machine, forward the port over SSH or put the gateway in front of the buyer. The gateway adds API keys and spend limits, and it can listen beyond loopback:

- **Just you, over SSH**: keep the buyer on loopback and forward its port: `ssh -N -L 8377:127.0.0.1:8377 user@buyer-host`, then use `http://localhost:8377` on your own machine. No gateway is needed.
- **Your private network**: `antseed gateway start --host 0.0.0.0 --public-url http://<this-machine>:8379`, then call `http://<this-machine>:8379/v1` with a gateway API key. This is plain HTTP, so API keys cross the network unencrypted; use it only on a network you trust. See [Gateway troubleshooting](/docs/gateway/troubleshooting).
- **The internet**: publish the gateway over HTTPS with a [tunnel](/docs/tunnels) or [install it on a server](/docs/gateway/server).

Do not publish port 8377 itself, for example with a router port forward, `socat` or a reverse proxy: anyone who reaches it can spend your deposit. The proxy also refuses requests whose `Host` header is not a loopback name or an IP address.

## Endpoints

| Endpoint | Format |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses (Codex) |
| `POST /v1/messages` | Anthropic Messages (Claude Code) |
| `POST /v1/messages/count_tokens` | Anthropic token counting, answered locally, never routed or billed |
| `POST /v1/images/generations` | OpenAI image generation |
| `POST /v1/images/edits` | OpenAI image editing (multipart) |
| `POST /v1/audio/speech` | OpenAI text to speech; the audio file comes back as it is |
| `POST /v1/systemone` | Typed questions to decision models; see the [decisions skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-decisions) |
| `POST /api/v1/video/queue`, `POST /api/v1/video/retrieve` | Venice-format video jobs |
| `POST /fal/v1/video/queue`, `POST /fal/v1/video/retrieve` | fal-format video jobs, with the fal endpoint id as `model` |
| `GET /v1/models`, `GET /v1/models/<id>` | Network-wide model catalog, answered locally and free. Filter with `?type=text`, `images`, `videos`, `speech` or `decisions`. Routing services are listed only under `?type=router` |

Your tool's format does not need to match the seller's. The proxy translates between Anthropic Messages, OpenAI Chat Completions and OpenAI Responses when needed. Image and speech endpoints are never translated: the seller must serve `openai-images` or `openai-audio-speech`.

For video, image and speech pricing, see [Media billing](/docs/provide/media). For how `/v1/models` ranks offers, see [Routing and catalog](/docs/api/routing).

### Video jobs

```bash
# Queue a job; the response includes a queue_id
curl http://localhost:8377/api/v1/video/queue \
  -H 'content-type: application/json' \
  -d '{"model": "<peerId>@<video-model>", "prompt": "A tiny ant carrying a seed", "duration": "5s"}'

# Poll until the response is video/mp4 instead of a JSON status
curl http://localhost:8377/api/v1/video/retrieve \
  -H 'content-type: application/json' \
  -d '{"model": "<peerId>@<video-model>", "queue_id": "<queue_id>"}' -o result.out
```

Retrieve requests always go to the seller that accepted the job. You pay once, when the finished MP4 is delivered, and the buyer refuses videos priced above $5.00.

#### Edit a video

Video edit models (`inputs` has `video` in `GET /v1/models?type=videos`) take your video as `video_url` and change part of it. Send the video inline as a data URL, or as a public `https` URL. Every edit model needs it inline: the seller measures it and answers `422 invalid_video_duration` for a URL or a `duration` that is not its length. Set `duration` to the video's length in whole seconds, rounded down (`ffprobe -v error -show_entries format=duration -of csv=p=0 dance.mp4`); that is what you pay for. For a shorter clip, trim the video first.

```bash
jq -n --rawfile video <(printf 'data:video/mp4;base64,'; base64 < dance.mp4 | tr -d '\n') \
  '{model: "<peerId>@minimax-h3-max-recast", video_url: $video, duration: "12s",
    reference_image_urls: ["https://example.com/me.png"], resolution: "768P"}' > edit.json
curl http://localhost:8377/api/v1/video/queue -H 'content-type: application/json' -H 'Expect:' --data-binary @edit.json
```

On fal, `duration` is a number (`12`). A request is at most 64 MiB including base64 (about 47 MB of video); Venice sellers accept at most 32.5 MB, images included. Send `resolution` exactly as the seller lists it (`768P` for Recast, `720p` for Kling and Wan).

Sellers do not check the source; the upstream does. Check it first against the model's published limits: fal's schema (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<model>`, `x-fal` on `video_url`) or Venice's model list and docs. The `antseed-videos` skill does this for you. A source or field the upstream refuses, or a job that fails after it started (for example Recast or motion control on a video without a person), is closed at once. A video priced above $1.00 then costs the payment channel's opening fee ($0.65 on Base), a cheaper one nothing.

#### Lip-sync a video to audio

Models whose seller announces `audio_url` in `supportedParameters` (`audio` in `capabilities.video.inputs`) animate a character to an audio file, for example narration you recorded or generated with [text to speech](#text-to-speech). Send it as `audio_url`, a data URL or a public `https` URL (WAV or MP3, at most 30 s and 15 MB on Venice). Automatic routing then only picks sellers that take it. The video is priced as usual; the audio adds nothing.

```bash
jq -n --rawfile face <(printf 'data:image/png;base64,'; base64 < face.png | tr -d '\n') \
      --rawfile voice <(printf 'data:audio/mpeg;base64,'; base64 < hello.mp3 | tr -d '\n') \
  '{model: "<peerId>@<video-model>", prompt: "She looks into the camera and says hello",
    image_url: $face, audio_url: $voice, duration: "5s", resolution: "720p", aspect_ratio: "16:9"}' > lipsync.json
curl http://localhost:8377/api/v1/video/queue -H 'content-type: application/json' -H 'Expect:' --data-binary @lipsync.json
```

Talking-avatar models (`audio` in `capabilities.video.requiredInputs`, no `duration` in `supportedParameters`; for example fal's `fal-ai/kling-video/ai-avatar/v2/pro`) make a video as long as the audio and take no duration of their own. The length you pay for is still `duration`, and it must be the audio's length in whole seconds, rounded down (`ffprobe -v error -show_entries format=duration -of csv=p=0 hello.mp3`). Send the audio inline as an MP3 or WAV data URL: the seller measures it and answers `422 invalid_video_duration` for a URL, another format, or a `duration` that is not its length, before any payment. The seller removes `duration` before calling fal.

```bash
jq -n --rawfile face <(printf 'data:image/png;base64,'; base64 < face.png | tr -d '\n') \
      --rawfile voice <(printf 'data:audio/mpeg;base64,'; base64 < hello.mp3 | tr -d '\n') \
  '{model: "<peerId>@fal-ai/kling-video/ai-avatar/v2/pro", prompt: "She smiles warmly",
    image_url: $face, audio_url: $voice, duration: 7}' > avatar.json
curl http://localhost:8377/fal/v1/video/queue -H 'content-type: application/json' -H 'Expect:' --data-binary @avatar.json
```

### Edit images

`POST /v1/images/edits` takes OpenAI's multipart form: `model`, `prompt`, and one `image` file, or several as `image[]` (the OpenAI SDKs send a list that way). Automatic routing only picks sellers that announce `image` in `supportedParameters`. The answer is an OpenAI images response with `b64_json`.

```bash
curl http://localhost:8377/v1/images/edits \
  -H 'x-antseed-pin-peer: <peerId>' \
  -F model=qwen-image-3-pro \
  -F prompt='Put the cat from the second image on the sofa' \
  -F 'image[]=@./sofa.png' -F 'image[]=@./cat.png' \
  | jq -r '.data[0].b64_json' | base64 --decode > edited.png
```

Image edits are billed per delivered output image (plus any token prices the seller sets). Venice edits take only `n=1`, so a Venice edit is one image however many images it takes in. What else a seller accepts (`quality`, `resolution`, `aspect_ratio`, `moderation`) is listed in its `supportedParameters`.

### Text to speech

`POST /v1/audio/speech` takes OpenAI's JSON body (`model`, `input`, `voice`, optional `response_format` and `speed`) and returns the audio file. Find speech models and their voices with `GET /v1/models?type=speech`: each offer lists its voices under `capabilities.speech.voices`, and `voices` on the model lists those every seller of it accepts.

```bash
curl -s http://localhost:8377/v1/models?type=speech | jq '.data[] | {id, voices}'

curl http://localhost:8377/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model": "<peerId>@tts-kokoro", "input": "Hello from Antseed.", "voice": "af_sky"}' \
  -o hello.mp3
```

You pay per character of `input`, only when audio comes back. A voice the seller does not offer is refused with `400 unsupported_voice` and the list of its voices; you never get a different voice than the one you asked for. Without `voice`, the seller's upstream picks its default voice; some upstreams (OpenAI) require one, so send a voice the seller lists.

## Choose the model and seller

The `model` field controls routing:

| Value | Routing |
|---|---|
| `<peerId>@deepseek-v4-flash` | Pins this request to one seller. No failover. |
| `deepseek-v4-flash` | Automatic routing: among the sellers of that model that pass your minimum trust score, the buyer weighs price against speed and recent success for this request, and fails over after retryable errors. See [Routing and catalog](/docs/api/routing). |
| `<routerPeerId>@<routerServiceId>` | A routing service picks the model and seller for each request. See [Use a routing service](/docs/api/routing#use-a-routing-service). |
| `antseed` | Follows the model, seller or router picked in the desktop app. Returns `no_default_route` when the app has no selection. |

The peer id is 40 hex characters, with or without `0x`. The prefix is stripped before the request reaches the seller.

You can also pin outside the model field:

| Mechanism | Scope |
|---|---|
| Header `x-antseed-pin-peer: <peerId>` | One request. Use it for multipart `/v1/images/edits`, where the model prefix is not rewritten. |
| `antseed buyer connection set --peer <peerId>` | Every request until `antseed buyer connection clear`. Survives a buyer restart. |

When several apply, the header wins, then the model prefix, then the session pin.

```bash
antseed network browse                    # peers, services and prices
antseed network browse --service deepseek # filter by service
antseed network peer <peerId>             # one peer in detail
curl -s http://localhost:8377/v1/models | jq '.data[].id'
```

## Tools

- **Desktop app**: connect Claude Code, Codex, OpenCode and others from **Connected apps**. See [Desktop app](/docs/desktop).
- **CLI wrappers**: `antseed claude`, `antseed codex` and `antseed opencode` launch the tool against the running buyer and pass your other flags through:

  ```bash
  antseed claude --model <peerId>@kimi-k2.6
  antseed codex --model <peerId>@deepseek-v4-flash
  antseed opencode --model <peerId>@gpt-oss-120b
  ```

- **`antseed apps`** connects local tools by editing their config files.
- **Manual**: set the base URL above and a placeholder key, for example `ANTHROPIC_BASE_URL=http://localhost:8377` and `ANTHROPIC_API_KEY=antseed` for Claude Code.

Tool-specific guides are in the [Integrations directory](/integrations). For Hermes and OpenClaw, see [Connect agents](/docs/agents).

## Response headers

Non-streaming responses carry telemetry headers:

| Header | Value |
|---|---|
| `x-antseed-request-id` | Request id |
| `x-antseed-peer-id` | Seller that served the request |
| `x-antseed-provider`, `x-antseed-service` | Seller's provider plugin and service id |
| `x-antseed-input-tokens`, `x-antseed-cached-input-tokens`, `x-antseed-output-tokens`, `x-antseed-total-tokens` | Token counts |
| `x-antseed-token-source` | Where the counts came from |
| `x-antseed-estimated-cost-usd` | Estimated cost |
| `x-antseed-input-usd-per-million`, `x-antseed-output-usd-per-million`, `x-antseed-cached-input-usd-per-million` | Seller's advertised prices |
| `x-antseed-latency-ms` | Latency |
| `x-antseed-peer-address`, `x-antseed-peer-providers` | Seller's network address and provider plugins |
| `x-antseed-peer-current-load`, `x-antseed-peer-max-concurrency` | Seller's announced load and request limit |
| `x-antseed-unit-priced` | `1` when the seller charges for this service per unit (an image, a second of video, a speech character), so zero token prices don't make it free; else `0` |
| `x-antseed-route-selection` | On model-routed requests: why this seller served it, as base64url JSON. See [Which seller served a request](/docs/api/routing#which-seller-served-a-request). |

Streaming responses carry only the request id, seller identity, price and route-selection headers, plus `x-antseed-first-token-ms`, because token counts are not known when headers are sent. For authoritative per-channel totals, run `antseed buyer metering`.

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `missing_routing_target` | The request has no model and no pin. |
| 400 | `no_default_route` | `model: "antseed"` was sent but the desktop app has no model selected. |
| 400 | `invalid_routing` | A routing service serves the request and the body's `routing` object is malformed or has a setting the router's protocol does not accept (for `irp-suggest`: `cost_quality_tradeoff`, an integer from 0 to 10). On other requests a `routing` object is removed and ignored. |
| 422 | `no_eligible_candidates` | A routing service was named, but no allowed model is left for it to rank. Nothing was charged. |
| 402 | `antseed_buyer_fault` with `insufficient_deposits` | The wallet has too few credits for a paid seller. Run `antseed buyer deposit` to show your funding address, or add funds in the desktop app. Free sellers need no funds: pin one as `<peerId>@<model>`. |
| 413 | `upload_body_too_large` | The request is larger than the seller's upload limit. |
| 502 | `model_not_found` | No seller your routing preferences allow offers this model. |
| 503 | `discovery_in_progress` | The buyer started less than two minutes ago and is still discovering sellers. It has not found a seller it can use for this model yet. Retry after the `Retry-After` seconds. |

The 402 comes back with the code `antseed_buyer_fault`, which marks a failure on the buyer's side, not the seller's. In OpenAI format the reason is in `error.param`:

```json
{"error":{"type":"api_error","code":"antseed_buyer_fault","param":"insufficient_deposits","message":"You are out of AntSeed credits for this request. ..."}}
```

In Anthropic format (`/v1/messages`) `error.type` is `antseed_buyer_fault` and the message ends with the reason in brackets, for example `(insufficient_deposits)`.

## Diagnostics

The proxy serves a local control plane under `/_antseed/` that the desktop app uses:

```bash
curl -s http://localhost:8377/_antseed/status     # DHT node count, peer count, uptime
curl -s http://localhost:8377/_antseed/peers      # cached peers with pricing and reputation
curl -s -X POST http://localhost:8377/_antseed/peers/refresh
curl -s http://localhost:8377/_antseed/channels   # your open payment channels
```

For Prometheus metrics, see [Metrics](/docs/provide/metrics).

## Run more than one buyer

Each buyer needs its own data directory. To pay from several wallets with one buyer, add buyer identities and pick one per request with the `x-antseed-buyer-identity` header; see [Gateway API](/docs/gateway/api). Data directories, routing preferences and price caps are covered in [Buyer configuration](/docs/buyer-config).
