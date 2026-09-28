# Native video API integration

AntSeed relays native Runway, Veo, MiniMax, Wan, Seedance, and Venice video requests to seller-operated APIs. Sellers own execution, storage, and refund policy. AntSeed does not cache artifacts.

Direct Gemini Veo downloads and finished Venice videos are streamed through the original seller; its API key never leaves the seller. Other providers and seller-hosted result URLs remain unchanged and must be accessible to buyers without seller credentials.

## Supported requests

| Protocol | Method | Native path |
| --- | --- | --- |
| `runway-video` | POST | `/v1/text_to_video`, `/v1/image_to_video` |
| `runway-video` | GET, DELETE | `/v1/tasks/{id}` |
| `veo-video` | POST | `/v1beta/models/{model}:predictLongRunning` |
| `veo-video` | GET | `/v1beta/{operation-name}` |
| `veo-video` | GET | `/v1beta/{operation-name}/videos/{index}:download` (AntSeed endpoint) |
| `minimax-video` | POST | `/v2/video_generation` |
| `minimax-video` | GET | `/v2/query/video_generation/{task_id}` |
| `minimax-video` | DELETE | `/v2/video_generation/{task_id}` |
| `wan-video` | POST | `/api/v1/services/aigc/video-generation/video-synthesis` |
| `wan-video` | GET | `/api/v1/tasks/{task_id}` |
| `seedance-video` | POST | `/api/v3/contents/generations/tasks` |
| `seedance-video` | GET, DELETE | `/api/v3/contents/generations/tasks/{id}` |
| `venice-video` | POST | `/api/v1/video/queue` |
| `venice-video` | POST | `/api/v1/video/retrieve` (status or streamed MP4), `/api/v1/video/complete` (delete stored media) |

Veo uses the path model as the service; every other API uses the body `model`. Venice follow-ups carry `queue_id` in the JSON body instead of the path; the seller rebuilds them as `{model, queue_id}` (plus `delete_media_on_completion` on retrieve) from the owned job and routed service. `/api/v1/video/quote` is not relayed. Each API's paths, job ID field, and billing fields are declared in one table in `packages/api-adapter/src/native-video.ts`. Service names must equal seller model names. Request bodies are forwarded byte-for-byte, and chat aliases, pins, and model rewrites are not applied. Video services appear in `GET /v1/models?type=videos`.

## Billing

A create is charged when the seller returns an accepted job ID: Runway and Seedance `id`, Veo `name`, MiniMax `task_id`, Wan `output.task_id`, or Venice `queue_id`. Polling and cancellation are free. Pricing uses `video_generations` or `video_seconds`; per-second pricing requires an explicit positive duration (`duration`, Veo `parameters.durationSeconds`, Wan `parameters.duration`). Venice durations such as `"5s"` are read as seconds. Runway `auto`, Seedance `-1`, Seedance `frames`, and Venice `auto`, `-1`, and `1 gen` requests have no explicit duration, so they need `video_generations` pricing. Veo reads `numberOfVideos` or `sampleCount`; every other API bills one video per create.

## Routing and ownership

### Streamed downloads

Venice `/api/v1/video/retrieve` is always sent as a streamed download to a seller advertising `videoDownload = "video-stream-v1"` (the Venice plugin always does). While the job runs the seller returns Venice's JSON status unchanged; once finished it streams the MP4 using the same flow as Veo below. Private Venice models return JSON `COMPLETED` and deliver the file through the `download_url` from the queue response, which is passed to the buyer unchanged. Venice bills some moderation rejections itself, so a create is still charged once accepted.

Venice MP4 responses without `Content-Length` are staged in a seller-local private temporary file to determine the length required by response-auth v1, then streamed through the same authenticated P2P path. This uses one upstream fetch and bounded memory; the existing 4 GiB limit and two-download concurrency limit also apply during staging. Temporary files are removed on completion, cancellation or failure. Known-length responses do not use disk. No buyer-visible bytes arrive during staging, so the buyer's 60-second idle timeout can still cancel a slow preparation. The `delete_media_on_completion` field is only forwarded to retrieve, never to complete.

### Veo downloads

For completed Veo operations, the buyer proxy replaces Google file URLs with local download URLs only when the selected provider and service advertise `serviceCapabilities[service].videoDownload = "video-stream-v1"` in signed metadata. This field is encoded in metadata v13 as a download-version byte before each service capability entry's presence byte (0 = absent, 1 = `video-stream-v1`). Sellers without download capabilities continue announcing v12. Missing or unknown capabilities leave upstream URLs unchanged; manually requesting a local download from an unsupported seller returns 501. The direct-Google Veo plugin advertises the capability automatically; custom `GEMINI_BASE_URL` origins do not.

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
