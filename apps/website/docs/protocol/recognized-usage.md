---
slug: /recognized-usage
title: Recognized usage and ANTS rewards
sidebar_label: Recognized usage
description: How seller pools, recognized-usage points, and the emissions schedule turn paid service delivery into ANTS rewards.
hide_title: true
---

# Recognized usage and ANTS rewards

Recognized usage connects ANTS rewards to paid service delivery and seller-pool stake. It has been active on Base mainnet since epoch 22. This page covers seller eligibility, locked staking positions, usage points, and how rewards are allocated. Buyer USDC deposits, payment channels, and settlement signatures are described in [Payments](/docs/payments) and are independent of rewards. For how-to steps, see [Staking and rewards](/docs/provide/staking). For rewards earned before epoch 22, see [Legacy emissions](/docs/legacy-emissions).

:::note
The numeric settings on this page are the current Base mainnet configuration. They are owner-configurable; read the contracts listed on [Contract addresses](/docs/contracts) before relying on them.
:::

## Seller pools and recognized usage

Recognized usage requires an eligible seller pool with sufficient epoch power.
Accounting applies the registered points policies and tracks buyer/seller
points and pool-weighted points. A missing pool or filtered record earns no
new usage points; this does not prevent the underlying USDC settlement.

`AntseedSellerPools` holds locked ANTS positions represented by lANTS NFTs.
Staking power activates in the following epoch. Initialize or seed seller pools
before an epoch boundary to have power in that epoch.
Legacy USDC staking remains an eligibility fallback until explicitly disabled;
the new seller registry does not expose the legacy USDC withdrawal flow.

The seller registry's `minSellerPoolStake` is 0 on Base mainnet, so any
seller with a bound agent ID is eligible to sell without staking. Stake
determines pool power and rewards, not selling eligibility.

### Moving stake and early withdrawal

Moving stake preserves the full ANTS principal and the original lock and
early-exit terms. Rewards already accrued remain claimable using the old
position ID; future rewards follow the new seller pool when the move takes
effect, normally in the next epoch. Moving does not bypass the lock.

The Base mainnet settings are:

- **Move-weight penalty: 0%** (`moveWeightPenaltyBps = 0`). If configured above
  zero, this penalty reduces the moved position's future staking weight, not
  its principal or already-accrued rewards.
- **Maximum early-withdrawal slash: 50%** (`maxSlashBps = 5000`).
- **Minimum early-withdrawal slash: 5%** (`minEarlyExitSlashBps = 500`).

Before the lock ends, the principal penalty is:

```text
slash percentage = max(5%, min(50%, 50% × remaining lock epochs / total lock epochs))
```

For example, withdrawing 1,000 ANTS halfway through the lock slashes 250 ANTS
and returns 750 ANTS. The calculation uses whole epochs, with integer rounding
in the contract. **At or after lock expiry, the slash is zero.** Withdrawal
does not slash previously earned rewards, but it removes the position's power
from the withdrawal epoch onward.

The slashed ANTS is sent to `0x000000000000000000000000000000000000dEaD`,
not to the team or reserve. This principal burn is separate from the epoch
emission burn described below and does not consume its 30% cap.

These percentages are owner-configurable. Check the pool contract's current values before moving or withdrawing stake.

## Starter positions

`AntseedPositionInit` grants one starter staking position per agent to sellers that were staked in **legacy USDC staking** (`legacyStaking.getAgentId(seller) != 0` and `legacyStaking.isStakedAboveMin(seller)`). Eligibility through the new seller registry or ANTS pools alone does not qualify. A contract seller's authorized operator can initialize on its behalf; the caller owns the resulting position, its staking rewards, and withdrawal rights, while the seller's pool receives the power. All starter positions share one fixed end epoch, and initialization reverts with `InitExpired` once `currentEpoch() + stakeActivationDelay()` reaches it.

