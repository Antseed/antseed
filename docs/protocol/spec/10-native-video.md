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
- Image-to-video has mocked buyer → seller → upstream → result-download tests for Venice, including large inline PNGs, WebRTC uploads, unchanged media fields, and free follow-ups. These tests do not validate a real upstream model's image quality or acceptance. Video-input fields have forwarding tests, not a live video-editing guarantee.

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

A video is charged when it is delivered: the first retrieve that returns the finished video (a streamed download that passes the delivery check below) charges the video price once per job. The create itself is not charged; the seller stores the price and the job's one-off channel with the accepted `queue_id` (`resource_charges` in the metering database) and charges it on the first delivery. Later downloads of the same job are free. A job that is never delivered (provider failure, moderation rejection, expired file, or never downloaded) is not charged beyond the serious fee described below. Pricing uses `video_generations` or `video_seconds`; per-second pricing requires an explicit positive duration (`duration`). Venice durations such as `"5s"` are read as seconds. Venice `auto`, `-1`, and `1 gen` requests have no explicit duration, so they need `video_generations` pricing. Each create bills one video.

### Delivery check

Buyer and seller run the same check on a streamed download, so the seller never asks for a charge the buyer will refuse to sign. A download counts as delivered only when all of these hold:

- the response is `video/mp4` and the transfer completed (and matched `Content-Length` when one was declared);
- the bytes are a complete MP4: they start with an `ftyp` box and every top-level box ends where its size says;
- the `mvhd` box reports a duration of at least 90% of the requested `duration` (models round). Requests without an explicit duration only need a readable duration.

Both peers inspect the MP4 while it streams; they read box headers and buffer only the `moov` box (at most 16 MiB), so `moov` may come before or after the media data. A download that fails the check is still passed to the client, but it is not charged and the seller keeps only the serious fee. JSON status answers never count as a delivery.

### One-off video channels

Every paid video create is paid from its own **one-off payment channel**: a fresh on-chain channel (new salt, so a new `channelId`) that pays for exactly that one video. It is never the buyer's session channel with the seller. Chat and image spending cannot use the video's reserve, the video's cumulative never mixes with chat spending, and disconnects or session settlement never close it. One buyer can run any number of videos with the same seller at once, each on its own channel, as long as its deposits cover each video. No contract change is involved: channel IDs are `keccak(buyer, seller, salt)`, so any number of channels can be open between the same pair.

The buyer rejects a create whose price, computed from the seller's advertised unit pricing, is above `maxVideoRequestUsdc` (default `5000000`, $5.00). The buyer always sends the create first. The seller answers unbillable requests before any payment check. Then, if no one-off channel is open for this buyer and `requestId`, the seller replies HTTP 402 without starting the job:

```json
{
  "error": "payment_required",
  "code": "one_off_channel_required",
  "minBudgetPerRequest": "10000",
  "suggestedAmount": "1000000",
  "oneOffPlan": {
    "openingReserveAmount": "1000000",
    "requiredCumulativeAmount": "650000",
    "requestCost": "4200000"
  }
}
```

The plan is fully determined by the price and two contract constants, so buyer and seller compute it the same way (`computeOneOffChannelPlan` in `@antseed/protocol`):

- `openingReserveAmount = min(price, FIRST_SIGN_CAP)`: `reserve()` cannot open a channel above `FIRST_SIGN_CAP` ($1 by default).
- `requiredCumulativeAmount = ceil(openingReserveAmount × TOP_UP_SETTLED_THRESHOLD_BPS / 10000)` when the price is above the opening reserve, otherwise `0`. `topUp()` requires this share of the deposit to be settled first. This is the **serious fee**: $0.65 for a $1 opening reserve on Base mainnet (6500 bps; 8500 is the fallback when the read fails). It always counts toward the video price and is smaller than it.
- The final reserve is always `requestCost`, the video price.

A video at or below `FIRST_SIGN_CAP` needs no serious fee and no top-up: the channel opens at the full price.

The buyer validates the plan against its own price estimate and the live contract values, checks that available deposits cover the full price (otherwise it returns `insufficient_deposits`), and sends one SpendingAuth for the new channel:

- the opening ReserveAuth (`reserveSalt`, `reserveMaxAmount = openingReserveAmount`);
- for a price above the cap, a `reserveBatch` with the serious-fee SpendingAuth and the final ReserveAuth for the price;
- `oneOffRequestId: "<create requestId>"`, which binds the channel to the create.

The seller accepts it only if it matches a plan it offered for the same buyer and `requestId` (plans expire after 2 minutes). It calls `reserve()` and, when needed, `topUp()` with the serious-fee SpendingAuth: that one transaction settles the fee and locks the full price, so the fee is paid only if the full reserve is locked too. If `topUp()` fails (for example `InsufficientBalance`), the seller immediately calls `close(0)` and the whole opening reserve goes back to the buyer. Otherwise it replies `AuthAck` for the new channel. The buyer waits for the AuthAck, reading the chain between waits so a lost AuthAck still confirms once the full reserve is visible (up to 45 seconds; `buyer-reserve-topup-timeout` otherwise), then resends the same create with the same `requestId`.

The binding is the `requestId`: the retry carries the same `requestId`, and the seller looks up the one-off channel by `(buyer, requestId)`. No extra HTTP header is needed. The seller marks the channel used when the create starts, so a replayed create cannot start a second job on it (HTTP 409 `one_off_channel_used`); a channel whose reserve does not cover the price is refused with HTTP 409 `one_off_channel_mismatch`.

