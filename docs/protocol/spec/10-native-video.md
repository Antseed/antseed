# Native video API integration

AntSeed relays native video requests to seller-operated APIs in two formats: the Venice video API (`venice-video`) and fal.ai's queue API (`fal-video`). Other vendors' native APIs are not supported. Sellers own execution, storage, and refund policy. AntSeed does not cache artifacts.

Finished videos are streamed through the original seller; its API key never leaves the seller. Other providers and seller-hosted result URLs remain unchanged and must be accessible to buyers without seller credentials.

## Supported requests

| Protocol | Method | Native path |
| --- | --- | --- |
| `venice-video` | POST | `/api/v1/video/queue` |
| `venice-video` | POST | `/api/v1/video/retrieve` (JSON result or streamed MP4) |
| `fal-video` | POST | `/fal/v1/video/queue` |
| `fal-video` | POST | `/fal/v1/video/retrieve` (JSON status or streamed MP4) |

Venice uses the body `model` as the service. Retrieve carries `queue_id` in the JSON body instead of the path; the seller rebuilds it as `{model, queue_id}` (plus `delete_media_on_completion`) from the owned job and routed service. Venice `/api/v1/video/complete` and `/api/v1/video/quote` are not relayed. The API path, job ID field, and billing fields are declared in `packages/api-adapter/src/native-video.ts`. Create requests use the same model routing as images: `antseed` resolves to the selected route, and `<peerId>@<model>` pins that peer and is rewritten to `<model>` before forwarding. Other body fields are unchanged. Video services appear in `GET /v1/models?type=videos`.

### fal

fal's own API puts the endpoint ID in the URL (`queue.fal.run/{endpoint}`), which AntSeed cannot route on. AntSeed therefore uses fixed paths and carries the fal endpoint ID (for example `fal-ai/kling-video/v2.1/standard/text-to-video`) in the body `model`, which is also the service ID. The create body is fal's model input plus `model`; the seller removes `model` and `service` and submits the rest to `POST {base}/{model}`. The job ID is fal's `request_id`. Retrieve sends `{model, request_id}`; the seller polls `GET {base}/{owner}/{alias}/requests/{request_id}/status` and, once `COMPLETED`, fetches the result and streams the `https` `video.url` (or first `videos[].url`) to the buyer without the seller key. fal's `status_url` and `response_url` are not returned to buyers. A `COMPLETED` status with an `error` is returned as `{"status":"FAILED"}`. Durations are numbers or strings such as `"5"` and `"5s"`. Cancel and webhooks are not relayed.

### Alibaba Cloud Model Studio

The `alibaba-video` plugin serves the `fal-video` paths and translates them to Model Studio's task API, so no separate protocol or buyer change is needed. The seller maps the request fields to `input.media` and `parameters`, returns the task ID as `request_id`, and streams the finished file itself. It requires `duration` and refuses video and audio inputs before payment, because Model Studio bills an input video on top of the output.

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
- Image-to-video has mocked buyer → seller → upstream → result-download tests for Venice, including large inline PNGs, WebRTC uploads, unchanged media fields, and free follow-ups. These tests do not validate a real upstream model's image quality or acceptance. Video edits have mocked tests for both fal and Venice (inline sources over TCP and WebRTC, and one charge for the source length); they do not validate a real upstream model's output.

## Video edits (video-to-video)

A video edit model takes a source video (`video_url`) and changes part of it (a character from an image, a style, or a text instruction) while keeping the source's motion and timing. The seller announces it with `video` in `capabilities.video.inputs` and `video_url` in `supportedParameters`. The buyer's automatic routing treats a create that carries `video_url` (or `reference_video_urls`) as if it required that parameter, as it does with `image` for image edits: it goes only to sellers that list the field, and when none does the buyer answers `422 required_capability_unavailable`. A pinned seller is not filtered.

