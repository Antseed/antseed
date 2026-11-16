---
slug: the-402-flow
title: "The 402 Flow"
authors: [antseed]
tags: [protocol, payments, P2P, decentralized payments]
description: How Antseed uses HTTP 402 to trigger fully decentralized payment negotiation — no gateway, no facilitator, just peers settling directly.
keywords: [HTTP 402, payment negotiation, P2P payments, decentralized payments, EIP-712, cumulative streaming payments, x402, MPP]
image: /og-image.jpg
date: 2026-03-27
---

HTTP 402 Payment Required has been in the HTTP spec since 1997 — "reserved for future use." For nearly three decades, no one agreed on what the payment payload should look like, how the negotiation should work, or who should facilitate it. That changed recently. Coinbase shipped x402, Stripe and Tempo launched the Machine Payments Protocol (MPP), and several smaller projects have proposed their own 402 conventions.

All of these give 402 a mechanism. They differ in architecture — specifically, in who sits between buyer and seller, and whether that intermediary is required.

Antseed uses 402 as the trigger for fully decentralized payment negotiation between peers. No payment gateway, no relay, no facilitator. The entire flow — from the initial 402 response to the on-chain reserve to the retried request — happens over the same peer connection that carries the actual AI traffic.

<!-- truncate -->

## The Trigger

A buyer connects to a seller peer and sends a request. If no payment session exists for this buyer-seller pair, the seller responds with HTTP 402 and a payment requirements message containing the terms:

```json
{
  "sellerEvmAddr": "0x...",
  "minBudgetPerRequest": "10000",
  "suggestedAmount": "100000"
}
```

`minBudgetPerRequest` is the minimum the seller needs per request. `suggestedAmount` is what the seller recommends for uninterrupted service. Optionally, the seller includes per-token pricing (`inputUsdPerMillion`, `cachedInputUsdPerMillion`, `outputUsdPerMillion`) so the buyer can estimate costs before committing.

This message rides the same connection as every other message in the protocol. The request ID ties the payment requirement back to the original request, so the buyer knows exactly which call triggered the negotiation.

## Two Signatures, One Session

This is the core of the design. Antseed uses two distinct EIP-712 signatures to separate the concerns of *reserving funds* and *authorizing spend*:

### ReserveAuth — the budget ceiling

When a buyer agrees to the seller's terms, it signs a **ReserveAuth** — a one-time EIP-712 signature that sets the budget ceiling for the session:

- **channelId** — a deterministic identifier for this buyer-seller pair
- **maxAmount** — the total USDC the seller is allowed to draw
- **deadline** — when the authorization expires

The buyer sends this signature to the seller, who submits it on-chain by calling `reserve()` on the AntseedChannels contract. This locks `maxAmount` of the buyer's deposited USDC for this specific seller. The transaction confirms on Base L2 in 2-3 seconds. Once confirmed, the seller sends an acknowledgment and the buyer retries the original request.

This is the only on-chain transaction in the entire flow. Everything after this is off-chain.

### SpendingAuth — cumulative authorization

On every request, the buyer signs a **SpendingAuth** — a lightweight EIP-712 signature that authorizes a *cumulative* spend amount:

- **channelId** — same channel as the ReserveAuth
- **cumulativeAmount** — total USDC authorized so far (monotonically increasing)
- **metadataHash** — a hash of cumulative delivery metrics (tokens processed, latency, request count)

The key insight is *cumulative*. The buyer doesn't authorize each request individually. Instead, each SpendingAuth says "I authorize you to keep up to X total from everything you've served me so far." The amount only goes up. The seller verifies the signature locally — no on-chain call needed — and serves the request.

The `metadataHash` ties each authorization to actual delivery. It's a hash of what was delivered (token counts, latency, number of requests), creating a cryptographic link between payment and service. This is what makes on-chain reputation possible — settlement carries proof of what was actually delivered.

