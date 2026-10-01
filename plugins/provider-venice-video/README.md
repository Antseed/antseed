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

The plugin relays `POST /api/v1/video/queue` unchanged and handles `POST /api/v1/video/retrieve` by returning Venice JSON status or streaming the finished MP4 through the seller. It does not fetch or enforce Venice model metadata. `POST /api/v1/video/complete` is not relayed.

Check that Venice's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.
