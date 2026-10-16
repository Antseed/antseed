# @antseed/provider-fal-video

Relays video generation requests to fal.ai model endpoints through fal's [queue API](https://docs.fal.ai/model-apis/model-endpoints/queue).

## Configuration

```bash
antseed plugin add @antseed/provider-fal-video
export FAL_VIDEO_API_KEY=<seller-fal-key>
```

- `FAL_VIDEO_API_KEY`: fal API key, sent as `Authorization: Key <key>`
- `FAL_VIDEO_BASE_URL`: optional, defaults to `https://queue.fal.run`
- `ANTSEED_ALLOWED_SERVICES`: fal endpoint IDs such as `fal-ai/kling-video/v2.1/standard/text-to-video` (64 characters at most)
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `fal-video` pricing using `video_generations` or `video_seconds`
- `ANTSEED_SERVICE_CAPABILITIES_JSON`: optional video options to advertise
- `FAL_VIDEO_BILLING_API_KEY`: optional fal key with the `billing:usage:read` permission (presets BILLING, READONLY or FULL), used only to read the credit balance
- `FAL_VIDEO_MIN_BALANCE_USD`: optional, default `0`. With a billing key, models stop being advertised while the balance is at or below it

Each seller health sweep reads fal's model list (`GET https://api.fal.ai/v1/models`, with the seller's key, since fal rate-limits anonymous lookups): an endpoint fal no longer lists, or no longer reports as `active`, stops being advertised. A `deprecated` endpoint stays advertised with a warning. Without a billing key, running out of credits is not detected.

The service ID is the fal endpoint ID; aliases are not supported.

## Requests

Buyers send fal's model input as JSON, with the endpoint ID as `model`:

| AntSeed path | fal call |
| --- | --- |
| `POST /fal/v1/video/queue` | `POST {base}/{model}` with the body minus `model`/`service`; returns `{model, request_id, status}` |
| `POST /fal/v1/video/retrieve` with `{model, request_id}` | `GET {base}/{owner}/{alias}/requests/{id}/status`, then the result's `video.url` |

Retrieve returns fal's `IN_QUEUE` / `IN_PROGRESS` status as JSON, `{"status":"FAILED"}` when fal reports an error, and streams the finished MP4 through the seller once fal reports `COMPLETED`. fal's `status_url`/`response_url` are not passed to buyers: they need the seller's key. Media is fetched from the `https` URL in the result without the seller key. Cancel and webhooks are not relayed.

The body is passed to fal unchanged, so field names are fal's own and differ by model (for example `start_image_url` for Kling V3, `image_url` for Seedance). At startup the seller reads each endpoint's input schema from `https://fal.ai/api/openapi/queue/openapi.json` (without the seller key) and announces its field names as `supportedParameters`, so buyers can name fields the way the model expects. A service that already sets `supportedParameters` in `ANTSEED_SERVICE_CAPABILITIES_JSON` keeps them. If the schema cannot be read, the service is announced without them. When a service announces `video.inputs` and its fields include a frame field (`image_url`, `start_image_url`, `end_image_url`, `tail_image_url`, ...), the matching `first_frame` or `last_frame` is added to `video.inputs`, so buyers can pick it for first-plus-last-frame videos.

`video_seconds` pricing uses the request's `duration` (`5`, `"5"` or `"5s"`); use `video_generations` for models without a numeric duration.

Check that fal's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.
