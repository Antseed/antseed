# Native video API integration

AntSeed relays native Seedance and Venice video requests to seller-operated APIs. Models from other vendors can still be used through Venice; their separate native APIs are not supported. Sellers own execution, storage, and refund policy. AntSeed does not cache artifacts.

Finished Venice videos are streamed through the original seller; its API key never leaves the seller. Other providers and seller-hosted result URLs remain unchanged and must be accessible to buyers without seller credentials.

## Supported requests

| Protocol | Method | Native path |
| --- | --- | --- |
| `seedance-video` | POST | `/api/v3/contents/generations/tasks` |
| `seedance-video` | GET | `/api/v3/contents/generations/tasks/{id}` |
| `venice-video` | POST | `/api/v1/video/queue` |
| `venice-video` | POST | `/api/v1/video/retrieve` (status or streamed MP4) |

Both APIs use the body `model` as the service. Venice retrieve carries `queue_id` in the JSON body instead of the path; the seller rebuilds it as `{model, queue_id}` (plus `delete_media_on_completion`) from the owned job and routed service. Seedance `DELETE`, Venice `/api/v1/video/complete`, and `/api/v1/video/quote` are not relayed. Each API's paths, job ID field, and billing fields are declared in one table in `packages/api-adapter/src/native-video.ts`. Create requests use the same model routing as images: `antseed` resolves to the selected route, and `<peerId>@<model>` pins that peer and is rewritten to `<model>` before forwarding. Other body fields are unchanged. Video services appear in `GET /v1/models?type=videos`.

## Image-to-video and video inputs

The create endpoints are not text-only. AntSeed forwards the native JSON fields, including images, reference frames and video inputs; it does not convert these requests into image-generation or chat requests. No separate image-to-video endpoint or AntSeed upload service is needed.

Choose an upstream model that supports the requested input and advertise that exact model in the seller's allowed services and pricing. Upstream model-specific media constraints still apply. A text-only Venice model does not become image-capable just because `image_url` is present.

### Venice

Send this body to `POST /api/v1/video/queue`, replacing the model with an image-to-video model available to your seller:

```json
{
  "model": "<image-to-video-model>",
  "prompt": "Animate the scene with a slow camera pan",
  "image_url": "https://media.example/start.png",
  "duration": "5s",
  "resolution": "720p"
}
```

`image_url` also accepts an inline `data:image/png;base64,...` URL. Where supported by the model, `end_image_url` supplies a last frame and `reference_image_urls` supplies references. Video-input models use `video_url` or `reference_video_urls`. Poll/download with `/api/v1/video/retrieve` exactly as for text-to-video.

### Seedance

Send this body to `POST /api/v3/contents/generations/tasks` with a model available to your seller:

```json
{
  "model": "<seedance-model>",
  "content": [
    { "type": "text", "text": "Animate the scene with a slow camera pan" },
    { "type": "image_url", "image_url": { "url": "https://media.example/start.png" }, "role": "first_frame" }
  ],
  "duration": 5,
  "resolution": "720p"
}
```

Image URLs can also be inline data URLs. Models with the corresponding capability accept `last_frame` or `reference_image` roles. Native reference-video inputs use `{"type":"video_url","video_url":{"url":"https://media.example/input.mp4"},"role":"reference_video"}`. Poll the same task endpoint and download the returned `content.video_url`.

### Media access and verification

- URLs must be reachable by the upstream provider. A buyer's local file path, `localhost` URL, or private AntSeed download URL is not an upstream-accessible input. Use inline media or an upstream-accessible URL; AntSeed does not fetch arbitrary input URLs or upload local files for you.
- Requests containing inline images automatically use chunked P2P uploads when needed. The seller's default upload-body limit is 64 MiB, counting the whole JSON body and base64 overhead; this is separate from the output-video download limit.
- Existing seller-account-scoped media references are not automatically resolved or routed to their original seller. Download the media and supply an eligible inline input or accessible URL instead, subject to upstream restrictions. Seedance draft-task IDs use the existing ownership and seller-pinning flow.
- Image-to-video has mocked buyer → seller → upstream → result-download tests for both plugins, including large inline PNGs, WebRTC uploads, unchanged bodies, replay without duplicate charges, and free follow-ups. These tests do not validate a real upstream model's image quality or acceptance. Video-input fields have byte-preservation tests, not a live video-editing guarantee.

