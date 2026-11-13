---
title: Seller payments
slug: /provide/payments
sidebar_label: Payments
description: How a seller gets paid in USDC on Base, when it settles, what gas it pays, and how to check earnings and claim rewards.
---

# Seller payments

You are paid in USDC on Base, straight to your seller wallet. Your node handles the whole payment flow: there are no invoices and no claim step for USDC. This page covers what happens from the seller's side. The protocol itself (channels, signatures, fees, free usage) is described in [Payments](/docs/payments), and how buyers add funds is covered in [Funding](/docs/gateway/funding).

## How a buyer pays you

1. The buyer signs a spending limit for a payment channel with you. Your node calls `reserve()` on the Channels contract, which locks that amount from the buyer's deposit.
2. For each request, the buyer signs an updated running total of what it owes you. Your node checks it before serving.
3. When the channel's budget runs low, your node calls `topUp()` with the latest total, which settles what is owed so far and raises the limit.
4. Your node calls `settle()` or `close()` with the latest total. The contract transfers the amount owed, minus the protocol fee (4% on Base mainnet; see [Payments](/docs/payments#protocol-fee)), from the buyer's deposit to your wallet.

Free requests are not paid, but your node records them on-chain so buyers earn usage credit. See [Seller configuration](/docs/provide/config#free-usage-records) for how often that happens.

## When your node settles

| Trigger | What happens |
|---|---|
| Buyer disconnects | The channel is closed right away and the full amount owed is settled. |
| Channel idle | After `ANTSEED_SETTLEMENT_IDLE_MS` without activity (default 10 minutes), the node settles what is owed, skipping amounts below `payments.minSettleDelta` (default $0.002) so gas doesn't exceed the payment. |
| Budget running low | The node tops up the channel, settling the current total in the same transaction. |

If a buyer has already asked the contract to close a channel, your node stops serving it, because work served after the buyer's grace period may never be collectible. `payments.serveWhileClosePending` overrides this; leave it off unless you understand the risk.

## Gas

Your seller wallet pays the Base gas for `reserve`, `topUp`, `settle`, `close` and free-usage records. Keep some ETH in it. While the balance is below `seller.gasCheck.minBalanceEth` (default 0.00005 ETH), the seller stops advertising so buyers aren't sent to a node that can't settle, and it resumes on its own once you fund it. The startup log prints the effective settings.

On Base mainnet the seller tops itself up before it gets there. When the wallet holds less than 0.0005 ETH, it swaps 10 USDC of its earnings for ETH on Uniswap and pays that swap's gas in ETH, at most 30 USDC in any 24 hours. The swap needs a little ETH, so a wallet that is already empty still needs ETH sent to it once. Change the amounts or turn it off with `antseed seller settings set --refuel off` (or `--refuel-below`, `--refuel-usdc`, `--refuel-max-day`), the dashboard's **Settings → Checks**, or `seller.gasRefuel` in the config. Each refuel is logged in the seller's events, and a failed one sends an alert.

By default your node also relays buyers' gasless deposit sweeps: it submits the sweep on-chain, pays the gas, and keeps the fixed relay fee. Turn this off with `relayer.enabled: false`, or set a minimum profit with `relayer.minProfitBaseUnits`. See [Seller configuration](/docs/provide/config#payment-settings).

## Check your earnings

```bash
antseed seller status
```

This shows earnings and tokens for today, active channels, connected peers, your wallet address, and your on-chain registration and stake. Add `--json` for scripts.

For dashboards and alerts, export delivered, settled and authorized USDC, channel counts and request totals with the [Prometheus exporter](/docs/provide/metrics).

## Using your USDC

Settled USDC sits in your seller wallet as ordinary USDC on Base. Nothing needs to be withdrawn from a contract. To move it, use any wallet that holds your seller identity key.

## ANTS rewards

ANTS rewards are separate from USDC earnings. They depend on recognized usage, pool stake and [reward policies](/docs/reward-policies). View and claim them with:

```bash
antseed seller rewards
antseed seller rewards claim
```

`seller rewards` only reads; `seller rewards claim` collects every eligible seller reward into your wallet. Staking and the ANTS dashboard are covered in [Staking](/docs/provide/staking), and the reward mechanics in [ANTS rewards](/docs/recognized-usage). Rewards from before the recognized-usage upgrade are claimed as described in [Legacy emissions](/docs/legacy-emissions).

Contract addresses are listed on [Contracts](/docs/contracts).
