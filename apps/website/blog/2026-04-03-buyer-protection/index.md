---
slug: buyer-protection
title: "Buyer Protection Without a Middleman"
authors: [antseed]
tags: [protocol, payments, security, P2P, buyer-protection]
description: How Antseed protects buyers during active AI sessions — overdraft control, independent cost verification, reserve ceilings, and a guaranteed on-chain escape hatch — without any intermediary.
keywords: [buyer protection, overdraft control, cost verification, EIP-712, SpendingAuth, P2P payments, payment channels, streaming payments, escrow, smart contract]
image: /og-image.jpg
date: 2099-01-01
draft: true
---

When you use an AI API, you swipe a card and trust the provider to charge you fairly. If they overcharge, you dispute it. There's a payment processor, a support team, terms of service, and ultimately a legal system behind every transaction.

On a P2P network, none of that exists. The buyer is paying a stranger — no brand, no support department, no recourse beyond the protocol itself. If the seller overcharges, there's no one to call. If the seller disappears mid-session, there's no one to refund you. The protocol has to make cheating unprofitable and recovery automatic.

Antseed's buyer protection is built in eight layers. Each one addresses a specific attack or failure mode. Together, they ensure the buyer never risks more than it can afford, never pays more than it can verify, and can always get unspent funds back — without trusting the seller or any intermediary.

<!-- truncate -->

## The Trust Problem

Here's the fundamental tension in paying for AI per-token: the buyer doesn't know the real cost.

The buyer sends a prompt and receives a response. Somewhere behind the seller's node, a model ran — consuming input tokens and generating output tokens. The seller knows the exact count (it ran the model). The buyer only sees the response bytes.

If the buyer blindly trusts the seller's reported cost, the seller can inflate it. Claim 10,000 output tokens when the model only generated 5,000. The buyer can't tell — it would need the exact tokenizer and model to verify.

If the buyer refuses to pay until it can independently verify, the seller won't serve the next request. No rational seller gives away compute for free.

The protocol needs a system where the buyer pays enough to keep the session alive but never more than it can independently justify — and where overcharging naturally stalls the session rather than draining the buyer.

## Layer 1: Never Sign More Than You Can Verify

The buyer maintains its own running tally of what the seller has delivered. After every response, it estimates the token count from the raw bytes it received — not from the seller's report. This estimate becomes the buyer's **verified cost**.

The trick is in what the buyer is willing to sign. Each payment authorization (SpendingAuth) is capped at:

```
maxSignable = verifiedCost + maxPerRequestUsdc
```

The `maxPerRequestUsdc` is the buyer's overdraft limit — how much unverified exposure it tolerates per request. It defaults to $0.50. This means the buyer is always willing to advance one request's worth of credit beyond what it has independently confirmed. Enough for the seller to serve the next request. Not enough to drain the buyer.

How does the buyer estimate tokens without a tokenizer? It doesn't need one. It uses a heuristic: split the response text on word boundaries and punctuation, apply a language-aware characters-per-token ratio (6 for English, 3 for German, individual counting for CJK), and sum the segments. This isn't a BPE tokenizer — there's no vocabulary lookup, no model-specific encoding. But it gets within roughly 5% of actual token counts for typical LLM traffic, and the buyer computes it entirely from bytes it received. The seller can't manipulate it.

If the seller inflates costs, the buyer's verified cost falls behind the seller's claimed cumulative. The gap grows until the overdraft ceiling blocks further authorization. The session stalls naturally — no dispute mechanism needed, no third party involved. The math does the enforcement.

## Layer 2: Cap What the Seller Claims

The seller reports its cost per response via HTTP headers: `x-antseed-cost`, `x-antseed-input-tokens`, `x-antseed-output-tokens`. The buyer reads these — but doesn't trust them blindly.

Before accepting the seller's claimed cost, the buyer compares it against its own estimate. If the seller's claim exceeds **1.4 times** the buyer's independent estimate, the buyer caps the accepted cost at the tolerance boundary:

```
acceptedCost = min(sellerClaim, 1.4 * buyerEstimate)
```

Why 1.4x and not exact? Because the buyer's heuristic estimation isn't perfect. Different tokenizers produce different counts, JSON formatting adds overhead that's hard to estimate from outside, and prompt templates vary. A 40% margin is generous enough to accommodate legitimate differences while catching sellers who claim 2x or 3x the real cost.