```
Buyer                              Seller                       Deposits Contract
  │                                  │                             │
  │  [deposit USDC — once]           │                             │
  │─── deposit() ──────────────────────────────────────────────────>│
  │                                  │                             │
  ├── Request ──────────────────────>│                             │
  │<── 402 + PaymentRequired ────────┤                             │
  │                                  │                             │
  │  [sign ReserveAuth]              │                             │
  │  [sign SpendingAuth #1]          │                             │
  │                                  │                             │
  ├── ReserveAuth + SpendingAuth ───>│                             │
  │                                  ├── reserve() ───────────────>│
  │                                  │   [locks from deposit]      │
  │                                  │<── confirmed ───────────────┤
  │<── Acknowledged ─────────────────┤                             │
  │                                  │                             │
  ├── Request (retry) ──────────────>│  [serves normally]          │
  │<── Response ─────────────────────┤                             │
  │                                  │                             │
  ├── Request + SpendingAuth #2 ────>│  [verify sig, serve]        │
  │<── Response ─────────────────────┤                             │
  │                                  │                             │
  ├── Request + SpendingAuth #3 ────>│  [verify sig, serve]        │
  │<── Response ─────────────────────┤                             │
```

The buyer's only on-chain transaction is the initial deposit — which funds all future sessions with any seller. Opening a session is the seller's transaction, locking funds from the buyer's existing balance. After that, unlimited requests with off-chain signature verification. The seller settles on-chain when the session ends — calling `settle()` or `close()` with the buyer's latest SpendingAuth signature.

## Same Connection, Zero Overhead

Here's something x402 and MPP can't do: payment negotiation on the same transport as the actual traffic, with no additional infrastructure.

Antseed peers are already connected over an encrypted peer-to-peer connection for proxying AI requests and responses. The payment flow — 402 trigger, ReserveAuth, SpendingAuth, acknowledgments — rides that same connection. The protocol multiplexes payment messages alongside proxy traffic using a frame-level type byte. Payment messages are just another message type on an open connection.

This means there is no payment service to deploy. No WebSocket sidecar for payment negotiation. No HTTP callbacks to a facilitator. No second connection to establish. When a buyer hits a 402, the entire negotiation — signing, sending the authorization, waiting for the on-chain reserve, receiving the acknowledgment, retrying the request — happens on the connection that's already open.

The transport cost of payment negotiation is literally zero. The only added latency is the on-chain `reserve()` confirmation (2-3 seconds on Base), paid once per session. After that, SpendingAuth signatures flow alongside proxy traffic as just another message on the mux. A streaming AI response might produce dozens of response chunks interleaved with a SpendingAuth — the mux handles this naturally.

x402 requires an HTTP round-trip to a facilitator for every paid request. MPP requires communication with Stripe's infrastructure. Antseed requires nothing beyond the peer connection you already have.

## Running Out of Budget

When the buyer's cumulative spend approaches the `maxAmount` ceiling, the seller sends a NeedAuth message indicating how much more authorization is required. The buyer can sign a new ReserveAuth with additional funds, extending the session without interruption. If the buyer doesn't top up, the seller finishes the current request but will 402 the next one.

## Auto and Manual Mode

**Auto mode** handles everything internally. The buyer node checks its on-chain deposit balance, signs both ReserveAuth and SpendingAuth using its embedded wallet, and retries the request. The application never sees the 402 — it just gets a response, slightly delayed on the first request while the on-chain reserve confirms.

**Manual mode** lets the user approve spending explicitly. The 402 and payment terms propagate to the application. In the desktop app, the user sees an approval card showing the seller's address, pricing, and suggested amount. On approval, the app signs the authorization using the user's wallet and attaches it to the retry request. The node extracts it before proxying — from the seller's perspective, the flow is identical.

Both modes produce the same EIP-712 signatures, go through the same payment channel, and result in the same on-chain `reserve()` call. The seller doesn't know or care which mode the buyer is using.

