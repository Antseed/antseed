---
slug: proof-of-prior-delivery
title: "Proof of Prior Delivery"
authors: [antseed]
tags: [protocol, payments, cryptography, proof-of-delivery, reputation, open-network]
description: How Antseed's SpendingAuth signature serves as both payment authorization and cryptographic proof of delivery — building an open, verifiable record of what every seller has delivered.
keywords: [proof of delivery, SpendingAuth, EIP-712, payment protocol, P2P payments, cumulative voucher, payment negotiation, on-chain stats, agentic AI, open network]
image: /og-image.jpg
date: 2026-03-27
---

In peer-to-peer compute markets, proving service delivery is the hard problem. Not routing, not pricing, not discovery — proving that a seller actually delivered what they were paid for, without a trusted intermediary watching the exchange.

Most decentralized compute projects sidestep this. They use self-reported metrics (trivially gameable), trusted validators (re-introducing centralization), or optimistic assumptions with dispute windows (which require honest majorities). These are reasonable tradeoffs, but they're not proofs. They're social mechanisms dressed up as cryptographic ones.

Antseed's answer is the **metadataHash** — a hash of delivery metrics that the buyer signs into every payment authorization. When the seller wants to settle more funds, they must submit a signature that includes this hash. The hash covers what was actually delivered: tokens in, tokens out, average latency, number of requests. The seller can't get paid without presenting proof of what the buyer received. That proof is the `metadataHash`.

<!-- truncate -->

## The metadataHash

Every payment authorization (SpendingAuth) the buyer signs contains three fields:

- **channelId** — the session identifier for this buyer-seller pair
- **cumulativeAmount** — total USDC authorized so far across all requests
- **metadataHash** — `hash(cumulativeInputTokens, cumulativeOutputTokens, averageLatencyMs, requestCount)`

The first two fields handle payment. The third is the proof of prior delivery.

By signing over a hash of cumulative delivery metrics, the buyer cryptographically commits to what they observed. How many tokens went in. How many came out. The average response time. How many requests were served. This isn't self-reported by the seller — it's attested by the buyer, the party who received the service.

When the seller calls `settle()` or `close()` to claim funds, they submit the buyer's latest SpendingAuth. The contract verifies the signature, charges the amount, and unpacks the metadata into the on-chain stats system. The seller cannot settle without a valid buyer signature, and that signature includes delivery metrics. Payment and proof of delivery are inseparable — they're the same signature.

The amount is cumulative and monotonically increasing. After request 1 costs $0.003, the buyer signs `cumulativeAmount = 3000`. After request 2 costs another $0.005, the buyer signs `cumulativeAmount = 8000`. Each signature supersedes the previous one. The seller only needs the latest to claim everything owed — and that latest signature always carries the most up-to-date delivery metrics.

## The Negotiation

Before any of this happens, buyer and seller need to agree on terms. Each side has its own constraints, and the protocol resolves them without a central matchmaker.

### Seller's terms

When a buyer sends a request without an active session, the seller responds with 402 and publishes its requirements:

- **minBudgetPerRequest** — the minimum the seller needs per request (default: $0.01)
- **suggestedAmount** — what the seller recommends for a smooth session (default: $0.10)
- **Per-token pricing** — optionally, the seller publishes input and output token rates so the buyer can estimate costs upfront

### Buyer's limits

The buyer has its own caps, configured by the operator:

- **maxPerRequestUsdc** — the most the buyer will authorize per single request (default: $0.10)
- **maxReserveAmountUsdc** — the total budget ceiling per session (default: $1.00)

### Resolution

The negotiation is simple: if the seller's minimum exceeds the buyer's per-request cap, the buyer rejects. Otherwise, the buyer caps the seller's suggested amount at its own maximum reserve and signs a ReserveAuth to open the session.

This means both sides have veto power. A seller can set a minimum that prices out low-budget buyers. A buyer can cap exposure regardless of what the seller suggests. Neither side can force the other into unfavorable terms. The market clears through open competition — sellers who price too high lose traffic, buyers who cap too low can't access premium services.

## Per-Request Cost Tracking

After each response, the buyer calculates the actual cost. The seller includes token counts and cost in response headers. When those headers are missing — which happens with some upstream providers — the buyer estimates output tokens from the response body size (roughly 4 bytes per token) and calculates cost from the seller's published rates.