A consistently dishonest seller sees its authorized cumulative fall further and further behind its claimed cumulative. Eventually it hits the overdraft ceiling and the buyer won't authorize more — the session ends naturally.

## Layer 3: Limit What's at Stake Per Session

Every session has a hard budget ceiling. When the buyer opens a payment channel, it signs a ReserveAuth that locks a fixed amount of deposited USDC for that specific seller. By default, this is $5.00.

This is the absolute worst case for a single session. Even if the overdraft model had a bug, even if the tolerance cap had an edge case, the on-chain reserve limits total exposure. The seller's `reserve()` call on the smart contract locks exactly this amount — the contract won't allow more.

For long sessions that need more budget, the buyer proactively signs a new ReserveAuth when its cumulative authorized spend reaches 85% of the ceiling. The seller then calls `topUp()` on-chain to extend the channel. But the contract has its own gate: `topUp()` only succeeds if the seller has already settled at least 85% of the current locked amount on-chain — meaning the seller must have submitted a SpendingAuth proving it delivered enough to justify the increase. These are two separate 85% checks: the client-side trigger ensures the buyer signs in time, the contract-side precondition ensures the seller has actually earned what it claims before more funds are locked.

## Layer 4: Separate the Keys

The node's hot wallet — the secp256k1 key that lives on the machine — signs payment authorizations. But it can't withdraw funds, close channels, or claim token emissions. Those operations require a different key: the **authorized operator**.

The operator is a separate address that the hot wallet authorizes once via an EIP-712 signature. It can be a hardware wallet, a multisig, or any address the buyer controls. Once set, only the operator can:

- Withdraw deposited USDC
- Initiate channel closure
- Execute withdrawals after the grace period
- Transfer operator authority to a new address
- Claim ANTS token emissions

Funds always flow to the operator, never to the hot wallet. If the hot wallet is compromised, the attacker can sign SpendingAuths — but those are bounded by the overdraft model and the reserve ceiling. They can't extract money from the deposit balance. They can't redirect earnings. The signing key and the withdrawal key are cryptographically unrelated.

This matters most for autonomous agents. An AI agent running unattended on a server signs authorizations from its hot wallet. The funding wallet — possibly a Ledger in a drawer — deposited USDC once and doesn't need to stay connected. If the server is compromised, the maximum loss is the current reserve ceiling per active session. The funding wallet is untouched.

## Layer 5: Guaranteed Fund Recovery

If a seller stops responding, refuses to settle, or disappears entirely, the buyer's funds aren't stuck. The recovery path is mechanical — it requires no cooperation from the seller, no arbitration, and no third party.

The operator calls `requestClose(channelId)` on the AntseedChannels contract. This starts a 15-minute grace period during which the seller can submit the latest SpendingAuth to settle earned revenue. After the grace period, the operator calls `withdraw(channelId)`, and all unreserved funds are released back to the buyer's available balance.

```
Operator                      AntseedChannels       AntseedDeposits
(hardware wallet / multisig)        |                     |
     |                              |                     |
     |-- requestClose(channelId) -->|                     |
     |                              |  grace: 15min       |
     |     [seller can settle]      |                     |
     |                              |                     |
     |  ... 15 minutes pass ...     |                     |
     |                              |                     |
     |-- withdraw(channelId) ------>|                     |
     |                              |-- releaseLock() --->|
     |                              |  [reserved -> avail]|
     |                              |                     |
     |-- withdraw(buyer, amount) ------------------------>|
     |                              |  [USDC -> operator] |
```

Why a grace period? Without it, a buyer could close a channel and reclaim funds the seller legitimately earned — the seller served requests, signed proofs, but hasn't settled yet. Fifteen minutes is enough for the seller's node to submit the final SpendingAuth, but short enough that a buyer isn't waiting days for a disappeared seller.

The seller has strong incentive to settle promptly: if `requestClose()` fires and the seller doesn't settle within the grace period, it forfeits all unsettled revenue. The seller's node automatically attempts `close()` on buyer disconnect and retries periodically.

## Layer 6: Human in the Loop (Optional)

For buyers who want explicit control over every payment — institutional deployments, high-value tasks, or cautious operators — manual approval mode returns every 402 to the application layer. The buyer's node doesn't auto-sign anything.

