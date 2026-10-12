---
sidebar_position: 6
slug: /recognized-usage
title: Recognized Usage and ANTS Rewards
hide_title: true
---

# Recognized Usage and ANTS Rewards

**Protocol start: September 10, 2026 at 09:54:21 UTC — epoch 22.**

Recognized usage connects ANTS rewards to paid service delivery and seller-pool
stake. This page describes the protocol from that start date: seller eligibility,
locked staking positions, usage points, and reward distribution. Buyer USDC
deposits, payment channels, and settlement signatures are unchanged.

**Looking for rewards earned before migration?** See
[Legacy emissions and claims](./legacy-emissions.md).

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

The registry's `minSellerPoolStake` is currently 0 on Base mainnet, so any
seller with a bound agent ID is eligible to sell without staking. Stake
determines pool power and rewards, not selling eligibility.

### Moving stake and early withdrawal

Moving stake preserves the full ANTS principal and the original lock and
early-exit terms. Rewards already accrued remain claimable using the old
position ID; future rewards follow the new seller pool when the move takes
effect, normally in the next epoch. Moving does not bypass the lock.

The Base mainnet settings checked on **September 6, 2026** are:

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

These percentages are owner-configurable settings, not immutable guarantees.
Check the pool contract's current values before moving or withdrawing stake.

## Starter positions and seller proxies

Fund `AntseedPositionInit` with ANTS separately. Before global transfers are
enabled, the funding wallet must be a whitelisted sender. Fund conservatively:
the faucet has no owner or sweep function, so unused funds cannot be recovered.

Starter grants require an agent ID registered in **legacy USDC staking** and
legacy stake meeting its minimum: `legacyStaking.getAgentId(seller) != 0` and
`legacyStaking.isStakedAboveMin(seller) == true`. Eligibility through the new
seller registry or ANTS pools alone does not qualify a seller for this grant.

A qualifying seller can call `initPosition()`. For a contract seller, an
authorized operator can call `initPosition(seller)`. When caller and seller
differ, the seller's `isOperator(caller)` must return true. Owning the proxy or
staking DIEM does not by itself satisfy that check.

The caller owns the resulting position, its staking rewards, and withdrawal
rights; the seller's agent pool receives the power. There is one starter grant
per agent. Historical wash flags do not prevent initialization.

All starter positions share the faucet's fixed `initEndEpoch`. Initialization
requires `currentEpoch() + stakeActivationDelay() < initEndEpoch`; at or beyond
that limit, it reverts with `InitExpired`. Claiming later does not extend the
lock's end epoch. The faucet must also hold at least `initAmount` ANTS for each
grant.

