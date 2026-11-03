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
| `POST /v1/systemone` | Typed questions to decision models; see the [decisions skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-decisions) |
| `POST /api/v1/video/queue`, `POST /api/v1/video/retrieve` | Venice-format video jobs |
| `POST /fal/v1/video/queue`, `POST /fal/v1/video/retrieve` | fal-format video jobs, with the fal endpoint id as `model` |
| `GET /v1/models`, `GET /v1/models/<id>` | Network-wide model catalog, answered locally and free. Filter with `?type=text`, `images`, `videos` or `decisions`. Routing services are listed only under `?type=router` |

Your tool's format does not need to match the seller's. The proxy translates between Anthropic Messages, OpenAI Chat Completions and OpenAI Responses when needed. Image endpoints are never translated: the seller must serve `openai-images`.

For video and image pricing, see [Media billing](/docs/provide/media). For how `/v1/models` ranks offers, see [Routing and catalog](/docs/api/routing).

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

## Choose the model and seller

The `model` field controls routing:

| Value | Routing |
|---|---|
| `<peerId>@deepseek-v4-flash` | Pins this request to one seller. No failover. |
| `deepseek-v4-flash` | Automatic routing: the buyer picks the cheapest seller of that model that passes your minimum trust score, and fails over after retryable errors. See [Routing and catalog](/docs/api/routing). |
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
| `x-antseed-peer-reputation` | Seller's reputation score |

Streaming responses carry only the request id, seller identity and price headers, because token counts are not known when headers are sent. For authoritative per-channel totals, run `antseed buyer metering`.

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `missing_routing_target` | The request has no model and no pin. |
| 400 | `no_default_route` | `model: "antseed"` was sent but the desktop app has no model selected. |
| 400 | `invalid_routing` | A routing service serves the request and the body's `routing` object is malformed or has a setting the router's protocol does not accept (for `irp-suggest`: `cost_quality_tradeoff`, an integer from 0 to 10). On other requests a `routing` object is removed and ignored. |
| 422 | `no_eligible_candidates` | A routing service was named, but no allowed model is left for it to rank. Nothing was charged. |
| 402 | `insufficient_deposits` | Not enough USDC deposited. Run `antseed buyer deposit`. |
| 413 | `upload_body_too_large` | The request is larger than the seller's upload limit. |
| 502 | `model_not_found` | No seller your routing preferences allow offers this model. |

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
