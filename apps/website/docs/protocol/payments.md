---
slug: /payments
title: Payments and metering
sidebar_label: Payments
description: How buyers pay sellers through USDC payment channels on Base, how usage is metered and signed, and how free usage, top-ups, fees, and deposit sweeps work.
hide_title: true
---

# Payments and metering

Buyers keep a USDC balance in the `AntseedDeposits` contract on Base. To pay a seller, the buyer opens a payment channel in `AntseedChannels` (which holds no USDC itself), then signs a running total after each request. The seller submits the latest signature on-chain to get paid. Zero-priced services use a separate `AntseedFreeUsage` channel that records usage but never moves funds.

Buyers do not need to hold crypto beforehand: deposits can be funded by card or with USDC (see [Funding](/docs/gateway/funding)). Buyers never pay gas; every on-chain step is sent by the seller, the buyer's authorized operator, or a relayer.

| Contract | Role |
|---|---|
| `AntseedDeposits` | Holds buyer USDC, locks it for channels, pays sellers and the protocol fee |
| `AntseedChannels` | Paid channel lifecycle and signature checks; holds no USDC |
| `AntseedFreeUsage` | Zero-price channels with buyer-signed usage records; holds no funds |
| `AntseedDepositRelay` | Gasless sweep of USDC from a buyer wallet into Deposits |

Addresses for every chain are on [Contract addresses](/docs/contracts).

## Channel lifecycle

```text title="reserve → serve → settle"
Buyer                          Seller                         Chain
  │                              │                              │
  ├── ReserveAuth + SpendingAuth>│                              │
  │   (channelId, maxAmount,     ├── reserve(buyerSig) ────────>│
  │    deadline)                 │   Deposits.lockForChannel()  │
  │<── AuthAck ──────────────────┤<──── confirmed ──────────────┤
  │                              │                              │
  ├── HTTP request ─────────────>│                              │
  │<── HTTP response ────────────┤                              │
  │<── NeedAuth (cost, usage) ───┤                              │
  ├── SpendingAuth ─────────────>│  cumulativeAmount,           │
  │      ... N requests          │  metadataHash                │
  │                              │                              │
  │                              ├── settle() or close() ──────>│
  │                              │   Deposits.chargeAndCredit-  │
  │                              │   Payouts()                  │
```

1. On the first request the seller answers HTTP 402 with its terms. The buyer signs a **ReserveAuth** for the channel and an initial **SpendingAuth**.
2. The seller calls `reserve()`, which locks `maxAmount` of the buyer's deposit. A new channel can reserve at most `FIRST_SIGN_CAP` (1 USDC).
3. After each served request the seller reports the request's cost and token usage. The buyer checks it and signs a new SpendingAuth for the higher cumulative total.
4. The seller calls `settle()` to collect the signed amount while keeping the channel open, or `close()` to collect and release the rest of the reservation back to the buyer's available balance.

