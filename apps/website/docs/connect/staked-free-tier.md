---
slug: /staked-free-tier
title: Staked free tier
description: Lock ANTS in a seller's pool to raise or remove that seller's free-tier rate limit, and read each seller's program from its metadata or Antscan.
---

# Staked free tier

Sellers that offer free models usually cap them, for example 1,000 requests a day per buyer address. If you lock ANTS in a seller's pool, that seller raises your cap or removes it. Your stake also earns pool rewards like any other staking position.

## Default program

Each seller sets its own program. Sellers that don't change it use this default:

| Staking power | ≈ ANTS locked for one year | Free allowance |
|---|---|---|
| Below 520,000 | Below 10,000 | The seller's base limit |
| 520,000 | 10,000 | 5× the base limit |
| 2,600,000 | 50,000 | 20× the base limit |
| 10,400,000 | 200,000 | Unlimited |

**Staking power** is ANTS × epochs of lock remaining, where one epoch is one week. 10,000 ANTS locked for 52 weeks has 520,000 power; 20,000 ANTS locked for 26 weeks has the same. Power is what the seller pool already uses for rewards, so the rules follow from the staking contract:

- A new position has no power until it activates in the next epoch.
- Power shrinks every week as the lock runs down. Extend the lock or enable max lock (a constant 104 epochs of power) to keep your tier.
- Withdrawing before the lock ends burns part of the principal.

## Check a seller's program

Sellers sign their limits and tiers into their peer metadata. Antscan lists every seller that announces one, with its free services:

```bash
curl https://antscan.co/api/free-tier
curl "https://antscan.co/api/free-tier?seller=0x<sellerAddress>"
```

Each entry has the base limits (`maxRequestsPerAddress`, `maxRequestsPerIp`, `windowMs`), the seller's `onChainAgentId`, and `stakeTiers` with `minPower`, `antsLockedForYear`, `multiplier` and `maxRequests` per window.

When you hit a limit, the seller answers HTTP 429 with `code: "free_tier_exhausted"`. A seller with staked tiers adds `stakeTiers` and your current `stakePower` to the response.

## Stake on a seller

The easiest way is the ANTS dashboard. Connect your wallet there and stake into the seller's pool:

```bash
antseed ants
```

From the CLI, stake into the seller's agent pool for a number of weeks:

```bash
antseed ants pools                                         # find the seller's agent id
antseed ants stake 10000 --agent <agentId> --epochs 52
```

The new allowance starts once the position activates in the next epoch. Sellers cache stake lookups for up to 10 minutes.

## Share stake with your buyer

Stake held by your buyer identity's own address counts automatically. Stake in any other wallet, such as the wallet that funds your deposits, counts once that wallet signs consent to share it with your buyer:

```bash
antseed buyer free-tier share
```

This opens a local page. Connect the staking wallet and sign. The signature costs no gas and moves no funds; it names your buyer address and lasts 90 days. Sign again to renew. Your buyer sends it to sellers with its requests, and a running buyer picks it up within a minute. Use `--identity <name>` to share with a named buyer identity, such as a gateway workspace.

Several wallets can share with the same buyer, up to 8. Their stake adds up with the buyer's own, so two wallets with 5,000 ANTS each locked for a year reach the 10,000 ANTS tier together.

```bash
antseed buyer free-tier list               # stakers sharing with this buyer
antseed buyer free-tier remove 0x<staker>  # stop sending one
```

A signature names one buyer, so nobody else can reuse it. Removing it stops your buyer sending it, but a seller that already saw it may keep honouring it until it expires. To end sharing everywhere at once, move or withdraw the stake.

## One allowance per staker

The seller counts usage on the staked positions, so all buyer addresses sharing the same stake share one allowance on that seller. A wallet that shares with five buyers and reaches a 5× tier gives them 5× the base limit together, not 5× each. Transferring a position to another wallet moves its used allowance with it. Staked buyers skip the seller's per-IP limit, so users behind a shared IP or a gateway are not cut off by each other.

If the seller can't read the chain, it falls back to the base limits for that request.

Running a seller? See [Staked tiers](/docs/provide/config#staked-tiers) to set or turn off your program.
