---
sidebar_position: 7
slug: /legacy-emissions
title: Legacy Emissions and Claims
hide_title: true
---

# Legacy Emissions and Claims

This reference covers **pre-migration rewards**, before the epoch-22 protocol
start on **September 10, 2026 at 09:54:21 UTC**. For staking positions and rewards
from that start date, see [Recognized Usage and ANTS Rewards](./recognized-usage.md).

Migration does not erase historical points or claims. Legacy V2 continues to
serve those claims after the recognized-usage accounting endpoint takes over.

## Legacy allocation

The pre-migration configuration is:

| Recipient | Share of epoch emissions |
|---|---|
| Sellers | **65%** |
| Buyers | **5%** |
| Protocol reserve | **15%** |
| Team | **15%** |

These values were checked on legacy V2 at Base block **50,956,120** on
September 6, 2026. The old 50% seller / 20% buyer description is not the
pre-migration configuration. Parameters are snapshotted per epoch, so older
epochs must use their recorded values, not today's percentages.

Rewards are proportional to a participant's points within each finalized
epoch. The per-recipient caps are **50% of the seller bucket per seller** and
**5% of the buyer bucket per buyer**; those are caps within a bucket, not its
share of total emissions. Cap overages accumulate for the protocol reserve.

Epochs last one week. Legacy V2 inherits the emission clock and schedule from
V1, with a 104-epoch halving interval on Base mainnet.

## Claiming historical rewards

Sellers call `claimSellerEmissions(epochs[])` on legacy V2 for finalized epochs.
If the seller-unlock policy permits a direct claim, the seller receives ANTS;
otherwise rewards go to the legacy locked-rewards pool.

For buyers, the deposits operator calls `claimBuyerEmissions(buyer, epochs[])`.
The payout goes to that operator. V2 also reads V1's historical points and claim
state for the V1-to-V2 migration epochs, so the later M001 migration does not
require moving or re-creating those points.

Use the legacy contract addresses below for these claims. The recognized-usage
accounting contract is not a replacement claim endpoint for old V2 epochs.

## Locked seller rewards: M002

The M002 migration releases **10% of each eligible seller's cumulative
locked legacy ANTS**, less anything already released. This is 10% of the
seller's locked rewards, not a `10 / 65` adjustment to the legacy seller bucket.
For example, 1,000 ANTS cumulatively locked permits 100 ANTS in total releases;
repeating a claim does not release another 10%. The remainder stays locked.

Sellers proven as wash traders by the configured wash-trading registry, or
flagged manually by the claim-policy owner, receive **zero** from this policy.
This restriction is separate from starter-position initialization, which is
not blocked by historical wash flags.

M002 is a separate deployment after M001 activation. It installs the
legacy seller claim policy and enables the locked-rewards pool to transfer ANTS
before global token transfers are enabled. The September 10 protocol start does
not automatically unlock these rewards. Claims through the pool become
available only after M002 is installed; its default is an immediate
10% entitlement, with release and vesting parameters verified at deployment.

## Escrow and flushes {#escrow-and-flushes}

Since M001 phase 1, V2's registry points to `AntseedLegacyEmissionsEscrow`.
Its existing `mint()` calls now transfer pre-minted ANTS from the escrow;
they do not create additional token supply.

The V2 owner can call:

- `flushReserve()` to pay accumulated reserve ANTS to the main registry's
  `protocolReserve()` address.
- `flushTeam()` to pay accumulated team ANTS to the main registry's
  `teamWallet()` address.

Each flush drains its current nonzero accumulator. These are not one-time
operations: later legacy claims can account additional amounts to flush.
The new emissions-reserve wallet does not replace the legacy reserve-flush
destination. Do not sweep the escrow while legitimate legacy claims remain.

## Legacy USDC staking

Before migration, sellers register their ERC-8004 identity and stake at least
10 USDC through `AntseedStaking`. The legacy CLI calls are:

```bash
antseed seller stake 10
antseed seller unstake
```

These are not ANTS pool-position commands. Following migration, legacy stake
can continue satisfying seller eligibility while the fallback is enabled,
but new usage rewards require seller-pool power. The new seller registry does
not support the old USDC stake/unstake methods; consult the migration runbook
before attempting legacy withdrawals after the registry switch.

## Legacy contract addresses {#legacy-contract-addresses}

| Contract | Base mainnet address |
|---|---|
| AntseedStaking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| AntseedEmissionsV2 | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` |
| AntseedEmissions V1 | `0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5` |
| AntseedSellerRewardsPool | `0xA065C0dE80dbd3d824F7b584E231b76b9fefB261` |
| AntseedLegacyEmissionsEscrow | `0x4d0fC3C0BBb5233Af6c4Ce33223e5330c34db9ab` |

Buyer deposits, Channels, and ANTSToken are shared with the
[recognized-usage protocol](./recognized-usage.md); they are not replaced by migration.