The application receives the seller's terms: address, pricing, suggested amount. It can present an approval card, check an internal policy, or require human confirmation. On approval, the application signs the SpendingAuth externally and attaches it to the retry request via the `x-antseed-spending-auth` header. The node extracts the pre-signed authorization before proxying — from the seller's perspective, the flow is identical to auto mode. Same EIP-712 signatures, same on-chain `reserve()` call, same settlement.

Auto mode is the default. It handles everything internally using the caps described above — the application never sees the 402, just gets a slightly delayed response on the first request while the on-chain reserve confirms. Manual mode exists for cases where the overdraft limits aren't sufficient assurance and a human needs to approve.

## Layer 7: Crash Recovery

The buyer persists all active channel state to SQLite: channel ID, cumulative amount signed, token counts, request count. If the node crashes mid-session:

- Cumulative amounts are restored — the buyer won't sign a lower amount (monotonicity preserved)
- `verifiedCost` resets to zero — intentionally conservative

The zero-reset is a deliberate design choice. On restart, the buyer treats all previous spending as unverified. It might temporarily sign slightly less than it would have (the overdraft headroom is measured from zero, not from the pre-crash verified cost). But it will never sign more than the overdraft ceiling allows. The system is safe by default, even through unclean shutdowns.

## Layer 8: Avoid Bad Sellers Automatically

When a seller fails — timeout, connection drop, server error — the buyer doesn't just retry. It removes that peer from consideration and avoids it on future requests, with three mechanisms at increasing scope:

**Per-request.** Within a single request, the buyer retries up to 3 times across different sellers. Each failed peer is excluded from subsequent attempts in the same request.

**Cache eviction.** On failure, the peer is removed from the buyer's cached peer list entirely. It won't be considered for any request until the next DHT discovery scan — and only if the peer is still announcing itself on the network.

**Router cooldown.** The router tracks consecutive failures per peer. After 3 consecutive failures, the peer enters an exponential backoff cooldown. Even if re-discovered via DHT, the router skips it until the cooldown expires. A single success resets the counter.

The effect is progressive: a seller that fails once loses the current request. A seller that fails repeatedly loses all traffic for increasing periods. A seller with a track record of failures ranks below every honest peer in routing — on-chain channel counts, latency history, and reputation scores all factor into peer selection. Bad sellers effectively blacklist themselves.

## How It All Fits Together

Each layer addresses a different attack or failure mode:

| Layer | What could go wrong | How it's bounded |
|-------|-------------------|-----------------|
| Overdraft model | Seller inflates per-request cost | Buyer's verified estimate + $0.50 |
| Tolerance capping | Seller claims 3x actual tokens | Capped at 1.4x buyer's estimate |
| Reserve ceiling | Session drains entire deposit | $5.00 hard cap per session |
| Key separation | Hot wallet compromised | Signing key can't withdraw funds |
| On-chain escape | Seller disappears with locked funds | 15-minute mechanical recovery |
| Manual approval | Agent signs without human consent | Opt-in human-in-the-loop |
| Crash recovery | Node dies mid-session | SQLite persistence + conservative restart |
| Peer eviction | Seller repeatedly fails | Exponential backoff, automatic deprioritization |

These layers are independent — each works without the others. A buyer with only the overdraft model is already protected against cost inflation. Add the reserve ceiling and the on-chain escape hatch, and worst-case exposure drops to $5.00 per session with guaranteed 15-minute recovery. Add key separation, and a compromised node can't drain the deposit.

Together, they mean: the buyer's maximum exposure in any session is the reserve ceiling. The maximum unverified exposure per request is $0.50. Recovery from any failure takes at most 15 minutes. And the seller has every incentive to be honest — inflated costs trigger tolerance capping, unreliable service triggers eviction, and unsettled channels expire.

No trust in the seller. No intermediary enforcing rules. The buyer's own node enforces the overdraft model. The smart contract enforces the reserve and escape hatch. The protocol makes honesty the profitable strategy and cheating a dead end.

For more on the wallet architecture — how the signing key, the operator, and the funding wallet relate — see [Separation of Risk](/blog/separation-of-risk). For how the payment negotiation works end-to-end, see [The 402 Flow](/blog/the-402-flow).
