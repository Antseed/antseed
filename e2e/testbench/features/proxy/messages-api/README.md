# messages-api

Anthropic-shaped /v1/messages through the proxy: a streaming and a non-streaming message answered by a testbench seller, count_tokens answered locally, exact settlement.

Status: planned, no scenario yet.

## What to test

- /v1/messages non-streaming and SSE streaming (apps/cli/src/proxy/buyer-proxy.ts, packages/api-adapter request-transform)
- count_tokens never reaches the upstream (apps/cli/src/proxy/count-tokens.ts)
- token billing for provider-anthropic / provider-claude-* shaped sellers

## What the testbench needs first

- a mock upstream that speaks the Anthropic Messages API (e2e/testbench/lib/mock.mjs serves only /v1/models, /v1/chat/completions, /v1/images/generations)
- provider-anthropic in the seller worker plugin table (seller-worker.mjs WORKSPACE_PLUGINS)
- tb.request() for arbitrary proxy paths

Targets: local, fork. Capabilities: mockControl.
