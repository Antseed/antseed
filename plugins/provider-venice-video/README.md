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

The plugin relays `POST /api/v1/video/queue` unchanged and handles `POST /api/v1/video/retrieve` by returning Venice JSON status or streaming the finished MP4 through the seller. For private models, Venice returns a short-lived `download_url` on queue; the plugin removes it from the buyer's response, keeps it for 24 hours, and streams the file from it once retrieve reports `COMPLETED`. Kept URLs are saved in the seller's data directory (`venice-video-download-urls.json`, set through `ANTSEED_DATA_DIR`, which `antseed seller start` passes automatically), so they survive a seller restart. It does not enforce Venice model metadata. `POST /api/v1/video/complete` is not relayed.

Check that Venice's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.
