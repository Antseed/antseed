---
sidebar_position: 3
slug: /guides/payments
title: Payments
hide_title: true
---

# Payments

Antseed uses USDC on Base Mainnet for all payments. Buyers pre-deposit USDC, providers earn per request, and everything settles on-chain automatically.

## For Buyers

### Depositing USDC

The recommended way to deposit is `antseed buyer deposit`:

```bash
antseed buyer deposit
```

It prints your node's funding address and a QR code (an EIP-681 payment request any mobile wallet can scan). Send USDC on Base to that address from anywhere — another wallet, an exchange withdrawal, a card on-ramp — and the incoming funds are deposited into your credits automatically: your node signs a gasless authorization and a permissionless relayer submits the transaction for a fixed USDC fee ($0.05 on Base Mainnet). Your node's hot wallet never needs ETH.

Prefer a browser wallet? While watching, the command also serves the connected-wallet checkout page and prints its link (`http://127.0.0.1:3118?token=…`). Open it, connect MetaMask / Coinbase Wallet / Rabby, and the deposit goes straight into the Deposits contract — the command detects the credit and finishes either way.

While `antseed buyer start` is running, this sweeping also happens automatically in the background whenever USDC lands in the hot wallet (disable with `buyer.autoSweep: false` in your config).

| Option | Purpose |
|---|---|
| `--amount <usdc>` | Amount to prefill in the QR payment request and browser checkout |
| `--no-watch` | Print the address and QR code without waiting for funds |
| `--onchain <usdc>` | Direct on-chain deposit from the hot wallet (requires ETH for gas) |

:::tip Third-Party Funding
Anyone can fund a buyer — a team treasury, a hardware wallet, or another contract. The funding source is decoupled from the node identity.
:::

### Sweeping Hot-Wallet USDC Manually

`antseed buyer deposit` and the running buyer sweep incoming USDC for you; `antseed buyer sweep` triggers the same gasless sweep once, on demand:

```bash
antseed buyer sweep
```

The CLI signs an EIP-3009 authorization offline and broadcasts it over the P2P network. A permissionless relayer submits the transaction, pays the gas, and keeps a fixed USDC fee ($0.05 on Base Mainnet); the rest is credited to your deposits balance. If a buyer daemon (`antseed buyer start`) is running, the request goes out over its existing seller connections — otherwise the CLI joins the network with a temporary node.

| Option | Purpose |
|---|---|
| `--amount <usdc>` | Amount to sweep (default: full hot-wallet balance, clamped to your credit-limit headroom) |
| `--timeout <secs>` | How long to wait for on-chain confirmation (default: 120) |

The swept amount must exceed the fixed relay fee, and a first-ever deposit must net at least 1 USDC after the fee. Your funds never move unless a relayer lands the transaction — the authorization simply expires after an hour.

### Checking Balance and Activity

```bash
antseed buyer balance    # wallet + deposits balances
antseed buyer activity   # tokens, spending history, measured savings, active channels
```

`antseed buyer activity` mirrors the desktop app's Activity view: lifetime tokens/spent/saved, a per-day spending chart (`--days 7|30|90`), active channels with their locked amounts and channel IDs, and ANTS emissions available to claim (`antseed buyer emissions claim`). It needs the buyer connection running (`antseed buyer start`).

### Setting an Authorized Wallet

The authorized wallet controls withdrawals, channel recovery, and buyer reward claims. The recommended setup opens a secure localhost page where you connect the external wallet that should receive this authority:

```bash
antseed buyer set-authorized-wallet
```

The buyer identity signs the initial EIP-712 authorization, while the connected wallet submits the transaction and pays Base gas. Pass `--no-open` to print the local URL without launching a browser. To deliberately use the buyer hot wallet for both roles instead, run `antseed buyer set-authorized-wallet --self`; the buyer wallet then needs ETH for gas.

The command does not accept an arbitrary wallet address. Connecting the external wallet proves control and avoids granting withdrawal authority to a mistyped or inaccessible address. Once set, only the current authorized wallet can transfer that authority to another wallet.

### Withdrawing

```bash
antseed buyer withdraw 5
```

The CLI withdrawal command signs with the buyer wallet and therefore works only when that wallet was authorized with `--self`. When an external wallet is authorized, connect that wallet through the AI VPN payments flow to withdraw.

### How Costs Are Calculated

Providers publish per-service pricing in USD per million tokens:

| Rate | Description |
|---|---|
| `inputUsdPerMillion` | Cost per 1M input tokens |
| `cachedInputUsdPerMillion` | Cost per 1M cached input tokens (lower) |
| `outputUsdPerMillion` | Cost per 1M output tokens |

```
requestCost = (freshInput * inputRate + cachedInput * cachedRate + output * outputRate) / 1,000,000
```

USDC has 6 decimal places. All on-chain amounts are in atomic units (1 USDC = 1,000,000).

### Session Budget

