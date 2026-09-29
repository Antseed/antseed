# @antseed/provider-veo

Relays native Veo video requests to a seller-operated API.

## Configuration

Install with `antseed plugin add @antseed/provider-veo`, then configure:

- `GEMINI_BASE_URL`: seller API base URL
- `GEMINI_API_KEY`: seller API credential
- `ANTSEED_ALLOWED_SERVICES`: native model names
- `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`: `veo-video` pricing using `video_generations` or `video_seconds`
- `ANTSEED_SERVICE_CAPABILITIES_JSON` (optional): per-model [video options](../../docs/protocol/spec/10-native-video.md#model-options), such as `{"model":{"video":{"durationsSeconds":[5,10],"inputs":["first_frame"]}}}`; unsupported creates are rejected before payment

## Buyer API

Send native requests to the local buyer proxy:

```text
POST /v1beta/models/veo-3.1-generate-preview:predictLongRunning

{"instances":[{"prompt":"A cat in a garden"}],"parameters":{"durationSeconds":8}}
```

Poll with `GET /v1beta/{operation-name}`. See [native video integration](../../docs/protocol/spec/10-native-video.md) for billing, routing, ownership, and retry behavior.

Image-to-video uses the same endpoint with `instances[0].image`. Native reference-image and video-extension fields are also forwarded unchanged, subject to the selected model's capabilities. See [media-input examples and limitations](../../docs/protocol/spec/10-native-video.md#image-to-video-and-video-inputs); local file paths and buyer-proxy download URLs are not usable upstream inputs.

## Result delivery

With `GEMINI_BASE_URL=https://generativelanguage.googleapis.com`, the plugin advertises `videoDownload: "video-stream-v1"` for its services. Updated buyers only rewrite completed Google video URLs when that capability is present; older sellers and custom base-URL origins keep their original URLs. Each local download checks ownership once, looks up the operation once, and streams one Google file fetch using the seller's private key. Downloads are free, may be up to 4 GiB, run two at a time, and fail only after 60 seconds without progress. The upstream must provide a valid `Content-Length`; missing lengths and truncated/oversized files fail safely. Client disconnects cancel seller-side fetching. No public download server, cloud storage, or extra database is required.

Fetch the returned `video.uri` directly, including when using the Gemini SDK for generation and polling. The Google JavaScript SDK's `files.download()` rebuilds a Google Files API path and does not handle these local HTTP URLs.

```typescript
const response = await fetch(video.uri);
if (!response.ok) throw new Error(`Video download failed: ${response.status}`);
```

Seller-operated APIs that return their own hosted result URLs continue to work unchanged; those URLs must be accessible without seller credentials. Never share the seller's API key with buyers. See the protocol guide for timeouts, concurrency limits, and cancellation behavior.
