---
slug: /staked-free-tier
title: Staked free tier
description: Lock ANTS in a seller's pool to raise or remove that seller's free-tier rate limit, and read each seller's program from its metadata or Antscan.
---

# Staked free tier

Sellers that offer free models usually cap them, for example 1,000 requests a day per buyer address. If you lock ANTS in a seller's pool, that seller raises your cap or removes it. Your stake also earns pool rewards like any other staking position.

Only stake in **that seller's own pool** counts. Stake in seller A's pool raises your limit on seller A and nowhere else; to raise your limit on seller B, stake in seller B's pool.

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

Sellers sign their limits and tiers into their peer metadata, and every Antseed app shows them next to the seller's free models:

- **Desktop:** on a model's page, a free seller's row shows its limit, for example "1,000 free requests a day". **Stake for more** lists its tiers and opens staking on that seller's pool.
- **Gateway:** in a model's provider list and on a provider's page, the free limit is followed by "stake for more" and an ⓘ with the tiers and a **Stake in this seller's pool** link.

When you run out, the desktop app and the gateway chat say which seller's limit ran out, when it resets and the next tier, with a link to stake in that seller's pool.

Antscan lists every seller that announces a program, with its free services:

```bash
curl https://antscan.co/api/free-tier
curl "https://antscan.co/api/free-tier?seller=0x<sellerAddress>"
```

Each entry has the base limits (`maxRequestsPerAddress`, `maxRequestsPerIp`, `windowMs`), the seller's `onChainAgentId`, and `stakeTiers` with `minPower`, `antsLockedForYear`, `multiplier` and `maxRequests` per window.

When you hit a limit, your buyer returns HTTP 429 with `code: "free_tier_exhausted"` and a `free_tier` object: the seller's `peerId`, `limitedBy`, `limit`, `windowMs`, `retryAfterSeconds`, its `stakeTiers` and your current `stakePower` in that seller's pool. The message names the next tier.

## Stake on a seller

The easiest way is the ANTS dashboard. Connect your wallet there and stake into the seller's pool. The stake links in the desktop app and the gateway open that seller's pool directly:

```bash
antseed ants
```

From the CLI, stake into the seller's agent pool for a number of weeks:

```bash
antseed ants pools                                         # find the seller's agent id
antseed ants stake 10000 --agent <agentId> --epochs 52
```

The new allowance starts once the position activates in the next epoch. Sellers cache stake lookups for up to 10 minutes.

## Share stake with a buyer

Stake held by your buyer identity's own address counts automatically. Stake in any other wallet, yours or someone else's, counts once that wallet signs a code for your buyer address.

**The staker** opens the ANTS dashboard (`antseed ants`, desktop **Rewards → Manage staking**, or the gateway's **Staking** page), goes to **My positions → Share free tier**, enters the buyer address and signs. The signature costs no gas and moves no funds. It names that one buyer address and lasts 30, 90 or 180 days. The dashboard shows a code starting with `antseed-free-tier-` to send to the buyer.

**The buyer** adds the code:

- **CLI:** `antseed buyer free-tier add <code>`. Add `--identity <name>` for a named buyer identity.
- **Desktop:** **Rewards → Staked free tier**. Paste the code and select **Add code**.
- **Gateway:** **Staking → Staked free tier → Add code** (workspace admins). The panel shows the workspace's buyer address to send to the staker.

A running buyer picks the code up within a minute and sends it to sellers with its requests. To renew, the staker signs a new code and the buyer adds it. The new code replaces the old one.

If the staking wallet is on the same machine as the buyer, `antseed buyer free-tier share` opens a local page where that wallet signs, with no code to copy.

Several wallets can share with the same buyer, up to 8. Their stake adds up with the buyer's own, so two wallets with 5,000 ANTS each locked for a year reach the 10,000 ANTS tier together.

```bash
antseed buyer free-tier list               # stakers sharing with this buyer
antseed buyer free-tier remove 0x<staker>  # stop sending one
```

A code names one buyer, so nobody else can use it. Removing it stops your buyer sending it, but a seller that already saw it may keep honouring it until it expires. To end sharing everywhere at once, move or withdraw the stake.

## One allowance per staker

The seller counts usage on the staked positions, so all buyer addresses sharing the same stake share one allowance on that seller. A wallet that shares with five buyers and reaches a 5× tier gives them 5× the base limit together, not 5× each. Transferring a position to another wallet moves its used allowance with it. Staked buyers skip the seller's per-IP limit, so users behind a shared IP or a gateway are not cut off by each other.

If the seller can't read the chain, it falls back to the base limits for that request.

Running a seller? See [Staked tiers](/docs/provide/config#staked-tiers) to set or turn off your program.
