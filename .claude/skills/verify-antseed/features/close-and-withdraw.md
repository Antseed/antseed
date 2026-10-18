# Close, settle and withdraw

A channel ends in one of three ways. In a cooperative close the buyer asks the seller to close, and the seller settles the last SpendingAuth and closes on-chain. If the buyer disappears, the seller settles and closes on its own. If the seller disappears, the buyer calls `requestClose()` on-chain and, after the 15-minute grace period, `withdraw()`. Each path must release the whole reserve and charge only what the buyer signed.

## Sub-features

- `close-cooperative` closes on the buyer's request and settles the signed amount.
- `close-on-disconnect` settles and closes from the seller when the buyer goes offline.
- `close-fees` pays the seller the settled amount minus the platform fee.
- `exit-request-close` lets the buyer start a unilateral exit on-chain.
- `exit-withdraw` releases the buyer's reserve after the grace period.

## How to get to it (user POV)

- Cooperative close: `pnpm sandbox down`, the desktop's channel close, or `POST /_antseed/channels/close` on the buyer proxy.
- Settle-on-disconnect: quit the buyer (CLI or desktop) while a channel is open.
- Unilateral exit: a recovery tool or another device sends `requestClose` and later `withdraw` for the buyer's wallet.

## Driving it with pnpm sandbox

Preconditions:

- Baseline preconditions from the [index](./README.md).
- One seller with an open channel (send at least one `sb.chat()` first). The shipped scenario is `payment-flow`.

- **Settle-on-disconnect.** Call `sb.stopBuyer()`. Within 90 seconds `sb.settledEvents(seller.id)` has an event for the channel and `sb.buyerBalance().reserved` is `0n`. The sum of `args.delta` equals the signed `cumulativeSigned`, and the seller's USDC (`sb.usdcBalance(seller.address)`) grew by that sum minus `args.platformFee`.
- **Cooperative close.** After `sb.startBuyer()` and another chat, call `sb.closeAll()`, then `sb.assertSettlementMatchesSigned(await sb.signedBySeller())`. Settlement equals the signed totals and reserves are zero.
- **Unilateral exit.** Read the channel id from `sb.channels()`. Call `sb.stopSeller(seller.id)`, then `sb.buyerRequestClose(channelId)`. Call `sb.warp(15 * 60 + 60)`, then `sb.buyerWithdraw(channelId)`. `sb.channelState(channelId).status` moves away from `1` (Active), and `sb.buyerBalance().reserved` returns to `0n`. No shipped scenario drives this path yet. Write one when you change the exit path.
- **Proof.** Run `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs payment-flow --chain local`. `checks.log` shows `PASS seller settled exactly what the buyer signed before disconnecting` and `KNOWN cooperative close charges exactly the delivered work` (`PASS` after a merge with `origin/main`).

## Gotchas

- **Known defect:** after a cooperative close, one extra request's cost is settled (`payment-flow` sees 36 for one 18 micro-USDC chat). Both `payment-flow` and `chat-basic` record it as `KNOWN`, and `--strict` turns it into a failure. Settle-on-disconnect does not have the defect. The defect is in the sandbox branch's base, not in `origin/main`: on a scratch merged with `origin/main` (4026643ca) both checks print `PASS`.
- The seller settles on disconnect only while it is online. Stop the buyer, not the seller, for that path.
- `withdraw()` fails before the grace period ends. Warp the chain first. Wall-clock waiting does not move Anvil's time.
- `sb.buyerRequestClose()` and `sb.buyerWithdraw()` go on-chain behind the buyer node's back through Anvil impersonation. The buyer node only learns about the closed channel on its next request.
