# Native video API integration

AntSeed relays native Veo, Seedance, and Venice video requests to seller-operated APIs. Models from other vendors can still be used through Venice; their separate native APIs are not supported. Sellers own execution, storage, and refund policy. AntSeed does not cache artifacts.

Direct Gemini Veo downloads and finished Venice videos are streamed through the original seller; its API key never leaves the seller. Other providers and seller-hosted result URLs remain unchanged and must be accessible to buyers without seller credentials.

## Supported requests

| Protocol | Method | Native path |
| --- | --- | --- |
| `veo-video` | POST | `/v1beta/models/{model}:predictLongRunning` |
| `veo-video` | GET | `/v1beta/{operation-name}` |
| `veo-video` | GET | `/v1beta/{operation-name}/videos/{index}:download` (AntSeed endpoint) |
| `seedance-video` | POST | `/api/v3/contents/generations/tasks` |
| `seedance-video` | GET, DELETE | `/api/v3/contents/generations/tasks/{id}` |
| `venice-video` | POST | `/api/v1/video/queue` |
| `venice-video` | POST | `/api/v1/video/retrieve` (status or streamed MP4), `/api/v1/video/complete` (delete stored media) |

Veo uses the path model as the service; every other API uses the body `model`. Venice follow-ups carry `queue_id` in the JSON body instead of the path; the seller rebuilds them as `{model, queue_id}` (plus `delete_media_on_completion` on retrieve) from the owned job and routed service. `/api/v1/video/quote` is not relayed. Each API's paths, job ID field, and billing fields are declared in one table in `packages/api-adapter/src/native-video.ts`. Service names must equal seller model names. Request bodies are forwarded byte-for-byte, and chat aliases, pins, and model rewrites are not applied. Video services appear in `GET /v1/models?type=videos`.

## Image-to-video and video inputs

The create endpoints are not text-only. AntSeed forwards the native JSON body byte-for-byte, including images, reference frames and video inputs; it does not convert these requests into image-generation or chat requests. No separate image-to-video endpoint or AntSeed upload service is needed.

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

### Veo

Send this body to `POST /v1beta/models/<veo-model>:predictLongRunning`. This is the wire format produced by the Google JavaScript SDK's image converter, not its higher-level `imageBytes` argument:

```json
{
  "instances": [{
    "prompt": "Animate the scene with a slow camera pan",
    "image": { "bytesBase64Encoded": "<base64-image-bytes>", "mimeType": "image/png" }
  }],
  "parameters": { "durationSeconds": 8 }
}
```

AntSeed also preserves native `lastFrame`, `referenceImages`, and `video` fields, including the `inlineData` image/video representation in Google's REST examples. Veo's video extension is not a general guarantee that arbitrary videos can be edited. Model and input eligibility remain Google's responsibility. Poll and download through the same operation flow as text-to-video.

### Media access and verification

- URLs must be reachable by the upstream provider. A buyer's local file path, `localhost` URL, or private AntSeed download URL is not an upstream-accessible input. Use inline media or an upstream-accessible URL; AntSeed does not fetch arbitrary input URLs or upload local files for you.
- Requests containing inline images automatically use chunked P2P uploads when needed. The seller's default upload-body limit is 64 MiB, counting the whole JSON body and base64 overhead; this is separate from the output-video download limit.
- Existing seller-account-scoped media references are not automatically resolved or routed to their original seller. Download the media and supply an eligible inline input or accessible URL instead, subject to upstream restrictions. Seedance draft-task IDs use the existing ownership and seller-pinning flow.
- Image-to-video has mocked buyer → seller → upstream → result-download tests for all three plugins, including large inline PNGs, WebRTC uploads, unchanged bodies, replay without duplicate charges, and free follow-ups. These tests do not validate a real upstream model's image quality or acceptance. Video-input fields have byte-preservation tests, not a live video-editing guarantee.

