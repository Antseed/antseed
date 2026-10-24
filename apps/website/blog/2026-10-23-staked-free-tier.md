---
slug: staked-free-tier
title: "Stake ANTS, Lift the Free-Tier Limit"
authors: [antseed]
tags: [ANTS, staking, free models, providers]
description: "Buyers who lock ANTS in a seller's pool get a larger free allowance, or none at all. Providers who offer free models now get stake behind them in return."
keywords: [Antseed free tier, free AI models, ANTS staking, rate limits, seller pools]
date: 2026-10-23
---

Free models on Antseed come with rate limits. A provider pays real money to serve every free request, so most cap each buyer, for example at 1,000 requests a day. Until now, nothing came back to the provider for that cost, and buyers who wanted more had no way to ask for it.

Starting with this release, buyers can lock ANTS in a seller's pool to raise that seller's free limit or remove it.

<!-- truncate -->

## How it works

Every seller with a free tier now announces a staked program next to its base limits. The default:

| ANTS locked for one year | Free allowance |
|---|---|
| None | The seller's base limit |
| 10,000 | 5× |
| 50,000 | 20× |
| 200,000 | Unlimited |

Tiers are measured in **staking power**: ANTS × weeks of lock remaining. Locking 20,000 ANTS for six months reaches the same tier as 10,000 for a year. Power starts when the position activates in the next epoch and shrinks as the lock runs down, so the larger allowance goes to buyers who commit for longer.

Only stake in that seller's own pool counts: stake with one provider raises your free limit there, not on every provider.

Each seller can change its tiers, set its own multipliers or turn the program off. The program is signed into the seller's peer metadata. The desktop app and the gateway show it next to each free model ("1,000 free requests a day · stake for more"), and [Antscan](https://antscan.co/api/free-tier) lists every seller's limits, tiers and free models. When you run out, the app tells you which seller's limit ran out, when it resets and what the next tier takes, with a link straight to that seller's pool.

## Why providers offer free models now

Stake in a seller's pool raises that pool's weight, and pool weight multiplies the ANTS rewards the seller earns from its paid usage. A buyer who stakes for free access is backing the provider's paid business too.

That gives providers a reason to serve free models: free users who stake bring pool weight with them, and they are already using the provider's service when they need a paid model. Offering free plus paid models now works as one product.

## Why buyers stake

Free access is one reason. The stake is also a normal seller-pool position: it earns staker rewards, and it is your ANTS. Withdrawing before the lock ends burns part of the principal, as with any position.

## One allowance per staker

Stake in your buyer's own address counts automatically. Stake in another wallet, such as the one that funds your deposits, counts once that wallet signs a code for your buyer in the ANTS dashboard: one signature, no gas, valid for up to 180 days. The buyer pastes the code into the CLI, the desktop app or the gateway. Several wallets can share with the same buyer and their stake adds up. Usage is counted on the staked positions, so every buyer sharing the same stake shares one allowance, and moving a position to another wallet doesn't reset it. Staked buyers also skip the per-IP limit, which matters for teams behind one office network or gateway.

## Get started

- **Buyers:** pick a free model's seller in the desktop app or the gateway (or on [Antscan](https://antscan.co/api/free-tier)), stake into that seller's pool from the ANTS dashboard (`antseed ants`), and if the stake is in another wallet, add the code it signs with `antseed buyer free-tier add <code>`, in desktop Rewards or on the gateway's Staking page. See [Staked free tier](/docs/staked-free-tier).
- **Providers:** staked tiers are on by default whenever you set `seller.freeTier`. See [Staked tiers](/docs/provide/config#staked-tiers) to change them.
