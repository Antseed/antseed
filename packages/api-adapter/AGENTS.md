# @antseed/api-adapter

Translation between Anthropic Messages, OpenAI Chat Completions and OpenAI Responses (requests, responses, streams), used only when the seller lacks the buyer's protocol. `selectTargetProtocolForRequest` returns `requiresTransform: false` whenever the seller speaks it. Every protocol normalizes into one hub (`canonical.ts`) and renders out of it, so a fix lands once, never pair by pair. What both standards can express survives: images, tools, tool results. What the target can't express is dropped, never invented. No network, no Node-only APIs (browsers run it).

Published to npm. It also reads the facts billing needs from standard API bodies (token usage, images, video, speech).

## Inside

- `src/detect.ts` — protocol detection and `STANDARD_ADAPTER_FALLBACKS`. A new fallback pair goes there.
- `src/canonical.ts`, `request-transform.ts`, `response-transform.ts`, `stream-transform.ts` — the hub and the translations. A field that must survive translation goes into `CanonicalLlmRequest` with a normalizer and a renderer per protocol, plus a "preserves" test.
- `src/utils.ts` (`extractUsage` and request facts), `native-video.ts` + `mp4.ts`, `speech-audio.ts` — billing facts.
- `tests/adapter.test.ts` covers every pair, both directions, and streams.

| Rule | Enforced by |
| --- | --- |
| A natively supported request passes untransformed. | `tests/adapter.test.ts` ("selects passthrough protocol") |
| Images, tool calls and tool results survive every supported pair. | `tests/adapter.test.ts` ("preserves ...") |
| Fresh and cached input are independent counts. OpenAI's `prompt_tokens` includes the cached subset; Anthropic's `input_tokens` excludes cache reads. | `tests/extract-usage.test.ts` |
| Speech is charged only for a 2xx answer framed like real audio; a JSON error body, a stub or a cut-off file never counts. Keep `isSpeechAudio` strict. | `tests/speech.test.ts` |
| A streamed video counts as delivered only as a complete MP4 near the requested length (`VIDEO_MIN_DURATION_RATIO`). | `tests/mp4.test.ts` |
| Environment-free: no `node:*` or Node built-in imports, no `Buffer`, no `process`, no network or file access, no runtime dependency but `@antseed/protocol` and `tokenx`. | review only |

## Connections

- Depends on `@antseed/protocol`. Build tier 0. Pinned by buyer-core, node, `apps/cli` (buyer proxy and gateway) and the media plugins; a bump cascades to all of them.
- Installed plugins pin their own copy (`apps/cli/src/plugins/drift.ts`), so a fix reaches a seller's media plugin only when its plugins refresh.
- Kept in sync by hand: `src/types.ts` copies the protocol lists from `packages/protocol/src/service-api.ts`, same order, no test. Paths in `detect.ts` match the routes the buyer proxy serves.

## Traps

- Anthropic `content` can be a string, an array or one block object. Only the array path keeps images, tool calls and cache markers.
- An Anthropic seller caches nothing without `cache_control` markers; the renderer adds a standard set when a translated request has none. `metadata.user_id` stands in for `prompt_cache_key` toward OpenAI targets.
- A request translated to `openai-responses` always streams. The client's choice travels in `x-antseed-client-stream-requested`, a string copied in `plugins/provider-openai-responses/src/index.ts`.
- Anthropic's streaming `message_start` nests input and cache counts under `message.usage`. Missing that unwrap once metered every cached stream at the tail count.
- Typecheck sees Node types (hoisted `@types/node`), so it will not flag a Node-only API.
- Images are inferred from no provider name; a seller must announce `openai-images` per service.

**Ask first:** a new protocol or fallback pair (`STANDARD_ADAPTER_FALLBACKS`); anything that changes a passthrough request.

**Prove it:** `pnpm --filter @antseed/api-adapter test` and `typecheck`. Then build it and run buyer-core's and node's tests; a change to request or stream translation also runs `apps/cli` tests (`buyer-proxy.test.ts`).
