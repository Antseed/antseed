# @antseed/provider-seedance

Relays native Seedance video requests to BytePlus ModelArk (or a compatible seller-operated API).

## Configuration

Install with `antseed plugin add @antseed/provider-seedance`, then configure:

- `ARK_API_KEY`: ModelArk API key, sent as a bearer token
- `ARK_BASE_URL` (optional): defaults to `https://ark.ap-southeast.bytepluses.com`
- `ANTSEED_ALLOWED_SERVICES`: ModelArk model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `seedance-video` pricing using `video_generations` or `video_seconds`
- `ANTSEED_SERVICE_CAPABILITIES_JSON` (optional): per-model [video options](../../docs/protocol/spec/10-native-video.md#model-options), such as `{"model":{"video":{"durationsSeconds":[5,10],"inputs":["first_frame"]}}}`; unsupported creates are rejected before payment

Sellers must add value beyond reselling ModelArk access and must follow BytePlus terms.

## Buyer API

Send native requests to the local buyer proxy:

```text
POST /api/v3/contents/generations/tasks

{"model":"seedance-2-0","content":[{"type":"text","text":"A cat in a garden"}],"resolution":"720p","duration":5}
```

- Poll with `GET /api/v3/contents/generations/tasks/{id}`. A finished task returns `content.video_url`, which ModelArk keeps for 24 hours; download it directly.
- `DELETE` is not relayed, so queued tasks cannot be cancelled through AntSeed.
- Draft flow: create with `"draft": true`, then create the final video with `{"type":"draft_task","draft_task":{"id":"<draft id>"}}` in `content`. The final create is sent to the seller that ran the draft. Both creates are charged.
- The account-wide task list is not relayed.
- `callback_url` is forwarded to ModelArk unchanged, so ModelArk (not AntSeed) posts task updates to that URL.

Image-to-video uses the same create endpoint with an `image_url` content item and `role: "first_frame"`. Last-frame, reference-image and reference-video inputs are forwarded unchanged where the selected model supports them. See [media-input examples and limitations](../../docs/protocol/spec/10-native-video.md#image-to-video-and-video-inputs).

Per-second pricing needs an explicit positive `duration`; `duration: -1` and `frames` requests need `video_generations` pricing. See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.