Native field references: [Venice queue](https://docs.venice.ai/api-reference/endpoint/video/queue), [BytePlus create task](https://docs.byteplus.com/en/docs/ModelArk/1520757) and [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk).

## Model options

Sellers can advertise what each video model accepts in `capabilities.video` (peer metadata v12):

```json
{
  "seedance-1-0-pro": {
    "video": {
      "durationsSeconds": [5, 10],
      "resolutions": ["720p", "1080p"],
      "aspectRatios": ["16:9", "9:16"],
      "inputs": ["first_frame", "last_frame"],
      "requiredInputs": [],
      "audio": false
    }
  }
}
```

Input kinds are `first_frame`, `last_frame`, `reference_image`, `video`, `reference_video`, and `audio`; `inputs: []` means text only. Every field is optional, and an omitted field is not checked. The seller rejects such creates with `400 unsupported_video_options` before payment or any upstream call. Automatic durations, polling and downloads are never checked.

Venice sellers fill these options automatically from `GET /api/v1/models?type=video` at startup. Configured options take precedence. Seedance sellers set them through service `capabilities` or `ANTSEED_SERVICE_CAPABILITIES_JSON`.

## Billing

Discovery billing entries retain their existing wire IDs: Seedance `10` and Venice `11`. ID `7` is retired (formerly Veo) and IDs `6`, `8`, and `9` are unused; removing a provider must not renumber the remaining protocols.

A create is charged when the seller returns an accepted job ID: Seedance `id` or Venice `queue_id`. Polling is free. Pricing uses `video_generations` or `video_seconds`; per-second pricing requires an explicit positive duration (`duration`). Venice durations such as `"5s"` are read as seconds. Seedance `-1`, Seedance `frames`, and Venice `auto`, `-1`, and `1 gen` requests have no explicit duration, so they need `video_generations` pricing. Each create bills one video.

### Videos above the first reserve

The buyer rejects a create whose price, computed from the seller's advertised unit pricing, is above `maxVideoRequestUsdc` (default `5000000`, $5.00). A cheaper video that does not fit into the reserve locked on-chain raises the channel before the create is sent:

1. The buyer prepays up to `TOP_UP_SETTLED_THRESHOLD_BPS` of the current deposit (85% today) with a plain cumulative SpendingAuth. The prepayment is always smaller than the video price.
2. In the same exchange, the buyer signs a ReserveAuth for `current cumulative + maxVideoRequestUsdc`, or only `current cumulative + video price` when its deposits cannot cover the full limit. The seller's `topUp()` settles the prepayment and locks the new ceiling in one transaction.
3. The buyer waits until the new deposit is visible on-chain (up to 45 seconds), then sends the create.

The acceptance charge is cumulative, so it only adds the video price minus the prepayment. Later videos on the same channel fit into the raised ceiling, and unused reserve is released when the channel closes. The first reserve still respects `FIRST_SIGN_CAP`; no contract change is involved. If the buyer's deposits cannot cover even the video price, the create fails with `buyer-deposits-insufficient` (HTTP 402 from the proxy); if the top-up is not confirmed in time, with `buyer-reserve-topup-timeout` (HTTP 504), and the prepayment stays as credit on the channel.

## Routing and ownership

### Streamed downloads

Venice `/api/v1/video/retrieve` is always sent as a streamed download to a seller advertising `videoDownload = "video-stream-v1"` (the Venice plugin always does). While the job runs the seller returns Venice's JSON status unchanged; once finished it streams the MP4 using the flow below. Private Venice models return JSON `COMPLETED` and deliver the file through the `download_url` from the queue response, which is passed to the buyer unchanged. Venice bills some moderation rejections itself, so a create is still charged once accepted.

Venice MP4 responses without `Content-Length` are staged in a seller-local private temporary file to determine the length required by response-auth v1, then streamed through the same authenticated P2P path. This uses one upstream fetch and bounded memory; the existing 4 GiB limit and two-download concurrency limit also apply during staging. Temporary files are removed on completion, cancellation or failure. Known-length responses do not use disk. No buyer-visible bytes arrive during staging, so the buyer's 60-second idle timeout can still cancel a slow preparation.

### Download streaming

Streamed downloads require the selected provider and service to advertise `serviceCapabilities[service].videoDownload = "video-stream-v1"` in signed metadata. Metadata stays at v12: bit 3 of the service capability value byte signals `video-stream-v1`, and bit 4 signals video options appended after the supported-parameter list (when present). Entries without these video fields retain the existing v12 encoding. Older buyers reject the unknown value bits and cannot use the seller's announcement; they do not silently skip the video fields. Requesting a streamed download from an unsupported seller returns 501.

Each download uses one P2P request, one ownership check and one upstream retrieve. The request carries `x-antseed-video-download: video-stream-v1`; the successful response carries that marker and `x-antseed-streaming: 1`. MP4 data travels in chunks of at most 64 KiB, below TCP and WebRTC frame limits. The buyer acknowledges a chunk only after its HTTP client drains; the seller waits for that acknowledgement before sending another. `HttpResponseAck` (0x27) uses the response-chunk codec with empty data and echoes the acknowledged frame's message ID. `HttpRequestCancel` (0x28) uses the same codec with empty data and aborts only the named request, including upstream fetching. Connection loss also aborts seller work.

Downloads may be up to 4 GiB (the largest length the streamed response hash encodes). There is no total time limit, so any video finishes on a slow link; a transfer is cancelled only after 60 seconds without progress. Two downloads run concurrently per buyer process and per seller provider, and each chunk has a 30-second acknowledgement timeout. Download requests are Venice JSON POSTs of at most 4 KiB. This initial version requires a positive, bounded upstream `Content-Length`; absent or invalid lengths fail before video bytes are forwarded. Actual bytes are checked against that length, so truncated or excessive responses fail too. The local HTTP response uses chunked transfer so it cannot appear complete before the P2P end frame. Midstream errors use `HttpResponseError`, never JSON or SSE inserted into the video, and the local HTTP response is destroyed. Browser seeking and resumable client ranges are not supported yet.

Both peers incrementally compute the existing response-auth v1 hash over the encoded response headers, declared body length and actual bytes. No new signature format is introduced and neither peer reconstructs the complete file in memory. The in-process response carries an empty body and a locally computed `streamedBody` descriptor (byte length and response hash); that descriptor is not accepted from wire frames. Receipt verification retains its existing asynchronous behavior. Video bytes are not retained for response sampling.

Downloads and repeated downloads are free; they do not create a new job or change acceptance-based billing. Expired or missing files, unfinished jobs, and upstream failures return errors instead of switching sellers or generating another video. Retaining a job route does not extend upstream file retention.

The buyer proxy stores accepted job routes in `buyer.state.json` for 30 days, so status and download requests go back to the same seller, provider, and service. Unknown jobs return `404`.

The seller node stores `(protocol, job ID) -> buyer peer ID` in `resources.db`. Status and download requests from another buyer return `404` before reaching the seller API. Video requests are refused if this storage is unavailable.

Seedance creates can reference an earlier draft task (`content[].type = "draft_task"`, `draft_task.id`). The buyer proxy sends such a create to the seller that owns the draft, and returns `404 video_route_not_found` for unknown drafts or drafts owned by different sellers. The seller also rejects the create with `404` unless this buyer owns every referenced draft. The account-wide Seedance task list (`GET /api/v3/contents/generations/tasks`) is not relayed because it would expose other buyers' tasks.

## Duplicate charge protection

The buyer only authorizes payment for a create acceptance it actually receives. If the acceptance response is lost, the buyer does not sign for it; a retry is a new job and is charged once when its acceptance arrives. This matches image generation. The proxy does not retry creates automatically and does not add or remember idempotency keys.

Clients may optionally send `x-antseed-idempotency-key`. The proxy forwards it unchanged. The seller stores accepted responses by buyer, protocol, and key, so resending the same key to the same seller returns the stored acceptance (`x-antseed-idempotent-replay: true`) with no new job or charge. If the same key is still being processed, the seller returns `409 idempotency_in_progress`.
