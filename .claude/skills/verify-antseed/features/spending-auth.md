# Per-request SpendingAuth

After the seller serves a paid request, it sends a NeedAuth with the request's cost. The buyer checks that cost against its own estimate and signs a SpendingAuth for the new cumulative amount. The cumulative amount only grows, and it is what the seller can settle on-chain.

## Sub-features

- `auth-cumulative` signs the running total after each request, exactly the cost of the delivered work.
- `auth-streaming` signs a streamed chat the same way, with usage from the final SSE chunk.
- `auth-receipts` counts each request in the channel's `requestCount`.
- `auth-settle-match` settles on-chain exactly what the buyer signed.

## How to get to it (user POV)

- Send chats through the buyer proxy, streaming (`"stream": true`) or not.
- Chat from the desktop app.

## Driving it with pnpm sandbox

Preconditions:

- Baseline preconditions from the [index](./README.md).
- One seller. The shipped scenarios are `chat-basic` and `payment-flow`.

- **Non-streaming chat.** Call `sb.chat({ model })`. The reply has `usage.total_tokens > 0`.
- **Streaming chat.** Call `sb.chat({ model, stream: true })`. The parsed SSE content is not empty and `usage` is set.
- **Signed amount.** Read `(await sb.channels())[seller.id][0]`. `cumulativeSigned` equals `sb.mockCostPerChat(seller.id, model)` times the number of chats, and `requestCount` equals the number of chats. The NeedAuth arrives after the reply, so poll with `sb.waitFor()` before you compare.
- **Upstream count.** Call `sb.mockRequests(seller.id)` and keep entries whose `path` is `/v1/chat/completions`. The count equals the number of chats.
- **Exact settlement.** Call `sb.closeAll()`, then `sb.assertSettlementMatchesSigned()`. It throws unless on-chain settlement equals `sb.signedBySeller()` and every reserve is released.
- **Proof.** Run `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs chat-basic --chain local`. `checks.log` shows `PASS buyer signed a nonzero cumulative amount` and `PASS exact on-chain settlement with zero reserves`.

## Gotchas

- `chat-basic` reports one `KNOWN` result after a cooperative close: two 18 micro-USDC chats settle 54, not 36 (see [Close, settle and withdraw](./close-and-withdraw.md)). It is not a new regression. On a scratch merged with `origin/main` the check prints `PASS`, because `main` already fixed the defect.
- `cumulativeSigned` is a decimal string of micro-USDC. Compare it as `BigInt`.
- The buyer rejects a NeedAuth whose cost exceeds 1.4 times its own estimate. The mock's fixed usage never triggers that path.
- Only the OpenAI-compatible mock gives exact costs. With `--live`, compare against the signed amount, not a fixed cost.
