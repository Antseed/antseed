---
slug: separation-of-risk
title: "Separation of Risk"
authors: [antseed]
tags: [security, wallet-architecture, P2P, key-management]
description: How Antseed separates the signing key from real funds — the hot wallet never touches money, and the funding wallet never touches the node.
keywords: [wallet security, signing identity, funding wallet, EIP-712, session keys, P2P payments, key management, hot wallet]
image: /og-image.jpg
date: 2026-03-27
---

Any P2P network with on-chain payments faces the same tradeoff: either run a hot wallet with real funds so your node can transact autonomously, or introduce custodial key management and hope the operator doesn't disappear. Both options have well-understood failure modes. Hot wallets get drained. Custodians get hacked, or worse, rug.

Antseed sidesteps this entirely. The key that runs on your node never touches real funds. The wallet that holds your money never touches the node. They are cryptographically unrelated. Compromising one does not compromise the other.

<!-- truncate -->

## The Hot Wallet Is Just a Signing Key

Every Antseed node has a derived EVM keypair — its "hot wallet." But calling it a wallet is misleading, because it never holds funds. It exists for one purpose: signing EIP-712 payment authorizations.

When the node receives a 402 Payment Required response from a seller, the hot wallet signs a ReserveAuth (authorizing a session budget) and a SpendingAuth (authorizing cumulative spend per request). That's it. It cannot transfer tokens. It cannot call arbitrary contracts. It cannot withdraw funds. The only thing the hot wallet's signatures can do is authorize a specific seller to draw from a pre-funded deposit balance — within strict caps.

Those caps are tight:

- **Per-request**: each SpendingAuth increment is capped at $0.10 by default
- **Per-session**: each ReserveAuth is capped at $1.00 by default
- **Per-seller**: each authorization is scoped to a single seller address
- **Time-bounded**: each authorization expires at a specific deadline
- **Monotonic**: cumulative amounts can only go up — replaying old signatures is useless

Even if an attacker steals the hot wallet's private key, the worst they can do is sign authorizations against the existing deposit balance in $0.10 increments. They cannot exceed the deposit. They cannot access the funding wallet. They cannot change the caps.

## The Funding Wallet Never Touches the Node

The funding wallet is completely separate. It can be a hardware wallet, a multisig, a smart contract wallet — anything the user controls. It interacts with the AntseedDeposits contract by calling `depositFor(hotWalletAddress, amount)`, which credits the hot wallet's deposit balance with USDC.

After that, the funding wallet has no further role. It doesn't need to stay connected. It doesn't need to approve transactions. It doesn't even need to be the same wallet every time — anyone can call `depositFor()` to fund a buyer's account.

The deposit balance itself has a credit limit that starts at $50 and grows based on usage history — how many sellers the buyer has transacted with, how long they've been active, how much feedback they've received. The hard cap is $500. This means even if the hot wallet's deposit balance is fully compromised, the maximum loss is bounded by the credit limit — not by the funding wallet's total holdings.

```
Funding Wallet                     AntseedDeposits              Hot Wallet (Node)
(Ledger, Safe, any wallet)         (on-chain custody)           (signing key only)
       │                                  │                           │
       │── depositFor(hotWallet, $50) ───>│                           │
       │   [USDC transferred]             │                           │
       │                                  │  balance: $50             │
       │                                  │                           │
       │   [funding wallet disconnects]   │                           │
       │                                  │                           │
       │                                  │<── ReserveAuth sig ───────┤
       │                                  │    [locks $1 for seller]  │
       │                                  │                           │
       │                                  │<── SpendingAuth sig ──────┤
       │                                  │    [authorizes $0.10]     │
       │                                  │                           │
       │                                  │  balance: $49             │
       │                                  │  reserved: $1             │
```

The funding wallet is offline after depositing. The hot wallet signs authorizations but never moves money. The deposits contract enforces the limits. Three independent components, each with a narrow responsibility.

## Why This Matters More Than You'd Think

In most P2P payment networks, the node key *is* the wallet. If you want unattended operation — an AI agent that pays for compute without human approval — you need to fund that key. The more you fund it, the more useful it is. The more you fund it, the more you lose when it's compromised.

Antseed breaks this coupling. The hot wallet is useful at zero balance — it just needs a deposit credited to it. An operator can fund $20 into the deposit, let the agent run for weeks, and top up when the balance gets low. The funding wallet's private key sits on a Ledger in a drawer. The agent's signing key runs on an EC2 instance. If the instance is compromised, the attacker gets access to at most $20 (or whatever the current deposit balance is). The Ledger is untouched.

For sellers, the separation works similarly. The seller's hot wallet signs metering receipts and calls `reserve()` on-chain. Earned revenue accumulates in the AntseedDeposits contract as seller earnings — claimable to any address the seller specifies, not automatically to the hot wallet. A compromised seller node cannot redirect earnings to an attacker's address.

## Under the Hood: One Key, One Identity

Every Antseed node has a single secp256k1 private key. The corresponding EVM address is the node's PeerId on the network and its on-chain signing identity. There is no derivation step and no two-key system.

This one key signs everything: peer authentication handshakes (EIP-191 `personal_sign` with domain tags), metadata announcements, metering receipts, and EIP-712 payment messages (ReserveAuth, SpendingAuth). Verification always uses `ecrecover` to confirm the signer matches the expected EVM address.

One key, one identity, one address across P2P and on-chain. But it never holds funds — that's what the funding wallet and AntseedDeposits are for.

### Desktop Key Storage

The desktop app encrypts the secp256k1 private key at rest using Electron's `safeStorage` API, which delegates to the OS keychain — macOS Keychain, Windows Credential Manager, or Linux libsecret. The key is decrypted into memory only when needed for signing operations.

The funding wallet never touches the application. A user can deposit into AntseedDeposits from a Ledger, a Trezor, a Safe multisig, or any other wallet. The deposit is a standard ERC-20 approval + `depositFor()` call that can be executed from any interface. The application has no knowledge of the funding wallet's private key and no mechanism to request it.

## Comparison with Existing Approaches

**Hot wallets** — the common approach in decentralized networks. A single key holds funds and signs transactions. Node compromise means full fund exposure. Operators mitigate by keeping balances low, but this requires constant manual rebalancing.

**Custodial solutions** — a third party manages keys on behalf of the operator. Solves the hot wallet problem by introducing a trust dependency. The custodian becomes a single point of failure.

**ERC-4337 session keys** — the closest parallel. Session keys delegate limited transaction authority from a smart contract wallet. Antseed's hot wallet serves a similar function but is purpose-built for metered AI payments: each authorization is scoped to a specific seller, capped at a specific amount, and includes delivery metadata. The key difference is that Antseed's hot wallet is not a delegate of the funding wallet — there is no on-chain delegation relationship between them. The funding wallet deposits on the hot wallet's behalf, but the hot wallet cannot initiate transactions from the funding wallet under any circumstances.

## The Bottom Line

The hot wallet is a signing key. It authorizes spend from a pre-funded deposit, within caps, for specific sellers, with expiration. It never holds funds, never moves tokens, never touches the funding wallet.

The funding wallet deposits money and walks away. It can be cold storage. It can be a multisig requiring 3-of-5 signatures. It doesn't matter — the node never needs it after the deposit.

This is what makes unattended AI agents practical on a P2P payment network. The agent signs authorizations autonomously. The human funds the deposit when they choose to. Compromise of the agent costs the deposit balance. Compromise of the deposit balance doesn't touch the funding wallet.