## Comparison to x402 and MPP

Three protocols now give HTTP 402 a concrete mechanism. They solve different problems with different architectural tradeoffs.

### x402 (Coinbase)

x402 introduces a facilitator between buyer and seller. The buyer constructs a payment payload and sends it with the request. The seller forwards it to a facilitator (Coinbase, or a third-party implementation) for verification and settlement.

This is practical for adding payments to existing HTTP APIs — the facilitator abstracts away blockchain complexity. The tradeoff is the intermediary itself: it holds transient custody during settlement, must remain available for every paid request, and represents a single point of failure. For a P2P network with no central operator, it's a structural mismatch.

### MPP (Stripe + Tempo)

The Machine Payments Protocol uses pre-authorized sessions — similar to Antseed's ReserveAuth in spirit, and a direct inspiration for our design. The buyer pre-authorizes a spending limit, and individual requests settle automatically against that session. MPP is chain-agnostic and settlement is batched, amortizing on-chain costs across requests.

Antseed builds on this foundation with two additions. First, the funding model: in MPP, the buyer executes an on-chain transaction to fund each new session. In Antseed, the buyer deposits USDC once into a deposits contract, and every session after that draws from that balance — the *seller* calls `reserve()` using the buyer's signed authorization, so the buyer never needs to send another transaction. This matters for machine-to-machine payments where the buyer is an agent, not a human clicking "approve" in a wallet.

Second, what settlement proves. MPP confirms that money moved. Antseed's SpendingAuth carries a `metadataHash` — a hash of cumulative delivery metrics — so settlement simultaneously proves *what was delivered* and *what was paid*.

### Antseed

No facilitator, no per-session buyer transaction. The buyer deposits USDC once. The seller calls `reserve()` using the buyer's signed authorization — locking funds from the existing deposit. After that, every request is just a local signature check. Settlement happens when the session ends, carrying cumulative delivery metrics on-chain.

| | **x402** | **MPP** | **Antseed** |
|---|---|---|---|
| Intermediary | Facilitator (Coinbase) | Stripe + Tempo | None (smart contract only) |
| Payment transport | HTTP headers + facilitator round-trip | HTTP headers + Stripe/Tempo API | Same encrypted connection as traffic |
| Buyer transaction to open session | Per-request | Per-session | None (seller reserves from buyer's deposit) |
| On-chain settlement | 1 tx per request | Batched (amortized) | Batched (amortized) |
| Session model | Per-request | Pre-authorized session | ReserveAuth ceiling + cumulative SpendingAuth |
| Chain dependency | Multi-chain | Chain-agnostic | Any EVM chain with USDC |
| Proof of delivery | None | None | Built-in (metadataHash in SpendingAuth) |

Both MPP and Antseed amortize on-chain costs by batching settlement — individual requests are authorized off-chain, and the cumulative result settles on-chain. The architectural distinctions are in the other rows. The deposit model means the buyer never needs to be online for a wallet transaction — critical for autonomous agents that consume AI services without human intervention. The multiplexed transport means no additional infrastructure. And the `metadataHash` in every SpendingAuth creates a cryptographic link between payment and delivery, enabling on-chain reputation to emerge directly from settlement without a separate reporting system.

## Why This Matters

Payment negotiation adds zero infrastructure overhead. There's no payment service to deploy, no WebSocket server to maintain, no message broker to scale. Payment flows over the same peer connection as everything else.

When a buyer connects to a new seller for the first time, the 402 flow adds a one-time 2-3 second delay for the on-chain reserve. Every subsequent request is served at full speed with only a local signature verification — sub-millisecond.

HTTP 402 now has competing mechanisms. x402 adds a facilitator. MPP pioneered the pre-authorized session model that inspired our design. Antseed builds on that with deposit-based funding, multiplexed transport, and delivery proof baked into every signature.
