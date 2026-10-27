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
- `FAL_VIDEO_MIN_BALANCE_USD`: optional, default `0`. Models stop being advertised while the fal balance is at or below it (needs the permission below)

Each seller health sweep reads fal's model list (`GET https://api.fal.ai/v1/models`, with the seller's key, since fal rate-limits anonymous lookups): an endpoint fal no longer lists, or no longer reports as `active`, stops being advertised. A `deprecated` endpoint stays advertised with a warning.

### Balance check

To stop advertising when the fal account runs out of credits, give `FAL_VIDEO_API_KEY` the `billing:usage:read` permission (fal key presets BILLING, READONLY or FULL, or a custom key that also runs models). One key does both; there is no separate billing key. At startup the seller reads the balance (`GET https://api.fal.ai/v1/account/billing?expand=credits`) and logs one of:

- `fal balance check is on: $<balance>; ...`: each health sweep checks the balance, and models are advertised again after a top-up.
- `fal balance check is off: FAL_VIDEO_API_KEY lacks the billing:usage:read permission ...`: the seller still sells, but running out of credits does not stop it advertising. Add the permission and restart to turn the check on.

A key fal rejects as invalid (`401`) stops the seller advertising its models.

The service ID is the fal endpoint ID; aliases are not supported.

## Requests

Buyers send fal's model input as JSON, with the endpoint ID as `model`:

| AntSeed path | fal call |
| --- | --- |
| `POST /fal/v1/video/queue` | `POST {base}/{model}` with the body minus `model`/`service`; returns `{model, request_id, status}` |
| `POST /fal/v1/video/retrieve` with `{model, request_id}` | `GET {base}/{owner}/{alias}/requests/{id}/status`, then the result's `video.url` |

Retrieve returns fal's `IN_QUEUE` / `IN_PROGRESS` status as JSON, `{"status":"FAILED"}` when fal reports an error, and streams the finished MP4 through the seller once fal reports `COMPLETED`. fal's `status_url`/`response_url` are not passed to buyers: they need the seller's key. Media is fetched from the `https` URL in the result without the seller key. Cancel and webhooks are not relayed.

The body is passed to fal unchanged, so field names are fal's own and differ by model (for example `start_image_url` for Kling V3, `image_url` for Seedance). At startup the seller reads each endpoint's input schema from `https://fal.ai/api/openapi/queue/openapi.json` (without the seller key) and announces its field names as `supportedParameters`, so buyers can name fields the way the model expects. A service that already sets `supportedParameters` in `ANTSEED_SERVICE_CAPABILITIES_JSON` keeps them. If the schema cannot be read, the service is announced without them. When a service announces `video.inputs` and its fields include a frame field (`image_url`, `start_image_url`, `end_image_url`, `tail_image_url`, ...), the matching `first_frame` or `last_frame` is added to `video.inputs`, so buyers can pick it for first-plus-last-frame videos.

### Video edits

An endpoint with a `video_url` field is a video edit (video-to-video) endpoint, for example `minimax/h3-max/recast`, `kling/v4/video-to-video/edit` or `fal-ai/kling-video/v3/standard/motion-control`. From its schema the seller also reads the required fields, the source video limits (`x-fal` on `video_url`: length, file size, width, height, aspect ratio, frame rate; Recast's 5–30 s is only in prose, so it is built in), the limits on input images such as motion control's `image_url`, and the `resolution` values, and announces `video` and the character image as `video.inputs` and `video.requiredInputs`, and the resolutions as `video.resolutions`. Options set in `ANTSEED_SERVICE_CAPABILITIES_JSON` win.

Before any payment, the seller checks each edit create and refuses it for free when a required field is missing, the source cannot be read or is outside the limits (for example Kling v4 edit's 700x700 minimum), an inline image is outside its limits (`invalid_image_input`), or `duration` is wrong. A create fal does not answer in time (60 s plus 1 s per 256 KB, at most 10 minutes) is answered `504 upstream_upload_timeout`. A job fal fails is reported as `FAILED` with fal's reason, so the job's payment channel closes at once. The source is an inline `data:` URL or a public `https` URL (read with range requests: public addresses only, 3 redirects, 16 requests, 10 s). The buyer pays for `duration`, so:

- an endpoint with no `duration` field (Recast, motion control) makes an output as long as the source. The buyer must send the source length in whole seconds, rounded down, and the seller removes `duration` before submitting to fal;
- an endpoint whose `duration` is cut from the source (Kling v4 edit, Wan 2.7 edit) accepts any `duration` up to the source length.

`video_seconds` pricing uses the request's `duration` (`5`, `"5"` or `"5s"`); use `video_generations` for models without a numeric duration.

Check that fal's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.
