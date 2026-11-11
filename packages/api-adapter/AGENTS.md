# @antseed/api-adapter

Translation between Anthropic Messages, OpenAI Chat Completions and OpenAI Responses (requests, responses, streams), used only when the seller lacks the buyer's protocol. `selectTargetProtocolForRequest` returns `requiresTransform: false` whenever the seller speaks it. Every protocol normalizes into one hub (`canonical.ts`) and renders out of it, so a fix lands once, never pair by pair. What both standards can express survives: images, tools, tool results. What the target can't express is dropped, never invented. No network, no Node-only APIs (browsers run it).

| Rule | Enforced by |
| --- | --- |
| A natively supported request passes untransformed. | `tests/adapter.test.ts` ("selects passthrough protocol") |
| Images, tool calls and tool results survive every supported pair. | `tests/adapter.test.ts` ("preserves ...") |

**Ask first:** a new protocol or fallback pair (`STANDARD_ADAPTER_FALLBACKS`); anything that changes a passthrough request.