Native field references: [Venice queue](https://docs.venice.ai/api-reference/endpoint/video/queue), [BytePlus create task](https://docs.byteplus.com/en/docs/ModelArk/1520757), [Google Veo](https://ai.google.dev/gemini-api/docs/veo), and [Google SDK converters](https://github.com/googleapis/js-genai/blob/main/src/converters/_models_converters.ts).

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

Input kinds are `first_frame`, `last_frame`, `reference_image`, `video`, `reference_video`, and `audio`; `inputs: []` means text only. Every field is optional, and an omitted field is not checked. The buyer skips sellers whose options reject a create and returns `422 unsupported_video_options` if none remain. The seller also rejects such creates with `400 unsupported_video_options` before payment or any upstream call. Automatic durations, polling, cancellation and downloads are never checked.

Venice sellers fill these options automatically from `GET /api/v1/models?type=video` at startup. Configured options take precedence. Seedance and Veo sellers set them through service `capabilities` or `ANTSEED_SERVICE_CAPABILITIES_JSON`.

## Billing

Discovery billing entries retain their existing wire IDs: Veo `7`, Seedance `10`, and Venice `11`. IDs `6`, `8`, and `9` are unused; removing a provider must not renumber the remaining protocols.

A create is charged when the seller returns an accepted job ID: Seedance `id`, Veo `name`, or Venice `queue_id`. Polling and cancellation are free. Pricing uses `video_generations` or `video_seconds`; per-second pricing requires an explicit positive duration (`duration` or Veo `parameters.durationSeconds`). Venice durations such as `"5s"` are read as seconds. Seedance `-1`, Seedance `frames`, and Venice `auto`, `-1`, and `1 gen` requests have no explicit duration, so they need `video_generations` pricing. Veo reads `numberOfVideos` or `sampleCount`; every other API bills one video per create.

## Routing and ownership

### Streamed downloads

Venice `/api/v1/video/retrieve` is always sent as a streamed download to a seller advertising `videoDownload = "video-stream-v1"` (the Venice plugin always does). While the job runs the seller returns Venice's JSON status unchanged; once finished it streams the MP4 using the same flow as Veo below. Private Venice models return JSON `COMPLETED` and deliver the file through the `download_url` from the queue response, which is passed to the buyer unchanged. Venice bills some moderation rejections itself, so a create is still charged once accepted.

Venice MP4 responses without `Content-Length` are staged in a seller-local private temporary file to determine the length required by response-auth v1, then streamed through the same authenticated P2P path. This uses one upstream fetch and bounded memory; the existing 4 GiB limit and two-download concurrency limit also apply during staging. Temporary files are removed on completion, cancellation or failure. Known-length responses do not use disk. No buyer-visible bytes arrive during staging, so the buyer's 60-second idle timeout can still cancel a slow preparation. The `delete_media_on_completion` field is only forwarded to retrieve, never to complete.

### Veo downloads

For completed Veo operations, the buyer proxy replaces Google file URLs with local download URLs only when the selected provider and service advertise `serviceCapabilities[service].videoDownload = "video-stream-v1"` in signed metadata. Metadata stays at v12: bit 3 of the service capability value byte signals `video-stream-v1`, and bit 4 signals video options appended after the supported-parameter list (when present). Entries without these video fields retain the existing v12 encoding. Older buyers reject the unknown value bits and cannot use the seller's announcement; they do not silently skip the video fields. Missing download capabilities leave upstream URLs unchanged; manually requesting a local download from an unsupported seller returns 501. The direct-Google Veo plugin advertises the capability automatically; custom `GEMINI_BASE_URL` origins do not.

Local download URLs contain the operation name and zero-based result index. Fetch the returned URI directly; no Google API key is needed on the buyer. The Google JavaScript SDK's `files.download()` reconstructs a Google Files API path instead of fetching local HTTP URIs, so use `fetch(video.uri)` for this step rather than that helper.

The seller checks the existing operation ownership for every download request, fetches the operation status from Gemini, and resolves the file URL itself. Arbitrary buyer-supplied URLs, other Google endpoints, embedded credentials, and redirects are rejected. No new ownership table or file cache is needed. Both buyer and seller must support the download endpoint.

Each download uses one P2P request, one ownership check, one Gemini status lookup and one Google file fetch. The request carries `x-antseed-video-download: video-stream-v1`; the successful response carries that marker and `x-antseed-streaming: 1`. MP4 data travels in chunks of at most 64 KiB, below TCP and WebRTC frame limits. The buyer acknowledges a chunk only after its HTTP client drains; the seller waits for that acknowledgement before sending another. `HttpResponseAck` (0x27) uses the response-chunk codec with empty data and echoes the acknowledged frame's message ID. `HttpRequestCancel` (0x28) uses the same codec with empty data and aborts only the named request, including upstream fetching. Connection loss also aborts seller work.

Downloads may be up to 4 GiB (the largest length the streamed response hash encodes). There is no total time limit, so any video finishes on a slow link; a transfer is cancelled only after 60 seconds without progress. Two downloads run concurrently per buyer process and per seller provider, and each chunk has a 30-second acknowledgement timeout. Download requests are either a body-less GET (Veo) or a JSON POST of at most 4 KiB (Venice). This initial version requires a positive, bounded upstream `Content-Length`; absent or invalid lengths fail before video bytes are forwarded. Actual bytes are checked against that length, so truncated or excessive responses fail too. The local HTTP response uses chunked transfer so it cannot appear complete before the P2P end frame. Midstream errors use `HttpResponseError`, never JSON or SSE inserted into the video, and the local HTTP response is destroyed. Browser seeking and resumable client ranges are not supported yet.

Both peers incrementally compute the existing response-auth v1 hash over the encoded response headers, declared body length and actual bytes. No new signature format is introduced and neither peer reconstructs the complete file in memory. The in-process response carries an empty body and a locally computed `streamedBody` descriptor (byte length and response hash); that descriptor is not accepted from wire frames. Receipt verification retains its existing asynchronous behavior. Video bytes are not retained for response sampling.

Downloads and repeated downloads are free; they do not create a new job or change acceptance-based billing. Expired or missing files, unfinished jobs, and upstream failures return errors instead of switching sellers or generating another video. Retaining a job route does not extend Gemini's file retention.

The buyer proxy stores accepted job routes in `buyer.state.json` for 30 days, so status and cancel requests go back to the same seller, provider, and service. Unknown jobs return `404`.

The seller node stores `(protocol, job ID) -> buyer peer ID` in `resources.db`. Status and cancel requests from another buyer return `404` before reaching the seller API. Video requests are refused if this storage is unavailable.

Seedance creates can reference an earlier draft task (`content[].type = "draft_task"`, `draft_task.id`). The buyer proxy sends such a create to the seller that owns the draft, and returns `404 video_route_not_found` for unknown drafts or drafts owned by different sellers. The seller also rejects the create with `404` unless this buyer owns every referenced draft. The account-wide Seedance task list (`GET /api/v3/contents/generations/tasks`) is not relayed because it would expose other buyers' tasks.

## Duplicate charge protection

The buyer proxy sends an `x-antseed-idempotency-key` on every create. A client-supplied `x-antseed-idempotency-key` or `Idempotency-Key` is reused; otherwise the proxy generates one and returns it in the response. The seller stores accepted responses by buyer, protocol, and key. Resending the same key returns the stored acceptance with no new job or charge. If the same key is still being processed, the seller returns `409 idempotency_in_progress`.

The proxy does not retry creates automatically. After an uncertain failure, clients should retry with the returned or supplied key. Before sending a create, the proxy saves which seller, provider and service received that key, alongside its job routes. A retry with the same key is always sent to that seller; if it is unreachable, the retry fails instead of starting a second paid job with another seller. If the proxy cannot save that record, it returns `503 video_route_persistence_failed` without sending the create. Use a new key to intentionally start a new job.