**Duration is the source length.** Many edit models (MiniMax H3 Max Recast, Kling V3 motion control) make an output exactly as long as the source and take no `duration`, and Venice lists only `Auto` for them. The buyer sends `duration = floor(source seconds)`, at least 1, and both peers price it with the existing `video_seconds` rule, so the delivery check and the charge are unchanged. A model that takes a `duration` (Kling v4 edit, Wan 2.7 edit) gets the same value: it cuts the output to the source, so a longer one would be delivered short and never charged, and fal bills Kling v4 edit for the source as well as the output. The upstream bills every edit for at least the whole source, so the seller checks the price: it measures the inline source's longest video track (its played length from the edit list or sample table, not headers; a malformed or fragmented MP4 is refused) and answers `422 invalid_video_duration` unless `duration` is that length rounded down. Such edits take the source inline as a `data:video/...;base64` URL. The fal seller then removes `duration` before submitting to an endpoint whose schema has none; Venice wants it, so it is passed through.

**Refused before payment.** The plugins run this check through the optional `Provider.checkRequest(request)` hook, which the seller calls right after matching the service and before pricing, the one-off channel plan, or any other payment step. A refusal (`{ statusCode, code, message }`) is sent as `{ "error": { "code", "message" } }`, so a refused create opens no channel and costs the buyer nothing. The plugins check again when the create reaches them.

**No seller precheck.** Apart from that length, sellers do not check the source or the fields; the upstream does, after the payment channel opened. Buyers check the source before pricing against the limits the provider publishes. The `antseed-videos` skill reads them live: fal's OpenAPI schema (`x-fal` on `video_url`: `min_duration`, `max_duration`, `max_file_size`, `min/max_width`, `min/max_height`, `min/max_aspect_ratio`, `min/max_fps`; required fields; the `duration` range), and for Venice models Venice's model list, then the same model's fal schema, then Venice's docs.

