# 402 catch-up

When a seller has delivered more than the buyer has signed, it answers the next request with `402 payment_required` and `requiredCumulativeAmount` set to its delivered spend, and it sends a cost-free NeedAuth with the same target. The buyer signs a catch-up SpendingAuth for exactly that target, and the request is retried and served. Issue #1200: the buyer's 402 negotiator signed at least the previous amount plus the seller's `minBudgetPerRequest` (0.5 USDC by default), so the seller could settle work it never delivered.

## Sub-features

- `catchup-402` makes the seller answer `402` with `requiredCumulativeAmount` equal to its delivered spend.
- `catchup-needauth` catches the buyer up through the seller's cost-free NeedAuth.
- `catchup-negotiator` catches the buyer up through the 402 negotiator (`extendCurrentSpendingAuth`) when that NeedAuth does not arrive.
- `catchup-exact` signs exactly the seller's target, so settle-on-disconnect charges exactly the delivered work.

## How to get to it (user POV)

- A user keeps chatting after the buyer under-signed a request: a NeedAuth was lost, or the buyer rejected a cost claim. The user sees a slower reply (observed: about 5 seconds), not an error.

## Driving it with pnpm sandbox

Preconditions:

- Baseline preconditions from the [index](./README.md).
- One seller. The scenario is `issue-1200-spendingauth-catchup`, with `requires: ['buyerControl', 'mockControl']`.

- **Chat 1, signed in full.** Call `sb.chat({ model })` and wait until `cumulativeSigned` reaches `cost`. It equals `cost` exactly.
- **Chat 2, under-signed.** Call `sb.faults.loseNeedAuths(1)`, then `sb.chat()`. `sb.faults.lostNeedAuths()` holds one payload with `lastRequestCost` set and `requiredCumulativeAmount` = `2 * cost`. `cumulativeSigned` stays at `cost`.
- **Chat 3, the 402 catch-up.** Call `sb.faults.loseNeedAuths(1)`, then `sb.chat()`. The second lost payload has no `lastRequestCost` and `requiredCumulativeAmount` = `2 * cost`. The chat still answers, about 5 seconds slower than the others (observed, not a configured timeout). With the NeedAuth lost, only the negotiator can have signed the catch-up.
- **Signed equals delivered.** Wait until `cumulativeSigned` reaches `3 * cost`. It equals `3 * cost`. On unfixed code it is `cost + 500000`.
- **Settled equals delivered.** Call `sb.stopBuyer()` and wait for the seller's `ChannelSettled` event for that `channelId` with `reserved` back at `0n`. The sum of `args.delta` equals `3 * cost`. Then call `sb.startBuyer()` so teardown can close cleanly.
- **Proof.** Run `.claude/skills/verify-antseed/scripts/run-with-evidence.mjs issue-1200-spendingauth-catchup --chain local`. Unfixed code fails on `buyer signed exactly the delivered work after the catch-up` with `"signed":"500018","delivered":"54"`. Fixed code passes every check.

## Gotchas

- **The fault, and why it exists.** No public path leaves a buyer under-signed, and the cost-free NeedAuth usually wins the race against the negotiator. Without a fault the negotiator path does not run, so the scenario would pass on buggy code. The sandbox therefore exposes one fault, `POST /faults/buyer/need-auth-loss {count}` (`sb.faults.loseNeedAuths`). It wraps the buyer payment manager's public `handleNeedAuth` and drops the next `count` frames, as a lost frame would. Considered and rejected:
  - the buyer's `costToleranceMultiplier`, which is not in the node's payment config and could only be set through the private `_config`;
  - seller pricing or `minBudgetPerRequest`, which no topology knob sets and which cannot make the buyer under-sign;
  - a lower buyer `maxPerRequestUsdc`, which the sandbox fixes at 5 USDC and which caps signing at the verified cost plus that limit, so each delivered request is still signed in full.
- Arm the fault right before the chat it targets, then wait for `lostNeedAuths()` to return the dropped frame before you read `cumulativeSigned`. Arming clears the list, and every buyer start (`sb.startBuyer()`, a new `up`) disarms the fault. A count left armed within one buyer session drops the next request's billing NeedAuth.
- The scenario first checks that the sandbox is fresh (no chats, no open channel). On a reused sandbox, earlier NeedAuth frames and spend would make its checks meaningless.
- Losing a NeedAuth leaves the buyer under-signed because, observed on this base, nothing else signs after a proxied response: the buyer's own post-response signing (`sendPostResponseAuth`) does not run on that path. If that changes, chat 2 will be signed in full and the first check will say so.
- `payment:spend` events do not report the negotiator's catch-up on this sandbox base, so the scenario reads `cumulativeSigned`, not spend events.
- Check the signed amount before settlement and record the settled amount in the same `detail`. On unfixed code the seller really settles the over-signed amount (500018 for 54 delivered).
