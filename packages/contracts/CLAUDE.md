# packages/contracts

The on-chain protocol. Contract map and call graph: `README.md`. Contracts call each other only through `interfaces/`, by address. `AntseedDeposits` and `AntseedStaking` hold funds and rarely change. `AntseedChannels` holds no USDC and is swappable.

Who earns what is decided by policy contracts set by address, never by branches in accounting:

| Slot | Interface | Set on | Decides | Today |
| --- | --- | --- | --- | --- |
| Points | `IAntseedPointsPolicy` | `AntseedUsageAccounting` | seller and buyer points per settlement | `AntseedPointsPolicyRegistry` |
| Modifiers | `IAntseedPointsModifier` | the registry (max 8, in order) | one step on the previous step's seller and buyer points | `AntseedWashTradingPointsPolicy` |
| Pool weight | `IAntseedPoolWeightPolicy` | `AntseedUsageAccounting` | stake power to reward weight | unset (raw power) |
| Seller claim | `IAntseedSellerClaimPolicy` | `AntseedSellerRewardsPool` | claimable share of locked rewards | `AntseedLegacySellerClaimPolicy` |
| Seller unlock | `IAntseedSellerUnlockPolicy` | `AntseedEmissionsV2` (legacy) | claim now instead of vesting | `AntseedSellerUnlockPolicy` |

| Rule | Enforced by |
| --- | --- |
| Settlement equals what the buyer signed, never more. Settle-on-disconnect charges exactly the delivered work. | `forge test`, sandbox `payment-flow` |
| The buyer never needs gas: every action is seller-initiated or permissionless. Channels holds no USDC. | review only |
| A failing policy never blocks settlement: it records zero points and emits `PointsPolicyFailed` or `PoolWeightPolicyFailed`. | `test/fuzz/AntseedUsageAccountingFuzz.t.sol` |
| A side zeroed by one modifier stays zero. No policy means raw points. | `test/AntseedPointsPolicyRegistry.t.sol` |

**Ask first:** every change. Deployed contracts are one-way, and repointing a policy slot changes everyone's rewards.

**Prove it:** `forge test`. Settle-path changes get a fuzz or invariant test.
