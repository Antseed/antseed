# @antseed/provider-venice-video

Relays native Venice video requests to the Venice API.

## Configuration

```bash
antseed plugin add @antseed/provider-venice-video
export VENICE_VIDEO_API_KEY=<seller-api-key>
```

- `VENICE_VIDEO_API_KEY`: Venice API key, sent as a bearer token
- `VENICE_VIDEO_BASE_URL`: optional, defaults to `https://api.venice.ai`
- `ANTSEED_ALLOWED_SERVICES`: Venice video model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `venice-video` pricing using `video_generations` or `video_seconds`
- `ANTSEED_SERVICE_CAPABILITIES_JSON`: optional video options to advertise
- `VENICE_VIDEO_MIN_BALANCE_USD`: optional, default `0`. Models stop being advertised while the key's Venice balance (USD + DIEM + bundled credits) is at or below it

Each seller health sweep runs two free checks. The account check reads `GET /api/v1/api_keys/rate_limits` (key, access, balance): a rejected key, blocked access, or a balance at the minimum stops every model being advertised. The model check reads Venice's public `GET /api/v1/models?type=video`: a model Venice no longer lists stops being advertised. The list doesn't count against the key's video request limit. A model is advertised again once both checks pass. Neither call generates media.

Venice's model list does not say which image-to-video models accept a last frame, so the seller asks Venice at startup. For each image-to-video model without configured `video.inputs`, it sends one create that Venice must reject (empty prompt, impossible duration). Venice lists every problem in its `400` answer and names `end_image_url` when the model can't take one, so the check starts no job and costs nothing. Models Venice doesn't object to announce `end_image_url`. The checks are paced to stay under Venice's 40 video requests a minute; an unclear answer announces the first frame only. To skip the check, or to require frames, announce them yourself:

```json
{
  "seedance-2-0-image-to-video-basic": {
    "video": { "inputs": ["first_frame", "last_frame"], "requiredInputs": ["first_frame"] }
  },
  "pixverse-c1-transition": {
    "video": { "inputs": ["first_frame", "last_frame"], "requiredInputs": ["first_frame", "last_frame"] }
  }
}
```

With `antseed seller start`, set this per service as `seller.providers.<name>.services.<id>.capabilities`.

At startup the seller reads Venice's video model list (`GET /api/v1/models?type=video`) and announces the queue fields each model takes as `supportedParameters`: `prompt`, `duration`, `resolution` and `aspect_ratio` when the model lists values, `audio` when it is configurable, and the frame fields for the `video.inputs` you announce (`image_url`, `end_image_url`, `reference_image_urls`). When you announce none, image-to-video models get `image_url`, plus `end_image_url` when the startup check says the model takes a last frame. Buyers send only the fields listed. A service that sets `supportedParameters` itself keeps it. If the list cannot be read or does not include the model, the service is announced without it.

### Aspect ratio and audio

Venice prices a clip by its aspect ratio and audio as well as its resolution and duration (for example Seedance 2.5 at 480p for 4 s: $0.51 at 16:9, $0.67 at 21:9; Veo 3.1 costs less without audio). Price them with components that match `aspect_ratio` and `audio` (`"true"` / `"false"`) next to `resolution` (metadata v16, up to 64 components per model), for example:

```json
{ "unit": "video_seconds", "priceUsd": 0.0701, "match": { "resolution": "480p", "aspect_ratio": "16:9", "audio": "true" } }
```

Buyers price a create that leaves out `aspect_ratio` at the first announced one, and one that leaves out `audio` at `video.audio`, and the plugin sends Venice the same:

- `video.aspectRatios`: a create with another `aspect_ratio` is answered `422 unsupported_video_option` before payment and without calling Venice. A create without one is sent with the first listed.
- `video.audio`: `false` (a silent service) refuses `audio: true` and, for a model whose audio Venice lets you turn off (`audio_configurable`), sends `audio: false` when the create leaves it out (Venice adds audio by default). While Venice's model list hasn't been read (or lacks the model), a create without `audio` is refused instead, so it must say `audio: false`.

A service with `video.audio: true` accepts `audio: false`; give it its own price if Venice charges less. Options you don't announce are relayed as sent.

### Video edits

Models Venice marks `video_input` (for example `minimax-h3-max-recast`, `kling-v3-standard-motion-control`, `wan-2-7-video-to-video`) take a source video as `video_url`. For each one, the seller announces `video` and `reference_image` in `video.inputs`, and `video_url` and `image_url` (the character for motion control; Venice accepts it on every edit model) in `supportedParameters`. To learn whether the model takes reference images, it sends one create Venice must reject (empty `reference_image_urls`, impossible duration). Venice answers that a reference is required, not supported, or says nothing, and nothing is queued. A required one is announced in `video.requiredInputs`, and an accepted one adds `reference_image_urls`. Announcing `video.inputs` yourself skips this check. The seller also announces each edit model's `resolutions` from Venice's model list, in Venice's case.

The buyer pays for `duration`. Venice bills an edit listing only `Auto` durations for the whole source, and an output shorter than `duration` is never charged, so for every edit model the seller measures the source and answers `422 invalid_video_duration`, before payment and without calling Venice, unless `duration` is the source length in whole seconds, rounded down (for example `"6s"` for a 6.2 s source). The source must be inline (`data:video/mp4;base64,...`). Otherwise the seller does not check the source; Venice does. A job Venice rejects after it was queued (for example motion control or Recast on a video without a person, or a source that is too short) is answered on retrieve with a JSON `400`/`422`. The plugin turns that into `{"status":"FAILED","error":"<reason>"}`, so the job's payment channel is closed at once instead of when it expires. Venice answers a body above 32.5 MB with an HTML `413`; the plugin turns that into a JSON `413 request_too_large`.

The plugin relays `POST /api/v1/video/queue` unchanged, apart from the announced options above, and handles `POST /api/v1/video/retrieve` by returning Venice JSON status or streaming the finished MP4 through the seller. For private models, Venice returns a short-lived `download_url` on queue; the plugin removes it from the buyer's response, keeps it for 24 hours, and streams the file from it once retrieve reports `COMPLETED`. Kept URLs are saved in the seller's data directory (`venice-video-download-urls.json`, set through `ANTSEED_DATA_DIR`, which `antseed seller start` passes automatically), so they survive a seller restart. Other Venice model metadata is not enforced. `POST /api/v1/video/complete` is not relayed.

Check that Venice's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.
