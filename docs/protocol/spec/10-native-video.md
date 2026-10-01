# Native video API integration

AntSeed relays native Venice video requests to seller-operated APIs. Models from other vendors can still be used through Venice; their separate native APIs are not supported. Sellers own execution, storage, and refund policy. AntSeed does not cache artifacts.

Finished Venice videos are streamed through the original seller; its API key never leaves the seller. Other providers and seller-hosted result URLs remain unchanged and must be accessible to buyers without seller credentials.

## Supported requests

| Protocol | Method | Native path |
| --- | --- | --- |
| `venice-video` | POST | `/api/v1/video/queue` |
| `venice-video` | POST | `/api/v1/video/retrieve` (JSON result or streamed MP4) |

Venice uses the body `model` as the service. Retrieve carries `queue_id` in the JSON body instead of the path; the seller rebuilds it as `{model, queue_id}` (plus `delete_media_on_completion`) from the owned job and routed service. Venice `/api/v1/video/complete` and `/api/v1/video/quote` are not relayed. The API path, job ID field, and billing fields are declared in `packages/api-adapter/src/native-video.ts`. Create requests use the same model routing as images: `antseed` resolves to the selected route, and `<peerId>@<model>` pins that peer and is rewritten to `<model>` before forwarding. Other body fields are unchanged. Video services appear in `GET /v1/models?type=videos`.

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

### Media access and verification

- URLs must be reachable by the upstream provider. A buyer's local file path, `localhost` URL, or private AntSeed download URL is not an upstream-accessible input. Use inline media or an upstream-accessible URL; AntSeed does not fetch arbitrary input URLs or upload local files for you.
- Requests containing inline images automatically use chunked P2P uploads when needed. The seller's default upload-body limit is 64 MiB, counting the whole JSON body and base64 overhead; this is separate from the output-video download limit.
- Existing seller-account-scoped media references are not automatically resolved or routed to their original seller. Download the media and supply an eligible inline input or accessible URL instead, subject to upstream restrictions.
- Image-to-video has mocked buyer → seller → upstream → result-download tests for Venice, including large inline PNGs, WebRTC uploads, unchanged bodies, replay without duplicate charges, and free follow-ups. These tests do not validate a real upstream model's image quality or acceptance. Video-input fields have byte-preservation tests, not a live video-editing guarantee.

