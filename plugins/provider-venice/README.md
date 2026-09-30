# @antseed/provider-venice

Relays native Venice video requests to the Venice API.

## Configuration

Install with `antseed plugin add @antseed/provider-venice`, then configure:

- `VENICE_API_KEY`: Venice API key, sent as a bearer token
- `VENICE_BASE_URL`: optional, defaults to `https://api.venice.ai`
- `ANTSEED_ALLOWED_SERVICES`: Venice video model names, for example `wan-2.5-preview-text-to-video`
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `venice-video` pricing using `video_generations` or `video_seconds`

At startup the plugin reads Venice's video model list and advertises each model's supported durations, resolutions, aspect ratios, media inputs and audio. Unsupported creates are rejected before Venice is called. Options set through `ANTSEED_SERVICE_CAPABILITIES_JSON` take precedence. See [model options](../../docs/protocol/spec/10-native-video.md#model-options).

Check that Venice's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.

## Buyer API

Send native Venice requests to the local buyer proxy:

```text
POST /api/v1/video/queue
{"model":"wan-2.5-preview-text-to-video","prompt":"A cat in a garden","duration":"5s","resolution":"720p"}

POST /api/v1/video/retrieve
{"model":"wan-2.5-preview-text-to-video","queue_id":"<queue_id>"}
```

The queue call is charged once when Venice returns a `queue_id`. Retrieve is free: it returns Venice's JSON status while the job runs, then streams the finished MP4 from the same seller. Private models return JSON `COMPLETED` and deliver the file through the `download_url` from the queue response. `POST /api/v1/video/complete` is not relayed. Chat and image models on Venice continue to use `@antseed/provider-openai`.

For image-to-video, select an image-capable model and add `image_url` (an accessible URL or inline image data URL) to the same queue request. Native end-frame, reference-image and video inputs are forwarded unchanged where the model supports them. See [media-input examples and limitations](../../docs/protocol/spec/10-native-video.md#image-to-video-and-video-inputs).

Venice can return MP4s without `Content-Length`. The existing signed P2P format needs the byte length before sending the video, so these responses are first written to a private temporary file on the seller, then streamed to the buyer. The file is removed on completion or failure; there is one upstream fetch, bounded memory use, a 4 GiB size limit and at most two active downloads. Known-length responses stream directly. Buyer-visible progress starts after staging, and the buyer's 60-second idle timeout still applies while waiting for the first bytes. Sellers need enough temporary disk space for staged downloads.

See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
