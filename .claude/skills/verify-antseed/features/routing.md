# Routing

The buyer picks a seller for each request. A request that names only a model is routed by the buyer's own ranking (`buyer.routingPreferences`) among the sellers that serve it. A request can also pin a seller with `<peerId>@<model>`. In the sandbox the buyer only ever sees the sandbox's own sellers. This file covers the buyer's own routing only. Routing services are out of scope.

## Sub-features

- `routing-isolated` shows the buyer only sandbox sellers.
- `routing-pinned` sends a pinned request to the named seller.
- `routing-auto` serves model-only requests by some sandbox seller.
- `routing-settle` settles each seller's share exactly.

## How to get to it (user POV)

- `GET /v1/models` and `GET /_antseed/peers` on the buyer proxy.
- A chat with `"model": "<model>"` (auto) or `"model": "<peerId>@<model>"` (pinned).

## Driving it with pnpm sandbox

Preconditions:

- Baseline preconditions from the [index](./README.md).
- Two sellers with different mock latency (`topology.sellers: [{ id: 'fast', mock: { latencyMs: 20 } }, { id: 'slow', mock: { latencyMs: 400 } }]`). The shipped scenario is `routing-smoke`.

- **Isolated.** Call `sb.peers()`. Every `peerId` belongs to `sb.sellers`, and the count equals the number of sellers.
- **Pinned.** Call `sb.chat({ model, sellerId: 'fast' })`, then the same with `'slow'`. Each reply contains `seller <id>`.
- **Auto.** Send six chats with only `model`. The `/v1/chat/completions` counts from `sb.mockRequests()` add up to the number of chats sent. Record each seller's share with `sb.metric()`.
- **Settled.** Call `sb.closeAll()`, then `sb.assertSettlementMatchesSigned(await sb.signedBySeller())`.
- **Latency change.** Call `sb.setMockLatency('fast', 2000)` to change a seller's latency during a run.
- **Proof.** Run `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs routing-smoke --chain local`. `checks.log` shows `PASS buyer only sees sandbox sellers` and `PASS every request was served by a sandbox seller`. Compare the `share.<id>` metrics with the previous report for the same scenario.

## Gotchas

- The sandbox sets `minTrustScore` to 0 and `allowedPeerIds` to the sandbox sellers, so trust gating is not exercised.
- Shares across six requests are noisy. Assert where requests went, not a fixed split, unless the change is about the split.
- Routing changes also need the real-network check (`mainnet-smoke`, real USDC). Propose it, and run it only after an explicit yes.
