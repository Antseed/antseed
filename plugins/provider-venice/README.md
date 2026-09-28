# @antseed/provider-venice

Relays native Venice video requests to the Venice API.

## Configuration

Install with `antseed plugin add @antseed/provider-venice`, then configure:

- `VENICE_API_KEY`: Venice API key, sent as a bearer token
- `VENICE_BASE_URL`: optional, defaults to `https://api.venice.ai`
- `ANTSEED_ALLOWED_SERVICES`: Venice video model names, for example `wan-2.5-preview-text-to-video`
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `venice-video` pricing using `video_generations` or `video_seconds`

Check that Venice's terms allow your offering. AntSeed sellers must add value rather than resell raw API access.

## Buyer API

Send native Venice requests to the local buyer proxy:

```text
POST /api/v1/video/queue
{"model":"wan-2.5-preview-text-to-video","prompt":"A cat in a garden","duration":"5s","resolution":"720p"}

POST /api/v1/video/retrieve
{"model":"wan-2.5-preview-text-to-video","queue_id":"<queue_id>"}
```

The queue call is charged once when Venice returns a `queue_id`. Retrieve is free: it returns Venice's JSON status while the job runs, then streams the finished MP4 from the same seller. Private models return JSON `COMPLETED` and deliver the file through the `download_url` from the queue response. `POST /api/v1/video/complete` deletes the stored media. Chat and image models on Venice continue to use `@antseed/provider-openai`.

For image-to-video, select an image-capable model and add `image_url` (an accessible URL or inline image data URL) to the same queue request. Native end-frame, reference-image and video inputs are forwarded unchanged where the model supports them. See [media-input examples and limitations](../../docs/protocol/spec/10-native-video.md#image-to-video-and-video-inputs).

Venice can return MP4s without `Content-Length`. The existing signed P2P format needs the byte length before sending the video, so these responses are first written to a private temporary file on the seller, then streamed to the buyer. The file is removed on completion or failure; there is one upstream fetch, bounded memory use, a 4 GiB size limit and at most two active downloads. Known-length responses stream directly. Buyer-visible progress starts after staging, and the buyer's 60-second idle timeout still applies while waiting for the first bytes. Sellers need enough temporary disk space for staged downloads.

See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.

## Opt-in live verification

The video payment-flow suite includes a live Venice matrix test. It starts a local buyer and seller, uses real Venice generation, and mocks only the settlement chain. It is skipped unless explicitly enabled; it spends real Venice credits.

Set `ANTSEED_LIVE_VENICE=1`, `ANTSEED_LIVE_VENICE_KEY`, `ANTSEED_LIVE_VENICE_MATRIX` (a JSON file containing an array of native queue request bodies), `ANTSEED_LIVE_VENICE_OUTPUT` (a private output directory), and `ANTSEED_LIVE_VENICE_BUDGET_USD`. Each case needs an explicit duration such as `"4s"`. The test quotes the entire matrix before submitting anything and refuses a quoted total above the budget. Choose supported models and settings from Venice's `/api/v1/models?type=video` endpoint.

From `e2e`, run:

```sh
pnpm exec vitest run tests/openai-images-payment-flow.test.ts -t 'real Venice video matrix'
```

The output directory contains downloaded MP4 files and a key-free `report.json` with queue IDs, quotes, settings, replay checks, polling results and verified AntSeed charges. The test deletes stored upstream media only after a successful download. Do not blindly rerun a failed matrix: accepted generations have already spent credits, and a new run creates new jobs. Inspect the saved report first. This verifies models accessed through Venice, not the separate native Veo or Seedance plugins. Other vendors' models remain available through Venice without their own native AntSeed plugins.

To retry downloads without generating again, set `ANTSEED_LIVE_VENICE_RESUME_REPORT` to the original report and `ANTSEED_LIVE_VENICE_RESUME_STATE` to a private directory containing consistent `buyer/` and `seller/` data-directory snapshots, including identities, routes and SQLite databases. Resume only supports accepted P2P-stream jobs whose media has not been deleted; use a new output directory. The matrix must match the original requests. Treat state snapshots as secrets even though they contain only local test identities, not the Venice key.