The wire messages for each step are listed in [Transport](/docs/transport#message-types).

## EIP-712 signatures

Both signed messages share one domain:

```text title="EIP-712 domain"
name:               "AntseedChannels"
version:            "1"
chainId:            <deployment chain>
verifyingContract:  <AntseedChannels address>
```

**ReserveAuth** authorizes a reservation. It is signed when a channel opens and again for every top-up.

| Field | Type | Description |
|---|---|---|
| `channelId` | `bytes32` | `keccak256(abi.encode(buyer, seller, salt))` |
| `maxAmount` | `uint128` | Reservation ceiling in USDC base units (6 decimals) |
| `deadline` | `uint256` | Unix time after which the authorization is invalid |

**SpendingAuth** authorizes cumulative spend on a channel.

| Field | Type | Description |
|---|---|---|
| `channelId` | `bytes32` | The channel |
| `cumulativeAmount` | `uint256` | Total USDC authorized so far; only ever increases |
| `metadataHash` | `bytes32` | `keccak256` of the ABI-encoded usage metadata below |

The contract verifies the buyer's signature over all three fields, so the usage metadata is as binding as the amount.

## How billing works

There are no separate usage receipts. Billing is the seller's report of each request plus the buyer's signed running total.

1. **The seller reports usage.** After a request, the seller sends a NeedAuth message with the request's cost and the usage the upstream provider reported: input, cached input, fresh input, and output tokens, the service name, and, for image and video services, the delivered units.
2. **The buyer verifies.** The buyer parses the usage from the response it received and recomputes the cost from the seller's published prices. It signs only when the seller's claim is within its tolerance of that estimate, and refuses to sign a positive unit count that matches no published price.
3. **The buyer signs.** The new SpendingAuth covers the cumulative amount and the cumulative usage metadata.

Token cost uses the seller's per-service prices in USD per million tokens:

```text title="token cost"
costUSD = (freshInputTokens × inputUsdPerMillion
         + cachedInputTokens × cachedInputUsdPerMillion
         + outputTokens × outputUsdPerMillion) / 1,000,000
```

`cachedInputUsdPerMillion` defaults to `inputUsdPerMillion` when the seller does not set it. Image and video services add a per-unit charge (`output_images`, `video_generations`, or `video_seconds`) from the billing model in their metadata; see [Media billing](/docs/provide/media). Each paid video gets its own one-off channel bound to that request.

### SpendingAuth metadata

The signed metadata is `abi.encode` of these fields (metadata version 4):

| Field | Meaning |
|---|---|
| `version` | Metadata format version (4) |
| `cumulativeInputTokens` | Total input tokens on the channel |
| `cumulativeOutputTokens` | Total output tokens; each delivered image also adds a flat 1,290-token equivalent |
| `cumulativeRequestCount` | Requests served |
| `cumulativeOutputImages` | Images delivered |
| `cumulativeVideoGenerations` | Videos delivered |
| `cumulativeVideoSeconds` | Video seconds delivered |
| `services[]` | Per service (keyed by `keccak256` of the service name): amount, input, cached input, output tokens, requests, images, video generations and seconds |

When a channel settles, the metadata is forwarded to the `AntseedStats` contract, which aggregates token and request counters per seller (see [Reputation](/docs/reputation#on-chain-stats)).

## Top-ups and exhausted channels

A channel's reservation can grow. When the buyer's remaining headroom runs low, it signs a new ReserveAuth with a higher `maxAmount`, and the seller calls `topUp()`. `topUp()` settles the latest SpendingAuth first and succeeds only once the settled amount reaches `TOP_UP_SETTLED_THRESHOLD_BPS` of the current reservation. The source default is 8500 (85%); the value is owner-configurable and is 6500 (65%) on Base mainnet. Until a top-up lands, the seller cannot accept a cumulative amount above the current reservation.

If the buyer has not signed for work already served, the seller answers the next request with HTTP 402 and a PaymentRequired message carrying the cumulative amount needed to catch up. If that amount exceeds the channel's on-chain reservation, the channel is exhausted (`channel_exhausted`) and the buyer opens a new one.

## Closing a channel

| Path | Who calls | What happens |
|---|---|---|
| `settle()` | Seller | Collects the latest signed amount; the channel stays open. Sellers settle after a channel has been idle (10 minutes by default). |
| `close()` | Seller | Final settlement; the unspent reservation returns to the buyer's available balance. Sellers close idle channels after 12 hours by default. |
| Cooperative close | Buyer asks, seller calls `close()` | The buyer sends CloseChannelRequest, optionally with its latest SpendingAuth; the seller closes at the higher of its own and the attached amount. Requires the seller capability `payments.cooperative-close.v1`. |
| `requestClose()` then `withdraw()` | Buyer's authorized operator | For a seller that disappeared. The seller can still settle during a 15-minute grace period; after it, `withdraw()` releases the unsettled reservation. |

From the CLI, see `antseed buyer channels` in the [command reference](/docs/commands).

## Protocol fee

Each settlement charges a protocol fee on the newly settled amount: `fee = delta × PLATFORM_FEE_BPS / 10000`, rounded down in USDC base units. `AntseedDeposits.chargeAndCreditPayouts()` sends the fee to the protocol reserve configured in `AntseedRegistry` and the rest to the seller. If no reserve is configured, the fee is waived.

| Setting | Value |
|---|---|
| `PLATFORM_FEE_BPS` on Base mainnet | 400 (4%) |
| Contract source default | 200 (2%) |
| Maximum the owner can set (`MAX_PLATFORM_FEE_BPS`) | 1000 (10%) |

The fee is owner-configurable up to the maximum; read `PLATFORM_FEE_BPS()` on the Channels contract for the active value.

## Free usage

Services priced at zero use `AntseedFreeUsage` instead of a paid channel. No deposit is needed and no funds move.

1. The buyer signs a `FreeUsageOpen(channelId, deadline)` authorization and sends it to the seller, which calls `open()` on-chain.
2. After each request the seller asks for a usage signature (NeedFreeUsageAuth). The buyer signs `FreeUsageAuth(channelId, sequence, metadataHash, deadline)` over its cumulative token and request counts.
3. The seller periodically submits the latest record with `record()` (every 15 minutes by default) and finally `close()`.

Both signatures use the EIP-712 domain `name: "AntseedFreeUsage"`, `version: "1"`. Free-usage metadata (version 1) carries cumulative input tokens, output tokens, request count, and per-service totals. Sellers can cap free requests per buyer address and per IP over a sliding window (24 hours by default); see [Provider configuration](/docs/provide/config).

## Deposits

`deposit(buyer, amount)` lets any address fund a buyer's balance: USDC is pulled from the caller and credited to the buyer. A team treasury or another contract can fund a node without holding the node's key.

- **Authorized operator.** Each buyer account has an operator, set once by a buyer-signed EIP-712 `SetOperator` message and transferable by the current operator. Only the operator can withdraw available (unreserved) USDC, which is sent to the operator, and only the operator can call `requestClose()` and `withdraw()` on channels.
- **Limits.** The first deposit must be at least `MIN_BUYER_DEPOSIT` (1 USDC). A buyer's balance is capped by a credit limit that grows with the number of distinct sellers paid and days since the first channel, up to `MAX_CREDIT_LIMIT`. The contract source defaults are a 10 USDC base limit and a 50 USDC maximum; both are owner-configurable, and on Base mainnet both are 500 USDC.

All amounts are USDC with 6 decimals (1 USDC = 1,000,000 base units).

### Gasless deposit sweeps

USDC sent to a buyer's own wallet address can be moved into Deposits without the buyer paying gas. The buyer signs one EIP-3009 `receiveWithAuthorization` addressed to `AntseedDepositRelay` and broadcasts it to connected peers (SweepRequest). Any relayer, by default a seller node, submits it; the relay pulls the USDC, credits `amount − FEE` to the buyer's deposit, and pays the fixed `FEE` to the relayer. The fee is immutable in the deployed relay (0.05 USDC on Base mainnet), and the buyer's wallet never receives funds back from the relay.

## Identity and wallet

A node's identity is one secp256k1 key. Its EVM address is both the peer ID and the address that signs ReserveAuth, SpendingAuth, and free-usage records. Protocol messages are signed with EIP-191 `personal_sign` using domain prefixes such as `antseed-msg-v1:`. Key storage and passphrases are covered in [Security](/docs/security#key-storage) and [Wallet keys](/docs/gateway/wallet-keys).

## Supported chains

| Chain | Chain ID | Status |
|---|---|---|
| `base-mainnet` | 8453 | Production (default) |
| `base-sepolia` | 84532 | Testnet |

Contract addresses are built into the CLI for each chain. ANTS rewards are accounted separately from USDC settlement; see [Recognized usage and ANTS rewards](/docs/recognized-usage).
