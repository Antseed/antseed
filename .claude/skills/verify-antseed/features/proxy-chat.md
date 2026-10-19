# Proxy chat

A buyer's client sends OpenAI-style requests to the local buyer proxy, which lists the sellers' models and forwards chats to a seller, paying per request on one channel.

## Sub-features

- `chat-catalog` lists every seller model at `/v1/models`.
- `chat-plain` answers a non-streaming chat with usage.
- `chat-stream` answers a streaming chat with usage.
- `chat-receipts` puts both requests on one open channel with a nonzero signed amount.
- `chat-settle` settles exactly the delivered work.

## How to get to it (user POV)

- Point any OpenAI-compatible client at the buyer proxy (`ANTSEED_PROXY_URL`).
- `curl "$ANTSEED_PROXY_URL/v1/models"` and `POST /v1/chat/completions`.

## Driving it with sb

Preconditions:

- `pnpm sandbox run chat-basic --chain local` (one seller), or a running sandbox and `eval "$(pnpm -s sandbox status --env)"`.

- **Catalog.** `sb.models()` or `curl "$ANTSEED_PROXY_URL/v1/models"`. Every seller model is listed.
- **Chat.** `sb.chat({ prompt })` and `sb.chat({ prompt, stream: true })`. Content contains `seller <id>`, `usage.total_tokens > 0`.
- **Upstream.** `sb.mockRequests(seller.id)`. Exactly the chats sent.
- **Receipts.** `sb.channels()`. One open channel, `requestCount` equals the chats, `BigInt(cumulativeSigned) > 0n`.
- **Settle.** `sb.closeAll()` then `sb.assertSettlementMatchesSigned()`.
- **Proof.** `chat-basic` prints `PASSED`. Paste `checks.log`.

## Gotchas

- `chat-basic` sends model-only requests to one seller and never pins. Use routing for pinned paths.
- Cooperative-close `KNOWN` on older sandbox bases: see `../SKILL.md` Gotchas.
- The sandbox loads `dist/`. Rebuild after an edit or the fix looks broken.
- `sb.chat()` drives only `/v1/chat/completions`; `/v1/responses` has no helper.
