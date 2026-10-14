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

The service ID is the fal endpoint ID; aliases are not supported.

## Requests

Buyers send fal's model input as JSON, with the endpoint ID as `model`:

| AntSeed path | fal call |
| --- | --- |
| `POST /fal/v1/video/queue` | `POST {base}/{model}` with the body minus `model`/`service`; returns `{model, request_id, status}` |
| `POST /fal/v1/video/retrieve` with `{model, request_id}` | `GET {base}/{owner}/{alias}/requests/{id}/status`, then the result's `video.url` |

Retrieve returns fal's `IN_QUEUE` / `IN_PROGRESS` status as JSON, `{"status":"FAILED"}` when fal reports an error, and streams the finished MP4 through the seller once fal reports `COMPLETED`. fal's `status_url`/`response_url` are not passed to buyers: they need the seller's key. Media is fetched from the `https` URL in the result without the seller key. Cancel and webhooks are not relayed.

`video_seconds` pricing uses the request's `duration` (`5`, `"5"` or `"5s"`); use `video_generations` for models without a numeric duration.

Check that fal's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.
