# @antseed/api-adapter

HTTP-level format translation between LLM API protocols. Converts requests and responses between Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses — without any network calls.

## Supported Protocols

| Protocol | Identifier |
|---|---|
| Anthropic Messages | `anthropic-messages` |
| OpenAI Chat Completions | `openai-chat-completions` |
| OpenAI Responses | `openai-responses` |
| OpenAI Completions (legacy) | `openai-completions` |

## Transform Matrix

Request transforms use a small internal canonical request model so shared
fields, messages, tools, and tool results are normalized once and rendered to
the target protocol. Response success payloads use the same canonical response
shape where possible. Streaming adapters use the same hub pattern with
protocol-specific stream normalizers and renderers.

```
anthropic-messages  ⟷  openai-chat-completions
openai-responses    ⟷  openai-chat-completions
anthropic-messages  ⟷  openai-responses
```

## Usage

### Detect what protocol an incoming request speaks

```ts
import { detectRequestServiceApiProtocol } from '@antseed/api-adapter';

const protocol = detectRequestServiceApiProtocol(request);
// → 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses' | null
```

### Select a target protocol given what a provider supports

```ts
import { selectTargetProtocolForRequest } from '@antseed/api-adapter';

const selection = selectTargetProtocolForRequest('anthropic-messages', ['openai-chat-completions']);
// → { targetProtocol: 'openai-chat-completions', requiresTransform: true }

const passthrough = selectTargetProtocolForRequest('anthropic-messages', ['anthropic-messages']);
// → { targetProtocol: 'anthropic-messages', requiresTransform: false }

const reverse = selectTargetProtocolForRequest('openai-responses', ['anthropic-messages']);
// → { targetProtocol: 'anthropic-messages', requiresTransform: true }
```

### Transform a request before forwarding to a provider

```ts
import {
  transformRequest,
} from '@antseed/api-adapter';

// Buyer sent an Anthropic request; provider only speaks OpenAI Chat
const result = transformRequest(incomingRequest, {
  from: 'anthropic-messages',
  to: 'openai-chat-completions',
});
if (result) {
  const { request, streamRequested, requestedModel } = result;
  // forward `request` to the provider
}

// Buyer sent an Anthropic request; provider only speaks OpenAI Responses
const responsesResult = transformRequest(incomingRequest, {
  from: 'anthropic-messages',
  to: 'openai-responses',
});
```

### Transform a non-streaming response back to the original protocol

```ts
import {
  transformResponse,
} from '@antseed/api-adapter';

// Provider returned an OpenAI Chat response; buyer expects Anthropic
const adapted = transformResponse(providerResponse, {
  from: 'openai-chat-completions',
  to: 'anthropic-messages',
  streamRequested: false,
  fallbackModel: 'claude-sonnet',
});

// Provider returned an OpenAI Responses response; buyer expects Anthropic
const adaptedFromResponses = transformResponse(providerResponse, {
  from: 'openai-responses',
  to: 'anthropic-messages',
  streamRequested: false,
  fallbackModel: 'claude-sonnet',
});
```

### Adapt a streaming response incrementally

For streaming responses, create an adapter once per request and feed it chunks as they arrive.

```ts
import { createStreamingAdapter } from '@antseed/api-adapter';

const adapter = createStreamingAdapter({
  from: 'openai-chat-completions',
  to: 'anthropic-messages',
  fallbackModel: 'claude-sonnet',
});
if (!adapter) throw new Error('Unsupported stream transform');

// On first response headers:
const startResponse = adapter.adaptStart(providerResponse);
// startResponse.headers['content-type'] === 'text/event-stream'

// On each incoming SSE chunk:
const outChunks = adapter.adaptChunk(incomingChunk);
// outChunks is an array of SerializedHttpResponseChunk in Anthropic SSE format
```

The same pattern applies for any supported stream transform between Anthropic
Messages, OpenAI Chat Completions, and OpenAI Responses.

## API Reference

### Protocol detection & routing

```ts
detectRequestServiceApiProtocol(request): ServiceApiProtocol | null
inferProviderDefaultServiceApiProtocols(providerName): ServiceApiProtocol[]
selectTargetProtocolForRequest(requestProtocol, supportedProtocols): TargetProtocolSelection | null
```

`inferProviderDefaultServiceApiProtocols` maps well-known provider names (`'anthropic'`, `'claude-code'`, `'claude-oauth'`, `'openai'`, `'local-llm'`) to their default protocols.

### Requests

```ts
transformRequest(request, { from, to, streamRequested }): ServiceApiRequestTransformResult | null
```

`from` and `to` currently support `anthropic-messages`, `openai-chat-completions`, and `openai-responses`. Unsupported protocols return `null`.

`transformRequest`'s result carries `includeReasoning`: the client asked for the model's reasoning. That is a Responses request whose `include` lists `reasoning.encrypted_content`, a Chat Completions request that names a `reasoning_effort` other than `none`, or a Messages request with `thinking` `enabled` or `adaptive`. Pass it to `transformResponse` and `createStreamingAdapter`; without it, reasoning a seller wrote on its own is left out. With it:

- A Responses client gets a chat model's reasoning as a `reasoning` item, first in `output`, tagged with the model the request asked for, or the seller's label when it named none (`encrypted_content: "antseed.reasoning.v1:<model>"`).
- A Messages client gets it as a `thinking` block ahead of the answer, signed `antseed.reasoning.v1:<model>#<response id>`.
- A Chat Completions client gets it as `reasoning_content`.

When the client sends the item or the `thinking` block back in a request for that same model, ignoring case and a provider prefix, its text goes to the model as `reasoning_content`; for any other model it is dropped. `withoutAdapterReasoningItems(request)` removes these items from a Responses request bound for a Responses seller, and `withoutAdapterThinkingBlocks(request)` removes these `thinking` blocks from a Messages request bound for a Messages seller. Neither changes anything else.

### Responses

```ts
transformResponse(response, { from, to, streamRequested, fallbackModel }): SerializedHttpResponse | null
```

`from` and `to` currently support `anthropic-messages`, `openai-chat-completions`, and `openai-responses`. Unsupported protocols return `null`. When `streamRequested` is true, a successful non-stream provider response is rendered as target-protocol SSE.

### Streaming

```ts
createStreamingAdapter({ from, to, fallbackModel }): StreamingResponseAdapter | null
```

Returns a per-request adapter for streaming response chunks, or `null` for unsupported or same-protocol paths.

### Types

```ts
interface SerializedHttpRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface SerializedHttpResponse {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface SerializedHttpResponseChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}

interface StreamingResponseAdapter {
  adaptStart(response: SerializedHttpResponse): SerializedHttpResponse;
  adaptChunk(chunk: SerializedHttpResponseChunk): SerializedHttpResponseChunk[];
}
```

## File Structure

```
src/
  canonical.ts        Internal normalized request/response shape + protocol renderers
  request-transform.ts Generic request transform entry point
  utils.ts            Shared helpers: encode/decode, SSE parsing, toStringContent
  detect.ts           Protocol detection and target selection
  anthropic.ts        Anthropic Messages ↔ OpenAI Chat transforms + streaming adapter
  openai-responses.ts OpenAI Responses ↔ OpenAI Chat transforms + streaming adapter
  types.ts            Shared types (SerializedHttpRequest/Response, ServiceApiProtocol)
  index.ts            Public re-exports
```
