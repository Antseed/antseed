# responses-api

/v1/responses through the proxy (provider-openai-responses): responses.create streaming and non-streaming, event shape, receipt tokens, exact settlement.

Status: planned, no scenario yet.

## What to test

- /v1/responses non-streaming and streaming (plugins/provider-openai-responses)
- response event shape and usage in the final event
- token billing and settlement for Responses traffic

## What the testbench needs first

- a mock /v1/responses endpoint with SSE events and usage
- a way to run provider-openai-responses without Codex auth (mock auth path or a test credential)
- tb.request()

Targets: local, fork. Capabilities: mockControl.
