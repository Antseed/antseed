# M002 — Legacy seller claims

One broadcast, two signers, run only after M001 is `active`:

```bash
pnpm contracts:deploy -- M002 --network <base-sepolia|base-mainnet> --dry-run
pnpm contracts:deploy -- M002 --network <base-sepolia|base-mainnet> --broadcast \
  --signer deployer=<wallet> --signer sellerRewardsPoolOwner=<wallet>
```

The CLI reads live chain state and finishes whatever is missing. Rerunning is
safe: both steps check on-chain state first and an `active` pool is a no-op.

## Why

Legacy EmissionsV2 routed rewards of sellers without an unlock policy into
`AntseedSellerRewardsPool`. Claiming from that pool is blocked twice:

| Blocker | Revert | Fixed by |
| --- | --- | --- |
| `pool.sellerClaimPolicy == 0` | `NoSellerClaimPolicy` | pool owner installs `AntseedLegacySellerClaimPolicy` |
| pool not on `ANTSToken.transferWhitelist` while transfers are disabled | `TransfersNotEnabled` | token owner whitelists the pool |

M001 pins the pool to a registry facade so *locking* keeps working after the
flip, but leaves both blockers in place on purpose; this migration removes them.

## What gets deployed

`AntseedLegacySellerClaimPolicy(v2, lastEpoch, releaseBps, washTradingRegistry)`

- `v2` — the legacy EmissionsV2 that locked into the pool (read from
  `AntseedLegacyEmissionsEscrow.legacyEmissions()`); `v1` is derived from
  `v2.legacyEmissions()` because V2 merges V1 points for epochs ≤ its
  migration epoch.
- `lastEpoch = gate.effectiveEpoch() − 1` — the last epoch legacy V2 could ever
  lock. Immutable; that is why M002 must wait for M001 to activate.