The buyer then signs a new SpendingAuth with the updated cumulative amount and metadata, and sends it to the seller before the next request. The seller verifies the signature locally — no on-chain call — and serves the next request.

This creates a rolling bilateral agreement. At any point, the seller holds a single latest SpendingAuth covering all work done so far. If the buyer understates consumption, the seller simply stops serving. If the buyer overstates, they're overpaying — no buyer has an incentive to do this. Honest reporting is the equilibrium.

## Settlement as Proof

When the seller calls `settle()` or `close()` on the AntseedChannels contract, they submit the buyer's latest SpendingAuth signature. The contract:

1. Verifies the buyer's EIP-712 signature
2. Charges the cumulative amount from the buyer's locked deposit
3. Credits the seller's earnings (minus platform fee)
4. Optionally forwards the buyer-signed metadata to `AntseedStats`

Step 4 is the proof path for optional metadata aggregation. The **AntseedStats** contract can contain delivery metrics attested by the buyer's own signature. No oracle reported these numbers. No validator observed them. The buyer signed them because they were there when the service was delivered.

The core counters that accumulate per seller in `AntseedChannels`:

- **Session count** — completed sessions
- **Ghost count** — sessions where the seller disappeared without settling
- **Total volume** — cumulative USDC settled
- **Last settled** — timestamp of most recent settlement

If `AntseedStats` is configured, it can additionally aggregate:

- **Total tokens** — cumulative input and output tokens
- **Total requests** — cumulative requests served

These values are keyed by ERC-8004 agentId. `AntseedStats` accepts writes only from addresses granted its writer role, and the deployed flow grants that role to `AntseedChannels`.

## Budget Exhaustion and Renewal

When the buyer's cumulative spend approaches the session's `maxAmount` ceiling, the seller sends a NeedAuth message indicating how much more authorization is required. The buyer can sign a new ReserveAuth with additional funds, extending the session seamlessly.

If the buyer doesn't top up, the seller finishes the current request and returns 402 on the next one. The buyer's client automatically negotiates a new session — signing a fresh ReserveAuth against their deposit balance.

From the user's perspective, this is invisible. From the protocol's perspective, it creates natural settlement checkpoints. Each settlement can commit metadata to the chain, building the on-chain record incrementally rather than in one shot at session end.

## Timeout Protection

If the seller disappears mid-session, the buyer's funds are locked in a reservation with no one to settle. The protocol handles this with two permissionless functions:

`requestTimeout()` can be called by anyone after the session's deadline passes. After a 15-minute grace period, `withdraw()` releases the locked funds back to the buyer's deposit and records a ghost mark on the seller's stats.

Why a full refund? Because the seller cannot unilaterally prove delivery. Only the buyer's signed SpendingAuth can authorize charges. If the seller had a recent SpendingAuth, they should have settled before the deadline. If they didn't — if you can't prove it, you don't get paid.

## An Open Record for an Open Network

These stats are public, on-chain, and queryable by anyone — not just Antseed clients, but any smart contract, any indexer, any agent framework that reads the chain. And because they're tied to the seller's ERC-8004 identity, they're portable. A seller's track record belongs to their wallet, not to a platform that can revoke it.

This matters most for agentic workflows. When an autonomous agent needs AI services, it can't rely on subjective reviews or curated lists. It needs hard data:

- *Has this seller actually delivered before?* Check session count.
- *How much value has flowed through them?* Check total volume.
- *Do they disappear mid-session?* Check ghost count against session count.
- *What's their typical response time?* Check average latency.
- *Are they still active?* Check last settled timestamp.

An agent can encode its own routing policy on top of these stats. "Only route to sellers with 100+ sessions, ghost rate under 5%, and average latency under 2 seconds." That policy runs against public on-chain data. No API key needed, no platform approval, no trust required.

The quality signal is a byproduct of payment. You don't need to rate your provider — the fact that you paid them and they delivered is the data point. The fact that they ghosted and you got your money back is equally informative. Every settlement adds signal, and over time the stats converge on a clear picture of each seller's reliability.

## Why This Matters

The `metadataHash` is what closes the loop between payment and accountability. Without it, settlement would just prove that money moved. With it, settlement proves what was delivered — and that proof is signed by the buyer, not claimed by the seller.

No separate reporting system. No oracles. No dispute games. The seller presents the buyer's signed `metadataHash` to get paid, the delivery record writes itself, and an open network of verifiable stats emerges from the payments themselves.
