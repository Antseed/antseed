# @antseed/ant-agent

`AntAgentProvider` wraps a seller's `Provider`, adds a persona, guardrails and `antseed_*` tools to each request, and runs a tool loop against the inner provider. `antseed seller start` applies it when `seller.agentDir` is set. `@antseed/node` is used only for types.

| Rule | Enforced by |
| --- | --- |
| The agent's prompt comes first. The buyer's system prompt follows, wrapped as client context. | `src/system-prompt.test.ts` |
| A response mixing internal and buyer tool calls ends the loop and the internal call is not run, because a re-prompt would leave the buyer's call without a result. | `src/provider.test.ts`, `src/tools.test.ts` |
| Discovery metadata is forwarded one field at a time, so a new `Provider` field needs its own line in `provider.ts`. | `src/provider.test.ts` |
| Sellers run `runAgentLoopStream`, not the buffered loop: the node passes stream callbacks on every request, and each round sets `stream: true`. | review only |
| Any path other than chat completions or responses is handled as Anthropic format. | review only |
| A request is billed for every upstream call of its loop, each once: the returned response (what the seller meters) and the usage events the buyer receives report the sum. `LoopUsage` (`usage.ts`) wraps both loops; a new call to the inner provider must go through its `meter()`. | `src/usage.test.ts` |

**Ask first:** the order or wrapping of the injected prompt (it changes every agent's answers); the `antseed_` prefix; a new request format, which touches `tools.ts`, `system-prompt.ts`, `agent-loop.ts` and `sse-parser.ts`.

**Prove it:** the streaming tests mock JSON bodies and `antseed agent dev` uses the buffered loop, so neither proves a streaming change. Add a test that feeds real SSE chunks through `runAgentLoopStream`.
