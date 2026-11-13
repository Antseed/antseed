# @antseed/ant-agent

`AntAgentProvider` wraps a seller's `Provider`, adds a persona, guardrails and `antseed_*` tools to each request, and runs a tool loop against the inner provider. `antseed seller start` applies it when `seller.agentDir` is set. `@antseed/node` is used only for types.

## Inside

- `src/provider.ts` — the wrapper; picks an agent per request (exact service or model, then `'*'`).
- `src/loader.ts` — `loadAntAgent(dir)` reads `agent.json`, persona, knowledge and manifest tools.
- `src/system-prompt.ts`, `src/tools.ts`, `src/agent-loop.ts`, `src/sse-parser.ts` — prompt injection, tool handling, the buffered and streaming loops, SSE reassembly.
- A new built-in tool is an `AntAgentTool` in `tools.ts`, added in `resolveTools` (`provider.ts`). Name it without the prefix; `antseed_` is added on injection and stripped on execution.

| Rule | Enforced by |
| --- | --- |
| The agent's prompt comes first. The buyer's system prompt follows, wrapped as client context. | `src/system-prompt.test.ts` |
| A response mixing internal and buyer tool calls ends the loop and the internal call is not run, because a re-prompt would leave the buyer's call without a result. | `src/provider.test.ts`, `src/tools.test.ts` |
| Discovery metadata is forwarded one field at a time, so a new `Provider` field needs its own line in `provider.ts`. | `src/provider.test.ts` |
| Sellers run `runAgentLoopStream`, not the buffered loop: the node passes stream callbacks on every request, and each round sets `stream: true`. | review only |
| Any path other than chat completions or responses is handled as Anthropic format. | review only |
| The `<!-- antseed-ant-agent -->` marker makes injection idempotent. A forced `tool_choice` skips tool injection. | `src/system-prompt.test.ts`, `src/tools.test.ts` |
| A non-JSON body or no matching agent passes through unchanged; a throwing or unknown tool becomes an error tool result, never a failed request. | `src/provider.test.ts`, `src/tools.test.ts` |
| The buffered loop strips `antseed_*` calls from the final response, even after max iterations. Anthropic array system prompts keep the last buyer `cache_control`. | `src/provider.test.ts`, `src/system-prompt.test.ts` |

## Connections

- Peer of `@antseed/node` for `Provider` types (`packages/node/src/interfaces/seller-provider.ts`); a change to that interface lands here too.
- Used by `apps/cli/src/cli/commands/seller/start.ts` (wraps every provider; `seller.agentDir` resolved in `apps/cli/src/config/loader.ts`) and `apps/cli/src/cli/commands/agent.ts` (`antseed agent dev`). Health checks probe the unwrapped provider; keep that pairing.
- `deploy/tee-seller/package-lock.json` pins a published version, so a fix reaches that image only after a release and a lockfile update.

## Traps

- Discovery fields were dropped twice (`serviceCapabilities`, `serviceUnitBillingModels`), so agent sellers announced no capabilities or unit billing. Forward every new `Provider` field.
- After `maxIterations` the streaming loop makes one more call with the `antseed_*` tools still in the body and forwards every chunk unfiltered.
- If `handleRequestStream` throws, the stream falls back to `inner.handleRequest` and sends the JSON body as one chunk, possibly after SSE went out.
- Stream suppression is substring matching on chunk text; a tool name split across chunks leaks.
- In OpenAI format the system `content` is assumed to be a string; a content-parts array becomes `[object Object]`.
- Manifest tools run seller-supplied code in the seller process via `import()`.

**Ask first:** the order or wrapping of the injected prompt (it changes every agent's answers); the `antseed_` prefix or the injection marker; a new request format, which touches `tools.ts`, `system-prompt.ts`, `agent-loop.ts` and `sse-parser.ts`; the `agent.json` manifest shape.

**Prove it:** `pnpm --filter @antseed/ant-agent test` and `typecheck`. The streaming tests mock JSON bodies and `antseed agent dev` uses the buffered loop, so neither proves a streaming change. Add a test that feeds real SSE chunks through `runAgentLoopStream`. A change to wrapping or `agentDir` also runs the CLI's `src/config/loader.test.ts`.
