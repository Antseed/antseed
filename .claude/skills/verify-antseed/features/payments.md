# Payments

A buyer's chats are paid on-chain in testbench USDC: a reserve locks deposit for a channel, each request signs a growing cumulative SpendingAuth, and the seller settles exactly what was delivered when the buyer disconnects.

## Sub-features

- `pay-reserve` locks a reserve on-chain for a new channel.
- `pay-cumulative` grows the signed cumulative amount per request on one channel.
- `pay-settle-disconnect` charges exactly the delivered work and releases the reserve.
- `pay-reconnect` opens a fresh channel after reconnect.
- `pay-onchain` settles on-chain exactly what the buyer signed.
- `pay-issue-*` keeps each fixed payment bug fixed (`e2e/testbench/scenarios/issues/issue-*.mjs`).

## How to get to it (user POV)

- Chat through the proxy or the desktop with a funded testbench buyer; payment runs on its own.

## Driving it with tb

Preconditions:

- `pnpm testbench run payment-flow --chain local`, then every `issue-*` scenario.

- **Paid chats.** Three `tb.chat()` calls. `tb.channels()` shows one channel with rising `cumulativeSigned` (compare as `BigInt`).
- **Disconnect.** `tb.stopBuyer()`. `tb.settledEvents(id)` shows a settle equal to the delivered cost; the reserve is released.
- **Reconnect.** Restart the buyer and chat. A new channel id.
- **Buyer close.** `tb.buyerRequestClose()`, `tb.warp(15 * 60 + 60)`, then `withdraw()`.
- **Proof.** `payment-flow` and each `issue-*` print `PASSED`. Paste `checks.log`.

## Gotchas

- `issue-1200-spendingauth-catchup` needs `tb.faults.loseNeedAuths` armed right before the chat it targets.
- A 5-second delay on a 402 catch-up is the seller's `DEFAULT_CATCH_UP_WAIT_MS`, not a timeout.
- `--chain fork` runs production contracts; a contract change shows only on `--chain local`.
- Waiting in wall time does not move Anvil's clock. Use `tb.warp`.
- `payment:spend` events do not report the negotiator's catch-up. Read `cumulativeSigned`.