**Failed jobs.** A job the upstream rejects (a retrieve answering `FAILED`; the Venice plugin turns Venice's JSON `400`/`422` refusal into `FAILED` with the reason) ends it. Any other error answer to a retrieve, including a `400` or `422`, keeps the job and its channel. The seller closes the job's one-off channel at what the buyer signed: the opening fee for a price above the first-sign cap, otherwise nothing. The buyer forgets the job but keeps the channel stored as open, so it can still request-close it if the seller's close never lands. `429` and `5xx` answers keep the job. Neither fal nor Venice bills the seller for a failed job.

**Announced options.** The fal plugin reads each endpoint's schema at start and announces its inputs, required inputs and resolutions. For an endpoint without a `duration` field, it also announces the whole-second `durationsSeconds` between `x-fal`'s `min_duration` and `max_duration`. The Venice plugin reads `/api/v1/models`, announces `video_url` and `image_url` for each edit model, and asks Venice, with a free invalid create, whether the model requires reference images.

**Size.** Inline sources share the 64 MiB upload limit (base64 included, about 47 MB of raw video). The buyer sends the body twice when a one-off channel must open first, so a large inline source uploads twice.

Native field references: [Venice queue](https://docs.venice.ai/api-reference/endpoint/video/queue), [BytePlus create task](https://docs.byteplus.com/en/docs/ModelArk/1520757) and [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk).

## Talking avatars (audio-driven length)

Some models animate a face image (`image_url`) to an audio file (`audio_url`) and make a video exactly as long as the audio, with no `duration` field (fal's Kling AI Avatar v2, `fal-ai/kling-video/ai-avatar/v2/pro` and `/standard`). The upstream bills them per second of that video, so a buyer that could choose its own `duration` would pay for less than it gets, and one that sends none could not be priced.

The fal plugin marks such an endpoint from its schema: `audio_url` is required, there is no `video_url`, and no field sets the length (`duration`, `num_frames`). It announces `first_frame` and `audio` in `capabilities.video.inputs` and `requiredInputs`, and no `durationsSeconds`. Without the schema, a create with `audio_url` and no `video_url` is treated the same way unless the service's configured `supportedParameters` include `duration` or `num_frames`.

**Duration is the audio length.** The buyer sends `duration = floor(audio seconds)`, at least 1, priced with the existing `video_seconds` rule. The seller measures the inline audio (`data:audio/...;base64`; the bytes decide the format, not the media type) and answers `422 invalid_video_duration` before payment (`Provider.checkRequest`) unless `duration` is that length:

- **MP3:** every whole MPEG audio frame after the leading ID3v2 tags, summing each frame's samples over its sample rate; a first Xing/Info/VBRI header frame is not audio. Bytes between frames are skipped the way a decoder resyncs (at the next two whole frames in a row), so audio after a gap is counted too. Bytes before the first frame that are not an ID3v2 tag make the file unmeasurable.
- **WAV:** RIFF/WAVE with a PCM or float `fmt ` chunk (plain or extensible) before the first `data` chunk, whose `blockAlign` is channels × sample width; the length is the bytes of every `data` chunk over `sampleRate × blockAlign`. A `data` size of 0, 0xFFFFFFFF, or past the end counts to the end. Bytes after a chunk that are not another chunk (a FourCC of printable ASCII) make the file unmeasurable.

Anything else (a URL, AAC, M4A, Ogg, FLAC, compressed WAV) is refused. The seller then removes `duration` and uploads the inline audio to fal's file storage before submitting, because some endpoints take `audio_url` only as a URL. The output is about as long as the audio, so the delivery check (at least 90% of `duration`) is unchanged.

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

Input kinds are `first_frame`, `last_frame`, `reference_image`, `video`, `reference_video`, and `audio`; `inputs: []` means text only. Every field is optional. Sellers configure them through `ANTSEED_SERVICE_CAPABILITIES_JSON`; options a seller configures always win. For video edit models, the fal and Venice plugins fill in `inputs`, `requiredInputs`, `resolutions` (exact case, from fal's `resolution` enum or Venice's model list) and, on fal, source-length `durationsSeconds`, as read from the upstream ([Video edits](#video-edits-video-to-video)). The upstream remains the source of truth for other request validation.

## Billing

Discovery billing entries use the protocol's position in `WELL_KNOWN_SERVICE_API_PROTOCOLS`; `venice-video` is ID `6` and `fal-video` is ID `7`.

A video is charged when it is delivered: the first retrieve that returns the finished video (a streamed download that passes the delivery check below) charges the video price once per job. The create itself is not charged; the seller stores the price and the job's one-off channel with the accepted `queue_id` (`resource_charges` in the metering database) and charges it on the first delivery. Later downloads of the same job are free. A job that is never delivered (provider failure, moderation rejection, expired file, or never downloaded) is not charged beyond the serious fee described below. Pricing uses `video_generations` or `video_seconds`; per-second pricing requires an explicit positive duration (`duration`). Components can match the create's `model`, `resolution`, `aspect_ratio` and `audio` (`"true"`/`"false"`; fal reads `generate_audio`, then `audio`). For `venice-video`, both peers price an omitted `aspect_ratio` as the service's first announced `video.aspectRatios` entry and an omitted `audio` as its announced `video.audio` (`videoAttributes` in `@antseed/buyer-core`), and the seller must send the upstream those values. For `fal-video` an omitted option stays out of the attributes, so a create that leaves out an option every component requires matches none and is refused. `aspect_ratio` and `audio` need metadata v16. Venice durations such as `"5s"` are read as seconds. Venice `auto`, `-1`, and `1 gen` requests have no explicit duration, so they need `video_generations` pricing. Each create bills one video.

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

The buyer stores each accepted-but-undelivered video job on its one-off channel record, so a buyer restart or the end of its chat session with the seller does not stop it from verifying and signing the delivery charge. Already-settled funds are **not automatically refunded**: a video that is never delivered costs at most the serious fee, which `topUp()` settles on-chain.

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
