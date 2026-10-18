# Channel open and reserve

A buyer's first paid request to a seller opens a payment channel. The buyer signs a ReserveAuth off-chain, the seller calls `reserve()` on AntseedChannels, and part of the buyer's deposit is locked for that channel. The request is served once the channel is active.

## Sub-features

- `reserve-open` opens one channel on the first paid request to a seller.
- `reserve-lock` locks part of the buyer's deposit on-chain while the channel is open.
- `reserve-reuse` serves later requests to the same seller on the same channel.
- `reserve-reopen` opens a new channel after the old one closed.

## How to get to it (user POV)

- Send a chat through the buyer proxy (`POST /v1/chat/completions`) to a model that a paid seller serves.
- Send a chat from the desktop app (see [Desktop chat](./desktop-chat.md)).

## Driving it with pnpm sandbox

Preconditions:

- Baseline preconditions from the [index](./README.md).
- One seller (`topology.sellers: [{ id: 'seller' }]`). The shipped scenario is `payment-flow`.

- **Deposit is free.** Before any chat, call `sb.buyerBalance()`. `available` equals `BigInt(sb.manifest.depositMicros)` and `reserved` is `0n`.
- **First paid chat.** Call `sb.chat({ model: sb.sellers[0].models[0] })`. The reply has content and `usage.total_tokens > 0`.
- **One channel.** Call `(await sb.channels())[seller.id]`. It holds one channel with a `channelId`.
- **Reserve locked.** Call `sb.buyerBalance()` again. `reserved > 0n` and `available + reserved` equals the deposit.
- **Reuse.** Send two more chats and read `sb.channels()`. There is still one channel, and its `requestCount` is 3.
- **Reopen.** Call `sb.stopBuyer()`, wait for the seller's `ChannelSettled` event (`sb.settledEvents(seller.id)`), then call `sb.startBuyer()` and chat again. `sb.channels()` holds one channel with a new `channelId` and `requestCount` 1.
- **Proof.** Run `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs payment-flow --chain local`. `checks.log` shows `PASS reserve is locked on-chain while the channel is open` and `PASS reconnect opened a new channel`.

## Gotchas

- `sb.channels()` returns open channels only. Pass `{ all: true }` to see closed ones.
- The reserve is capped by the buyer's `maxReserveAmountUsdc` (1 USDC in the sandbox), not by the deposit.
- A channel opened on one chain does not exist after the next `up`: every `up` starts a fresh chain and clears the buyer's channel database.
- On `--chain fork` the production contracts are used. A contract change shows up only on `--chain local`.