With the recognized-usage CLI, use `antseed seller legacy claim-starter`
(or `antseed ants seller claim-starter`) for starter-position initialization. It creates a staking position;
it does not withdraw locked legacy rewards. That separate release is described
in [Locked seller rewards: M002](./legacy-emissions.md#locked-seller-rewards-m002).

## Reward policies

Paid usage does not automatically earn ANTS. The registered points policies
transform buyer and seller points before accounting records them. The historical
wash-trading policy zeros both sides when the seller's finalized proven wash
volume reaches 25% of its authenticated historical total. It does not block USDC
settlement or starter positions, and it does not erase previously recorded points.

See [Reward Policies](./reward-policies.md) for how policies compose, the
wash-trading rule, and how SP1 proofs are anchored to Base history.

## Emissions and destinations

The gate uses weekly epochs and a 104-epoch halving interval. Its genesis is
April 9, 2026 at 09:54:21 UTC. The token's maximum supply remains 1.04 billion ANTS.
Allocation ceilings from epoch 22 are:

- **40% seller-pool rewards**, with the effective share determined dynamically.
- **20% usage rewards**, with dynamic buyer and seller/operator shares.
- **15% team**.
- **15% emissions reserve**.
- **10% verification**.

These are not a promise that every bucket is fully paid to users. Reward
eligibility, pool power, and utilization determine the allocation. Unallocated
reward budgets follow the [burn and reserve rule](#unallocated-emissions-and-burns).

### Stake and usage targets

The dynamic shares tie reward allocation to two measures: ANTS committed to
seller pools and recognized service usage. More active stake increases the
staker allocation; more recognized volume increases the buyer and seller/operator
usage allocations. The unused portion of each reward ceiling follows the burn
and reserve rule rather than being paid out regardless of participation.

The mainnet configuration for epoch 22, checked on **September 7, 2026**, is:

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

The configured destinations are:

- USDC protocol fees and legacy reserve flushes: registry reserve
  `0xBF348D3eEDA2012c60375ebFe4Eb46511859f70F`.
- Team emissions and legacy team flushes: registry team wallet
  `0x47151b68e2f34500A4f8886885cE69b179Bf5B0B`.
- New ANTS reserve emissions: `0x3B4f9f426B9E465621037dF72b6DEBDD8EF1fD8c`.
- Initial verification controller: `0x5B3A59088bD5BD5f722571420c09a9251a03AAdb`.

The verification allocation initially belongs to a wallet, not a deployed
verification contract. Keep gate ownership so its editable controller can later
be transferred to that contract. Enabling ANTS trading is also a separate,
one-way action; M001 does not enable it.

For pre-migration claims and reserve/team flushes, see
[Legacy emissions and claims](./legacy-emissions.md#escrow-and-flushes).

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

## Deployed M001 contracts — Base mainnet {#mainnet-contracts}

These are the Base mainnet contracts activated in epoch 22 on September 10, 2026.
The first 11 were deployed on September 6; the legacy rewards registry adapter
was deployed on September 9. All were verified on Basescan.

| Contract | Address |
|---|---|
| AntseedWashTradingRegistry | `0xc02a111CB94332Cc31C08E079cbe781880b2121C` |
| AntseedEmissionsGate | `0xE60a31E6CD2F8455503cA0B3f6545Dd3DDF543BD` |
| AntseedSellerPools | `0x8Bf4d39AA13F3CB03F87D9500767fBc4D0940652` |
| AntseedSellerRegistry | `0x99c533BCc6Ca646E543dbA835Fdbb9C2ee02Cb60` |
| AntseedPositionInit | `0xB68AD13b681319fcEB6b0A640c2fd96C0138CBc8` |
| AntseedUsageAccounting | `0xAdd2D85316153D7bfaF7921EE9Bf1Bb6c7A1cBc9` |
| AntseedPointsPolicyRegistry | `0x212D2C1058b84507de248a147aaFeB08fb19E3b6` |
| AntseedWashTradingPointsPolicy | `0x7a605aaa3c725aa25012dfDeD6B5dddcC561D6e5` |
| AntseedSellerPoolsRewards | `0x83cc5B9AA0c8cB8683F35462c385a5BAAa755EE5` |
| AntseedUsageRewards | `0x78330bF154172F1137219Bb559d4F3A270B3201F` |
| AntseedLegacyEmissionsEscrow | `0x4d0fC3C0BBb5233Af6c4Ce33223e5330c34db9ab` |
| AntseedLegacyRewardsPoolRegistry | `0xF76590430d9fCe0E871107Aa1f1AE796B0d03a11` |

The [payments address list](./payments.md#base-mainnet-contract-addresses)
contains the settlement contracts. Pre-migration endpoints are listed in the
[legacy guide](./legacy-emissions.md#legacy-contract-addresses).

## SDK configuration

`getChainConfig('base-mainnet').recognizedUsage` exposes the 11 phase-1 addresses
under `contracts`, plus `effectiveEpoch: 22` and the recorded `status: 'active'`.
The adapter's address and provenance are recorded in the activation history and
`current.json`.
This metadata is generated from the deployment ledger, not a live
RPC query. A scheduled epoch passing does not automatically change its status.

`emissionsContractAddress` and `stakingContractAddress` follow the committed
active `current.json`; the gate is not an accounting endpoint. Pool and reward
contracts use their own interfaces; legacy CLI staking commands are not
starter-position initialization commands.

## Deployment and activation

Activation completed through operator transactions on September 10, 2026,
not an automatic timestamp switch. The original mainnet deployment record is
`packages/contracts/deployments/base-mainnet/history/001-recognized-usage-deployed.json`;
the preparation and cutover receipts are recorded in
`packages/contracts/deployments/base-mainnet/history/001-recognized-usage-activated.json`.
For operational sequencing, proof submission, funding, and pointer checks, use
`packages/contracts/script/migrations/M001RecognizedUsage/README.md` in the repository.