Use `antseed seller legacy claim-starter` (or `antseed ants seller claim-starter`). It creates a staking position; it does not release locked legacy rewards, which is described in [Legacy emissions](/docs/legacy-emissions#locked-seller-rewards-m002).

## Reward policies

Paid usage does not automatically earn ANTS. The registered points policies
transform buyer and seller points before accounting records them. The historical
wash-trading policy zeros both sides when the seller's finalized proven wash
volume reaches 25% of its authenticated historical total. It does not block USDC
settlement or starter positions, and it does not erase previously recorded points.

See [Reward policies](/docs/reward-policies) for how policies compose, the
wash-trading rule, and how SP1 proofs are anchored to Base history.

## Emissions and destinations

The emissions gate uses weekly epochs, an initial emission of 5 million ANTS per epoch, and a 104-epoch halving interval, counted from its genesis (epoch 0 began April 9, 2026 at 09:54:21 UTC). The token's maximum supply is 1.04 billion ANTS. Allocation ceilings are:

- **40% seller-pool rewards**, with the effective share determined dynamically.
- **20% usage rewards**, with dynamic buyer and seller/operator shares.
- **15% team**.
- **15% emissions reserve**.
- **10% verification**.

These are not a promise that every bucket is fully paid to users. Reward
eligibility, pool power, and utilization determine the allocation. Unallocated
reward budgets follow the [burn and reserve rule](#unallocated-emissions-and-burns).

### Referral and client buckets

Two further reward controllers split their own epoch buckets by attributed
usage, read from `AntseedAttributionUsage`:

- **Referrals** (`AntseedReferrals`): a referred buyer's recognized usage after
  its invite binds is credited to its inviter and, for 12 epochs, to the buyer
  too, so the two split that buyer's share. See the
  [referrals guide](../provide/referrals.md).
- **Clients** (`AntseedClientRewards`): usage is credited to the ERC-8004 agent
  of the client software that produced it, and paid to that agent's owner.

Each controller pays nothing until it is registered as an emissions-gate
minter. Both buckets come out of the 10% verification bucket: once they are
registered, it becomes 4% verification, 4% clients and 2% referrals, from the
next epoch. The other allocations do not change. The design is
in AIP-6 ([proposal](https://github.com/Antseed/AIPs/pull/12)).

### Stake and usage targets

The dynamic shares tie reward allocation to two measures: ANTS committed to
seller pools and recognized service usage. More active stake increases the
staker allocation; more recognized volume increases the buyer and seller/operator
usage allocations. The unused portion of each reward ceiling follows the burn
and reserve rule rather than being paid out regardless of participation.

The Base mainnet configuration is:

- **Stake target: 400 million active ANTS across the network.** The staker share
  rises from a 2% baseline toward a 40% ceiling. The input is active staked
  principal, not lock-duration-weighted pool power. Pool power and recognized
  usage determine how allocated rewards are distributed.
- **Usage target: 1 million USDC of recognized volume per weekly epoch.** Buyer
  and seller/operator shares each rise from a 5% baseline toward a 10% ceiling.
  This is a network-wide epoch measure, not a per-seller or lifetime target.

For a positive input, each share follows the same curve:

```text
share = minimum + (maximum - minimum) × input / (input + target)
```

A zero input gives a zero share. At the target, the share is halfway between
its minimum and maximum—not at the maximum:

- At **400 million active ANTS**, the staker share is **21%** of epoch emissions.
- At **1 million USDC recognized volume**, buyer and seller/operator shares are
  **7.5% each**, or **15% combined**.

These are allocation shares, not an individual staker's yield or a guaranteed
payment. A reward side with no qualifying weighted usage has no claimant and
its budget becomes remainder. The targets are not minimum requirements for
participating; allocation increases smoothly as the inputs grow.

The usage input is the larger of the epoch's total buyer points and total seller
points, after points policies. With the deployed pass-through/wash-filter
behavior, it represents recognized USDC volume without counting buyer and seller
sides twice. It is not all raw Channels volume, and a different points modifier
can change how it relates to USDC.

The effective stake target scales with scheduled emissions:
`400 million ANTS × epoch emission / initial emission`. At the initial 5 million
ANTS per epoch, it is 400 million; after the first emission halving, it is
200 million under the same configuration. The usage target does not automatically
halve. Epoch-specific settings are available through `dynamicStakerConfigAt(epoch)`
and `dynamicUsageConfigAt(epoch)` on the reward contracts.

### Destinations

USDC protocol fees go to the protocol reserve configured in AntseedRegistry. Team emissions go to the registry's team wallet, reserve emissions to the emissions reserve, and the verification allocation to its controller. See [Contract addresses](/docs/contracts) for the protocol reserve. For pre-migration claims and reserve and team flushes, see [Legacy emissions](/docs/legacy-emissions#escrow-and-flushes).

### Unallocated emissions and burns

Seller-pool and usage rewards have dynamic budgets. The portion of their
allocation ceilings that is not allocated to rewards becomes an epoch remainder.
A reward side with no qualifying weighted usage also has no allocation. This is
different from rewards that someone has earned but has not claimed yet: those
are not swept into the remainder simply because they are unclaimed.

The gate routes settled remainders as follows:

- **Burn first, up to 30% of the epoch's total scheduled emissions.** This is one
  shared cap across remainder claims, not 30% per pool or 30% of each remainder.
- **Send any excess to the emissions reserve**, in addition to its regular
  allocation.

For example, if an epoch schedules 1,000 ANTS and has 400 ANTS of combined
unallocated rewards, settling those remainders burns 300 ANTS and sends 100 ANTS
to the emissions reserve. If the remainder is only 100 ANTS, all 100 is burned;
30% is a ceiling, not a guaranteed burn every epoch.

Settlement is explicit: after the epoch ends, anyone can call
`settleEpochRemainder(epoch)` on each reward controller with a remainder. An epoch
ending does not itself execute a burn transaction. The gate's
`epochBurnedAmount(epoch)` records the emission amount burned for that epoch;
remainder-settlement events report both the burned and reserve amounts.

Emission burns are implemented by minting the remainder to
`0x000000000000000000000000000000000000dEaD`. Early-withdrawal burns instead
transfer already-staked ANTS there. Neither path calls the token's ERC-20 burn
operation or reduces `totalSupply()`; the dead-address balance should not be
treated as circulating rewards.

## Contracts

The recognized-usage contracts (emissions gate, seller registry, seller pools, usage accounting, points policies, reward controllers, position init, and the legacy emissions escrow) are listed on [Contract addresses](/docs/contracts). SDK users can read them from `getChainConfig('base-mainnet').recognizedUsage`.