Native field references: [Venice queue](https://docs.venice.ai/api-reference/endpoint/video/queue), [BytePlus create task](https://docs.byteplus.com/en/docs/ModelArk/1520757) and [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk).

## Model options

Sellers can advertise what each video model accepts in `capabilities.video` (peer metadata v12):

```json
{
  "wan-2.5-preview-text-to-video": {
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

Input kinds are `first_frame`, `last_frame`, `reference_image`, `video`, `reference_video`, and `audio`; `inputs: []` means text only. Every field is optional. The Venice Video plugin does not fetch or enforce these options; sellers configure them through `ANTSEED_SERVICE_CAPABILITIES_JSON`, and Venice remains the source of truth for request validation.

## Billing

Discovery billing entries use the protocol's position in `WELL_KNOWN_SERVICE_API_PROTOCOLS`; `venice-video` is ID `6`.

A create is charged when the seller returns an accepted Venice `queue_id`. Retrieve requests are free. Pricing uses `video_generations` or `video_seconds`; per-second pricing requires an explicit positive duration (`duration`). Venice durations such as `"5s"` are read as seconds. Venice `auto`, `-1`, and `1 gen` requests have no explicit duration, so they need `video_generations` pricing. Each create bills one video.

### Videos above the first reserve

The buyer rejects a create whose price, computed from the seller's advertised unit pricing, is above `maxVideoRequestUsdc` (default `5000000`, $5.00). The buyer always sends the create first. The seller answers idempotent replays, invalid idempotency keys and unbillable requests before any payment check. Only then, if the video's price is above the reserve still locked on the channel (`reserveMax - spent`), the seller replies HTTP 402 with `{"error":"payment_required","code":"video_reserve_required"}` plus `estimatedRequestCost`, `remainingLockedReserve` and `reserveMaxAmount`. It does not start the job and keeps the channel open. Sellers run at most one video create per buyer at a time; a second create while one is in flight gets HTTP 409 `video_create_in_progress` without starting a job. This is a temporary limit until the reserve check accounts for in-flight creates, so concurrent creates cannot together exceed the locked reserve. Idempotent replays, retrieve requests and other buyers are not limited. This check ignores `reserveEstimateOverdraftUsdc`. Raising the reserve pays an advance that cannot be refunded, so the buyer raises it only after that reply, never for a replay or a rejected create:

1. The buyer signs an ordinary cumulative SpendingAuth up to `TOP_UP_SETTLED_THRESHOLD_BPS` of the current deposit (85%) and sends it before the top-up (a video advance). Everything signed beyond delivered work stays smaller than the video price and within the locked deposit. Sellers already accept SpendingAuths above delivered spend, so no new message field is involved.
2. The buyer sends a top-up ReserveAuth. The new ceiling is `delivered + video price + maxReserveAmountUsdc` (one normal reserve step for follow-up chats), or only `delivered + video price` when deposits cannot cover the buffer. The seller calls `topUp()` with its latest SpendingAuth (the advance), which settles it and locks the new ceiling in one transaction.
3. The buyer waits until the new deposit is visible on-chain (up to 45 seconds), then resends the same create with the same idempotency key. It raises the reserve at most once per create; a second `video_reserve_required` is returned to the caller.

The buyer tracks two numbers per channel: the signed cumulative and the amount owed for delivered work (`deliveredAmount`, persisted with the channel). They differ only while an advance is outstanding. The seller's NeedAuth asks for its delivered spend, so after a $0.10 chat, a $0.85 advance and a $4.20 video the buyer signs $4.30, not $5.05. The response path adds the video price to the delivered amount rather than to the signed cumulative, so both paths reach the same total. Spend events report only new authorization ($0.75 for the advance, then $3.45), both with the video create's request ID so conversation totals include the advance, and usage metadata attributes the full $4.20 to the video service. Sellers treat on-chain `settled` as lost local state only when it exceeds their accepted cumulative, so an advance is never counted as delivered work after a restart.

The first reserve still respects `FIRST_SIGN_CAP`; no contract change is involved. If deposits cannot cover even the video price, the create fails with `buyer-deposits-insufficient` (HTTP 503); if the top-up cannot be confirmed in time, it fails with `buyer-reserve-topup-timeout` (HTTP 504) without resending the create.

If the top-up fails, the advance stays signed and later requests use it up: their charges raise the delivered amount without signing more until it catches up with the advance. The seller can settle the advance when the channel closes, so a failed top-up followed by closure pays for up to the advance minus delivered work without a video. Already-settled funds are **not automatically refunded**.

## Routing and ownership

### Streamed downloads

Venice `/api/v1/video/retrieve` is always sent as a streamed download; every seller serving `venice-video` must support it (`@antseed/provider-venice-video` always does). While the job runs the seller returns Venice's JSON response unchanged; once finished it streams the MP4 using the flow below. Private Venice models return JSON `COMPLETED` and deliver the file through the `download_url` from the queue response, which is passed to the buyer unchanged. Venice bills some moderation rejections itself, so a create is still charged once accepted.

Venice MP4 responses may omit `Content-Length`. They are streamed directly through the same authenticated P2P path; no temporary file or second upstream fetch is used. The seller and buyer count received bytes and enforce the 64 MiB download limit.

### Download streaming

Venice create and download paths are defined in `packages/api-adapter/src/native-video.ts`; routing uses sellers' advertised `venice-video` service protocol rather than inferring it from provider names. There is no separate seller capability. Metadata stays at v12: bit 3 of the service capability value byte signals video options appended after the supported-parameter list (when present). Entries without video options retain the existing v12 encoding. Older buyers reject the unknown value bit and cannot use the seller's announcement; they do not silently skip the video fields.

Each download uses one P2P request, one ownership check and one upstream retrieve. The request carries `x-antseed-video-download: video-stream-v1`; the successful response carries that marker and `x-antseed-streaming: 1`. MP4 data travels in chunks of at most 64 KiB, below TCP and WebRTC frame limits. The buyer acknowledges a chunk only after its HTTP client drains; the seller waits for that acknowledgement before sending another. `HttpResponseAck` (0x27) uses the response-chunk codec with empty data and echoes the acknowledged frame's message ID. `HttpRequestCancel` (0x28) uses the same codec with empty data and aborts only the named request, including upstream fetching. Connection loss also aborts seller work.

Downloads are bounded at 64 MiB and use the ordinary five-minute request timeout. Two downloads run concurrently per buyer process and per seller provider, and each chunk has a 30-second acknowledgement timeout. Download requests are Venice JSON POSTs of at most 4 KiB. A declared `Content-Length` is validated when present; when it is absent, actual bytes are counted and bounded instead. The local HTTP response uses chunked transfer so it cannot appear complete before the P2P end frame. Midstream errors use `HttpResponseError`, never JSON or SSE inserted into the video, and the local HTTP response is destroyed. Browser seeking and resumable client ranges are not supported yet.

Both peers incrementally compute the existing response-auth v1 hash over the encoded response headers and actual bytes. When a length is declared, it remains part of the hash; when it is absent, the empty body-length field is used as the canonical placeholder. No new signature format is introduced and neither peer reconstructs the complete file in memory. The in-process response carries an empty body and a locally computed `streamedBody` descriptor (byte length and response hash); that descriptor is not accepted from wire frames. Receipt verification retains its existing asynchronous behavior. Video bytes are not retained for response sampling.

Downloads and repeated downloads are free; they do not create a new job or change acceptance-based billing. Expired or missing files, unfinished jobs, and upstream failures return errors instead of switching sellers or generating another video. Retaining a job route does not extend upstream file retention.

The buyer proxy stores accepted job routes in `buyer.state.json` for 30 days, so retrieve requests go back to the same seller, provider, and service. Unknown jobs return `404`.

The seller node stores `(protocol, job ID) -> buyer peer ID` in the seller's `metering.db`. Retrieve requests from another buyer return `404` before reaching the seller API. Video requests are refused if this storage is unavailable.

## Duplicate charge protection

The buyer only authorizes payment for a create acceptance it actually receives. If the acceptance response is lost, the buyer does not sign for it; a retry is a new job and is charged once when its acceptance arrives. This matches image generation. The proxy does not retry creates automatically and does not add or remember idempotency keys.

Clients may optionally send `x-antseed-idempotency-key`. The proxy forwards it unchanged. The seller stores accepted responses by buyer, protocol, and key, so resending the same key to the same seller returns the stored acceptance (`x-antseed-idempotent-replay: true`) with no new job or charge. If the same key is still being processed, the seller returns `409 idempotency_in_progress`.
