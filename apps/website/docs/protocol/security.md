---
sidebar_position: 7
slug: /security
title: Security
hide_title: true
---

# Security

Antseed separates a buyer's deposit balance from the node wallet. USDC committed
to service payments is held by `AntseedDeposits`; the node signs spending
authorizations. Incoming USDC can be swept from the node wallet into the deposit
contract through a gasless authorization.

## Identity

Each node uses a secp256k1 private key. Its EVM address is the peer identity and
payment-signing identity. A separate wallet can fund the node's deposit or act
as its deposits operator; those roles do not have to share the node key.

| Function | Mechanism |
|---|---|
| **P2P identity** | EIP-191 `personal_sign` with domain tags (`"antseed-data-v1:"`, `"antseed-msg-v1:"`), verified via `ecrecover` |
| **Payment authorization** | EIP-712 signatures (ReserveAuth, SpendingAuth) |
| **PeerId** | EVM address (40 hex chars, no `0x` prefix) |

## Signing Identity vs Funding Wallet

The **signing identity** signs protocol messages and payment authorizations.
Gasless buyer funding can send USDC to this address first, then use a signed
authorization and a permissionless relayer to sweep it into `AntseedDeposits`.
Sellers also use their node wallet for transaction gas and USDC earnings.

An external **funding wallet** can instead approve USDC and call
`deposit(buyer, amount)` directly. Funding a buyer does not automatically make
that wallet the buyer's operator.

The **deposits operator** can withdraw the buyer's available deposit balance.
The buyer authorizes its initial operator with an EIP-712 signature; the current
operator controls subsequent operator transfers. Check `getOperator(buyer)`
rather than assuming the funding wallet has withdrawal authority.

## Key Storage

| Environment | Protection |
|---|---|
| **Desktop app** | Electron `safeStorage` API encrypts the secp256k1 private key at rest using the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). On first launch after upgrade, plaintext `identity.key` is auto-encrypted and the original deleted. |
| **CLI / Server** | Plaintext `identity.key` in the data directory (`~/.antseed/`). Use `ANTSEED_IDENTITY_HEX` env var with a secrets manager for production deployments. |

## Auto vs Manual Approval

Payment signatures can be issued in two modes:

| Mode | Flow | Use Case |
|---|---|---|
| **Auto** | Node receives 402 → signs ReserveAuth internally → sends to seller → seller calls `reserve()` | Server/CLI deployments, unattended operation |
| **Manual** | Node receives 402 → propagates to UI → user reviews and approves → desktop signs with keychain-encrypted key → seller calls `reserve()` | Desktop app, interactive sessions |

Both modes produce identical on-chain outcomes. The difference is whether the signing step requires user interaction. Each ReserveAuth is scoped to a specific seller, capped by `maxAmount`, and expires at `deadline`.

## Risk Bounds

| Scenario | Signing Identity Exposed | Funding Wallet Exposed | Maximum Loss |
|---|---|---|---|
| **Node compromised** | Yes | Not if its key is kept separately | Authorized deposit spending, node-wallet assets, and any roles held by that key |
| **Signing key extracted** | Yes | Not if its key is kept separately | Same exposure as the signing identity |
| **Funding wallet compromised** | Not necessarily | Yes | Wallet assets; available deposits too if it is their operator |
| **Deposits operator compromised** | Not necessarily | Depends on key reuse | Available deposits for accounts it operates |
| **Deposits contract exploit** | N/A | N/A | All deposited funds across all users |

These roles can use the same address, in which case their risks combine. A
separate funding wallet is not exposed merely because it previously funded a
buyer, but shared keys, allowances, and operator permissions must be considered.

## Protocol-Level Controls

All communication happens over an untrusted network. Every trust-critical operation is cryptographically verified:

- **secp256k1 peer identity** — every node has a unique keypair; metadata, connection handshakes, and metering receipts are all signed with EIP-191 `personal_sign`
- **Replay-resistant authentication** — connection envelopes include nonce + timestamp with skew checks
- **Bounded resource usage** — frame sizes, upload caps, stream durations, and concurrent connections are all hard-limited
- **On-chain settlement** — EIP-712 signed ReserveAuth and SpendingAuth with per-seller, per-session, time-bounded authorization

## Buyer-Seller Flow Controls

| Stage | Controls |
|---|---|
| **Discovery** | Signed metadata with freshness checks, topic normalization, private IP filtering |
| **Connection** | EIP-191 signed intro envelopes with nonce replay guard, timestamp skew rejection, per-IP connection cap (10) |
| **Transport** | Frame type and size validation (64 MiB max), fail-closed on decode errors, request and stream timeouts |
| **Upload/Stream** | Per-request cap (32 MiB), global pending cap (256 MiB), upload timeout (120s), bounded stream buffers and configurable duration limits |
| **Metering** | Bilateral EIP-191 signed receipts with running totals, auto-ack enabled by default |
| **Payment** | 402 gating until ReserveAuth is committed on-chain via `reserve()`, bounded by maxAmount and deadline |

## Default Limits

Buyer request and stream defaults are defined in `packages/buyer-core` and the
CLI configuration. They are configurable; upload and connection limits are
separate transport controls.

| Parameter | Default |
|---|---|
| Buyer request timeout | 5 min |
| Max stream buffer | 16 MiB |
| Buyer max stream duration | 30 min |
| Per-upload cap | 32 MiB |
| Global pending upload cap | 256 MiB |
| Upload timeout | 120 s |
| Node metadata fetch timeout | 1.5 s |
| Max inbound connections per IP | 10 |

## Best Practices

1. Keep treasury and operator keys separate from the node where possible. Use `deposit(buyer, amount)` for direct external funding, or the [gasless sweep flow](../guides/payments.md) when funding the node address. Minimize assets left in the hot wallet.
2. Deposit only what you need for a session. Top up as needed rather than pre-loading large amounts into AntseedDeposits.
3. Keep `allowPrivateIPs=false` in production.
4. Keep signature verification and stale metadata rejection enabled (both on by default).
5. Encrypted TCP (`transport.tcp-enc.v1`) is used automatically between peers that advertise it; set `requireSecureTransport` to refuse plaintext/unsigned transports once your peers are upgraded.
6. On servers, use `ANTSEED_IDENTITY_HEX` with a secrets manager instead of storing keys on disk.
7. Back up your secp256k1 private key — it is the only way to recover your PeerId (EVM address) and on-chain wallet.
