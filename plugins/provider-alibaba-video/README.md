# @antseed/provider-alibaba-video

Relays video generation requests to Alibaba Cloud Model Studio models such as Wan 3.0 and HappyHorse, through Model Studio's [asynchronous task API](https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference).

## Configuration

```bash
antseed plugin add @antseed/provider-alibaba-video
export ALIBABA_VIDEO_API_KEY=<seller-model-studio-key>
```

- `ALIBABA_VIDEO_API_KEY`: Model Studio API key, sent as `Authorization: Bearer <key>`. Keys belong to one region
- `ALIBABA_VIDEO_BASE_URL`: optional, defaults to the Singapore endpoint `https://dashscope-intl.aliyuncs.com`
- `ANTSEED_ALLOWED_SERVICES`: service IDs (64 characters at most)
- `ANTSEED_SERVICE_ALIAS_MAP_JSON`: optional, service ID to Model Studio model when they differ (`upstreamModel` in the seller config)
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `fal-video` pricing using `video_seconds`
- `ANTSEED_SERVICE_CAPABILITIES_JSON`: optional video options to advertise

Each seller health sweep checks that Model Studio accepts the key. Model Studio has no free per-model check for video or a balance API, so an account out of credit or a retired model shows up as a rejected create rather than a stopped service.

## Requests

The plugin serves the `fal-video` protocol, Antseed's queue paths for video, so buyers, gateways and the desktop app use it unchanged:

| Antseed path | Model Studio call |
| --- | --- |
| `POST /fal/v1/video/queue` | `POST {base}/api/v1/services/aigc/video-generation/video-synthesis`; returns `{model, request_id, status}` |
| `POST /fal/v1/video/retrieve` with `{model, request_id}` | `GET {base}/api/v1/tasks/{id}`, then the result's `video_url` |

Model Studio task IDs stay queryable for 24 hours, and result URLs expire after the same time.

### Fields

| Request field | Model Studio field |
| --- | --- |
| `prompt` | `input.prompt` |
| `start_image_url`, `image_url` | `input.media` with `type: first_frame` |
| `end_image_url` | `input.media` with `type: last_frame` |
| `reference_image_urls` | `input.media` with `type: reference_image` |
| `duration` | `parameters.duration` |
| `resolution` | `parameters.resolution`, upper-cased |
| `aspect_ratio` | `parameters.ratio` |
| `audio` | `parameters.audio` |
| `seed` | `parameters.seed` |
| `enable_prompt_expansion` | `parameters.prompt_extend` |

Other fields are not sent. Images can be public URLs or inline `data:image/...;base64` URLs. A first or last frame can't be combined with reference images.

`duration` is required, because the buyer pays for it. `video_url`, `audio_url` and `reference_video_urls` are refused with `422 invalid_video_request` before any payment: Model Studio bills an input video on top of the output, which `duration` does not cover.
