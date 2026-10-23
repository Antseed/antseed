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

Stake from the wallet the seller will check: your buyer identity's address, or the wallet set as its operator in `AntseedDeposits`, which is usually the wallet that funds your deposits. The operator's stake only counts once the buyer has paid for usage on-chain. The seller reads both and uses whichever has more power.

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

## One allowance per staker

The seller counts usage on the staked positions, so all buyer addresses behind the same stake share one allowance on that seller. An operator with five buyer wallets and a 5× tier gets 5× the base limit for all of them together, not 5× each. Transferring a position to another wallet moves its used allowance with it. Staked buyers skip the seller's per-IP limit, so users behind a shared IP or a gateway are not cut off by each other.

If the seller can't read the chain, it falls back to the base limits for that request.

Running a seller? See [Staked tiers](/docs/provide/config#staked-tiers) to set or turn off your program.
