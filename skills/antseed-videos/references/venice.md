# Venice video API through Antseed

The current Antseed native video protocol is `venice-video`. Other vendors, including Seedance models, can be used when a seller exposes them through Venice.

## Create

`POST /api/v1/video/queue`

```json
{
  "model": "<peerId>@<model>",
  "prompt": "A slow cinematic shot",
  "duration": "10s",
  "resolution": "1080p",
  "aspect_ratio": "16:9",
  "audio": true,
  "image_url": "data:image/png;base64,...",
  "end_image_url": "data:image/png;base64,..."
}
```

The proxy rewrites `<peerId>@<model>` to `<model>` before forwarding and records which seller accepted the returned `queue_id`. The create is free; the video is charged once, on delivery, when a retrieve returns the finished MP4.

Input fields:

- `first_frame`: `image_url`
- `last_frame`: `end_image_url`
- `reference_image`: `reference_image_urls`
- `video`: `video_url`
- `reference_video`: `reference_video_urls`
- `audio`: `audio_url` or `reference_audio_urls`

Use inline data URLs for local files. Local paths and `localhost` URLs are not reachable by upstream providers.

## Retrieve

`POST /api/v1/video/retrieve`

```json
{ "model": "<model>", "queue_id": "<queue_id>", "delete_media_on_completion": false }
```

The proxy routes retrieve to the accepting seller. JSON means the job is still pending, failed, or private-model completion. A successful MP4 response is the finished video. Private-model completion can require the `download_url` from the create response.

Retrieve is free and must not be used to start another job.