A one-off channel is closed as soon as its outcome is known:

- **Delivered:** the seller sends a NeedAuth for the channel with `requiredCumulativeAmount = price`. The buyer signs the price only for a delivered download of that channel's own job, and the seller calls `close(price)` right away.
- **Not accepted, provider error, ownership store failure, or a free video:** the seller closes immediately at the amount already settled (the serious fee, or `0`).
- **Generation failed:** when retrieve reports `FAILED`, `ERROR` or `CANCELLED`, the seller closes at the serious fee.
- **Abandoned:** the seller closes a channel whose create never started after 10 minutes, and any unpaid channel after 24 hours.

If the seller disappears, the buyer can still `requestClose()` and `withdraw()` the channel after the 15-minute grace period like any other channel.

List these channels with `antseed buyer channels list` or `antseed buyer channels --json` for full channel IDs. To recover an abandoned video's remaining reserve without the seller, run `antseed buyer channels request-close <channelId>`, wait the 15-minute grace period, then run `antseed buyer channels withdraw <channelId>`. This releases only the unspent reserve, not the already-settled serious fee. One-off video channels also appear in buyer channel history, but stay separate from chat sessions; the cooperative `close` command is only for session channels.

The buyer keeps accepted-but-undelivered video jobs in memory only. If the buyer process restarts before the download, it cannot verify the seller's delivery charge and does not sign it; the seller keeps only the serious fee. Already-settled funds are **not automatically refunded**: a video that is never delivered costs at most the serious fee, which `topUp()` settles on-chain.

## Routing and ownership

### Streamed downloads

Venice `/api/v1/video/retrieve` is always sent as a streamed download; every seller serving `venice-video` must support it (`@antseed/provider-venice-video` always does). While the job runs the seller returns Venice's JSON response unchanged; once finished it streams the MP4 using the flow below. Private (VPS-backed) Venice models return a short-lived `download_url` on create instead of streaming from retrieve; the seller removes it from the create response, keeps it for 24 hours, and once retrieve reports `COMPLETED` streams the file from that URL through the same flow. The buyer never receives the URL, so every video is checked and charged the same way. A moderation rejection or failed job is never delivered, so the buyer pays at most the serious fee for it.

Venice MP4 responses may omit `Content-Length`. They are streamed directly through the same authenticated P2P path; no temporary file or second upstream fetch is used. The seller and buyer count received bytes and enforce the 64 MiB download limit.

### Download streaming

Venice create and download paths are defined in `packages/api-adapter/src/native-video.ts`; routing uses sellers' advertised `venice-video` service protocol rather than inferring it from provider names. There is no separate seller capability. Metadata stays at v12: bit 3 of the service capability value byte signals video options appended after the supported-parameter list (when present). Entries without video options retain the existing v12 encoding. Older buyers reject the unknown value bit and cannot use the seller's announcement; they do not silently skip the video fields.

Each download uses one P2P request, one ownership check and one upstream retrieve. The request carries `x-antseed-video-download: video-stream-v1`; the successful response carries that marker and `x-antseed-streaming: 1`. MP4 data travels in chunks of at most 64 KiB, below TCP and WebRTC frame limits. The buyer acknowledges a chunk only after its HTTP client drains; the seller waits for that acknowledgement before sending another. `HttpResponseAck` (0x27) uses the response-chunk codec with empty data and echoes the acknowledged frame's message ID. `HttpRequestCancel` (0x28) uses the same codec with empty data and aborts only the named request, including upstream fetching. Connection loss also aborts seller work.

Downloads are bounded at 64 MiB and use the ordinary five-minute request timeout. Two downloads run concurrently per buyer process and per seller provider, and each chunk has a 30-second acknowledgement timeout. Download requests are Venice JSON POSTs of at most 4 KiB. A declared `Content-Length` is validated when present; when it is absent, actual bytes are counted and bounded instead. The local HTTP response uses chunked transfer so it cannot appear complete before the P2P end frame. Midstream errors use `HttpResponseError`, never JSON or SSE inserted into the video, and the local HTTP response is destroyed. Browser seeking and resumable client ranges are not supported yet.

Both peers incrementally compute the existing response-auth v1 hash over the encoded response headers and actual bytes. When a length is declared, it remains part of the hash; when it is absent, the empty body-length field is used as the canonical placeholder. No new signature format is introduced and neither peer reconstructs the complete file in memory. The in-process response carries an empty body and a locally computed `streamedBody` descriptor (byte length and response hash); that descriptor is not accepted from wire frames. Receipt verification retains its existing asynchronous behavior. Video bytes are not retained for response sampling.

The first delivery of a job charges its price; repeated downloads are free and do not create a new job. Expired or missing files, unfinished jobs, and upstream failures return errors instead of switching sellers or generating another video. Retaining a job route does not extend upstream file retention.

The buyer proxy stores accepted job routes in `buyer.state.json` for 30 days, so retrieve requests go back to the same seller, provider, and service. Unknown jobs return `404`.

The seller node stores `(protocol, job ID) -> buyer peer ID` in the seller's `metering.db`. Retrieve requests from another buyer return `404` before reaching the seller API. Video requests are refused if this storage is unavailable.

## Duplicate charge protection

The buyer only authorizes the video price for a video it actually receives. If the acceptance or the download is lost, the buyer does not sign for it; the seller charges each job at most once, on its first delivery to the paying channel. The proxy does not retry creates automatically. A create resent by the client starts a new job, but that job is charged only if it is delivered.