- `releaseBps` — `RELEASE_BPS`, default 1000 (10% of each seller's cumulative locked rewards).
- `washTradingRegistry` — `WASH_TRADING_REGISTRY`; the CLI defaults it to the
  `washTradingRegistry` address recorded in the activated M001 deployment ledger. Proven wash traders
  (`isProvenWashTrader`) can claim nothing. The registry address is immutable;
  the policy has no owner, manual seller flags, or administrative setters.

The policy is a pure view from the pool's perspective. It reconstructs a
seller's cumulative locked amount from V2 claim flags and V2/V1 points, so
`cumulative − locked` is what the seller already withdrew; nothing is
double-counted across claims and nothing needs storage.

## Required accounting assumptions

This rollout assumes the pool has never paid out and **all V2 seller rewards
for each pool participant have gone, and continue to go, into this same pool**.
Mixing direct and locked V2 payouts for one seller is unsupported: their claim
flags are indistinguishable and would reduce the reconstructed withdrawal
allowance. Direct-only addresses with no pool deposits, buyer payouts, and
rewards claimed directly through V1 do not affect another seller's allowance.

Keep pool participants ineligible for direct V2 payouts, direct-only addresses
out of the pool, and V2's rewards-pool address unchanged, including for late
claims after cutover. M002 does not enforce those future owner actions.
Removing mixed-payout tests does not add mixed-payout support.

Scan epochs **0 through `effectiveEpoch − 1`**, not just from `MIGRATION_EPOCH`:
old rewards earned under V1 can be claimed later through V2 into the pool.
`LAST_LOCKED_EPOCH`, if supplied, must equal that exact upper bound.

Before mainnet broadcast:

- Recheck V2's unlock-policy and pool-address history, distinguishing seller
  claims from buyer claims; verify no mixed seller histories or other pools.
- Check pool claim history and reconcile recorded deposits with each seller's
  locked balance and the pool total. A missing policy today alone does not
  prove there were no withdrawals in the past.
- Run the M001 → M002 fork rehearsal, then a dry run against the actual active
  M001 deployment. Check the real wash registry (the default fork uses a stub),
  signer ownership, token transfer permission, and release parameters.
- Verify `RELEASE_BPS=1000`: exactly 10% of each seller's cumulative locked
  rewards, less prior withdrawals. This is not a 10/65 rescaling of the legacy
  emission bucket. For example, 1,000 ANTS cumulatively locked permits 100 ANTS
  in total releases; repeating a claim cannot release another 10%.

These checks establish the deployment preconditions; they are not an audit
guarantee. Recheck them immediately before broadcast because owners can change
configuration after a rehearsal.

### Mainnet history check (2026-09-03)

At Base block `50,827,725`, the pool had 212 deposits across 82 sellers, zero
withdrawal events, and no claim policy had ever been installed. Its token
balance and total locked balance both matched deposits: 27,153,751.852988306343576944 ANTS.

V2's migration epoch is **4**. The [epoch-3 claim](https://basescan.org/tx/0xccbd262b981b9c9674c05414505386757e74fc258c034ea7356db32e64dbf7ef)
locked 14,821.253507455354316010 ANTS through V2. Starting the scan at epoch 4
would omit that real deposit; keep the scan starting at 0.

The broader claim that V2 never paid directly is false: transaction traces
show 17 direct seller payouts to `0x1f228613116E2d08014DfdCC198377C8dedf18C9`
(DiemStakingProxy), the only address enabled in the unlock-policy history.
For example, see [this direct proxy payout](https://basescan.org/tx/0x4c928c2e6c54c86e0a7cc07f5746b14c8e80dfcbacc9f131f7ad48625441561d).
That is separate from withdrawals from the seller rewards pool.

All 82 pool sellers' reconstructed cumulative rewards matched their locked
balances exactly. None had a direct V2 payout; the direct-only proxy had zero
pool balance. This verifies the no-mixed-history requirement at that block,
not the stronger (incorrect) claim that V2 never made any direct payouts.

## Signers

| `--signer` role | Must be | Sends |
| --- | --- | --- |
| `deployer` | `ANTSToken.owner()` | `setTransferWhitelist(pool, true)` (skipped if transfers are enabled or already whitelisted) |
| `sellerRewardsPoolOwner` | `AntseedSellerRewardsPool.owner()` | policy deployment + `setSellerClaimPolicy` |

Both signers are always named; the token owner is only *verified* when the
whitelist call is actually needed. Dry runs simulate each role as its live
owner and need no wallet.

## States

| State | Meaning |
| --- | --- |
| `ready` | M001 active, pool found, at least one of {whitelist, policy} missing |
| `active` | pool can send ANTS and has the recorded claim policy |
| `not-applicable` | the legacy emissions contract has no rewards pool (V1-only testnets); nothing to do |
| `invalid` | M001 not active, escrow missing, effective epoch ≤ migration epoch, or the pool carries a claim policy this ledger did not install |

## Rehearsal

`--fork-test` on Base mainnet runs the full M001 rehearsal (deploy, advance
past the boundary, cutover) on a disposable Anvil fork and then applies M002
on top of the records M001 wrote, checking that a second apply is a no-op.
M002 declares M001 as its prerequisite; the shared deployment framework owns
fork startup, prerequisite ordering, temporary records, and cleanup. M002's
rehearsal hook only applies M002 and checks its results. Ordinary dry runs and
broadcasts still require M001 to have been activated separately.

The 2026-09-03 rehearsal at fork block `50,571,469` passed M001 deploy/cutover,
M002 dry-run/install, and idempotent reruns. A real pool seller's forked claim
paid the configured share once; repeat claims reverted.
The wash-registry stub does not validate production wash-trading data.
That rehearsal predates removal of vesting and owner controls; rerun it with
the current policy before broadcasting.

## After

- Sellers call `AntseedSellerRewardsPool.claim(recipient)`; `NothingToClaim`
  means no additional rewards are claimable or the seller is a proven wash trader.
- The configured release share is available immediately, less prior withdrawals.
  The policy itself cannot be reconfigured. The existing pool owner retains
  the pool's `setSellerClaimPolicy` authority to replace the entire policy.