Each session starts with a ReserveAuth that locks a budget from your deposit. As you send requests, the budget is consumed. When exhausted, the session settles and a new one starts automatically. This is transparent — you just keep sending requests.

## For Providers

### Earning USDC

Providers earn USDC automatically on each `settle()` or `close()` call. Earnings are paid directly to your wallet address — no claim step needed.

Settlement happens:
- **Periodically** — the node settles after 10 minutes of idle time (configurable via `ANTSEED_SETTLEMENT_IDLE_MS`)
- **On budget exhaustion** — when a session's reserved amount is used up
- **On disconnect** — when a buyer disconnects

### Base RPC Endpoint

Production providers should use a dedicated Base JSON-RPC endpoint so reserve, settle, close, register, and stake calls are not dependent on public RPC rate limits.

```bash
export ANTSEED_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
antseed seller start
```

For a one-off run, use `antseed seller start --base-rpc-url <url>`. For durable config, set `payments.crypto.rpcUrl` in `~/.antseed/config.json`.

### Relaying Deposit Sweeps

Sellers relay buyer deposit sweeps by default: the node verifies and simulates each incoming sweep request, submits it on-chain, and earns the fixed relay fee (minus gas). Opt out with `relayer.enabled: false` in your config, or tune the profitability floor with `relayer.minProfitBaseUnits`.

### Staking and ANTS Rewards {#ants-token-emissions}

**Starting September 10, 2026 at 09:54:21 UTC (epoch 22)**, ANTS rewards use
recognized service usage and locked seller-pool stake. Participants hold
lANTS staking-position NFTs; pool power activates in the following epoch.
Eligible sellers can initialize a starter position, including contract sellers
whose authorized operator initializes on their behalf.

Staking is optional for selling: the seller registry's minimum pool stake is
currently 0, so any registered seller can serve requests. Stake affects ANTS
rewards, not eligibility.

```bash
antseed seller legacy stake 10
```

After the configured network completes the recognized-usage upgrade, the CLI rejects new legacy USDC stakes and directs sellers to ANTS positions instead:

```bash
antseed seller register
antseed seller legacy claim-starter
antseed seller stake 100 --epochs 4
antseed seller pool positions
```

`seller stake` always stakes ANTS and never falls back to USDC. The CLI verifies `AntseedRegistry.emissions()` and `staking()` before commands that depend on the upgrade state. A mismatch between the registry and `payments.crypto` address overrides fails loudly instead of silently selecting the wrong contracts.

After the upgrade, `antseed seller register` explicitly binds your wallet to its on-chain agent identity (ERC-8004); staking requires this registration and never performs it silently. To withdraw your legacy USDC stake:

```bash
antseed seller legacy unstake
```

Rewards depend on eligibility, pool power, usage, and the configured
[reward policies](../protocol/reward-policies.md). USDC payments can still settle
when no usage points are earned. Enabling ANTS transfers is a separate action.

See [Recognized Usage and ANTS Rewards](../protocol/recognized-usage.md) for
starter positions, staking exit terms, emission allocations, and contract addresses.

**Looking for rewards or USDC staking from before migration?** See
[Legacy emissions and claims](../protocol/legacy-emissions.md).

After cutover, `seller rewards` includes finalized legacy, recognized-usage, and pool-staking rewards. Reading rewards does not send transactions; `seller rewards claim` collects all eligible seller rewards into the current wallet. Buyer emissions commands retain their `--legacy-only` and `--new-only` filters.

## Contract Addresses (Base Mainnet)

These are the settlement and accounting endpoints for the protocol starting
**September 10, 2026**. The [full ANTS contract list](../protocol/recognized-usage.md#mainnet-contracts)
includes pools, reward contracts, and starter positions. Historical claims use
[legacy addresses](../protocol/legacy-emissions.md#legacy-contract-addresses).

| Contract | Address |
|---|---|
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| AntseedDeposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| AntseedChannels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| AntseedSellerRegistry | `0x99c533BCc6Ca646E543dbA835Fdbb9C2ee02Cb60` |
| AntseedDepositRelay | `0x34a44542e76f9b4cff3a31902eDF14AbF2C3B3DD` |
| AntseedUsageAccounting | `0xAdd2D85316153D7bfaF7921EE9Bf1Bb6c7A1cBc9` |
| ANTSToken | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |

All contracts verified on [BaseScan](https://basescan.org). For testnet (Base Sepolia), set `payments.crypto.chainId` to `base-sepolia` in your config.

## Timeout Protection

If a provider disappears mid-session, the buyer's funds are not lost:

1. The buyer (or their deposits operator) calls `requestClose()` on AntseedChannels — callable anytime while the channel is active
2. After a 15-minute grace period (so the seller can still submit a final SpendingAuth), the buyer calls `withdraw()` to release remaining locked funds back to their deposit

If the seller is still online, the buyer can instead request a cooperative close and skip the grace period. Desktop and CLI expose both paths.
