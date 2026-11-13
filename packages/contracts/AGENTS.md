# packages/contracts

The on-chain protocol. Contract map and call graph: `README.md`. Contracts call each other only through `interfaces/`, by address. `AntseedDeposits` and `AntseedStaking` hold funds and rarely change. `AntseedChannels` holds no USDC and is swappable.

Who earns what is decided by policy contracts set by address, never by branches in accounting:

| Slot | Interface | Set on | Decides | Today |
| --- | --- | --- | --- | --- |
| Points | `IAntseedPointsPolicy` | `AntseedUsageAccounting` | seller and buyer points per settlement | `AntseedPointsPolicyRegistry` |
| Modifiers | `IAntseedPointsModifier` | the registry (max 8, in order) | one step on the previous step's seller and buyer points | `AntseedWashTradingPointsPolicy`, then `AntseedVerificationPointsPolicy` |
| Pool weight | `IAntseedPoolWeightPolicy` | `AntseedUsageAccounting` | stake power to reward weight | unset (raw power) |
| Seller claim | `IAntseedSellerClaimPolicy` | `AntseedSellerRewardsPool` | claimable share of locked rewards | `AntseedLegacySellerClaimPolicy` |
| Seller unlock | `IAntseedSellerUnlockPolicy` | `AntseedEmissionsV2` (legacy) | claim now instead of vesting | `AntseedSellerUnlockPolicy` |

## Inside

- A Foundry project with no `package.json`, so root `pnpm build`, `test` and `typecheck` skip it. `foundry.toml` compiles every top-level directory; OpenZeppelin resolves from the root `node_modules`.
- Contracts are grouped by role (`core/`, `payments/`, `staking/`, `sellers/`, `emissions/`, `policies/`, `rewards/`, `verification/`, `integrity/`). `legacy/` stays deployed and the node still reads it; never delete it.
- A new deployment: a Foundry script in `script/migrations/MNNN<Name>/`, a runner module `scripts/deployments/mNNN.mjs` (repo root) listed in `scripts/deployments/index.mjs`, and `test/migrations/MNNN<Name>.t.sol`.
- `deployments/` is the ledger: `<network>/current.json` and append-only `history/`. Rules in `deployments/README.md`.

| Rule | Enforced by |
| --- | --- |
| Settlement equals what the buyer signed, never more. | `forge test`, which CI doesn't run |
| Normal use needs no buyer gas: the seller submits `reserve`, `settle` and `close`. `requestClose`, channel `withdraw` and Deposits `withdraw` are operator-only, so the operator pays their gas. Channels holds no USDC. | review only |
| A failing policy never blocks settlement: it records zero points and emits `PointsPolicyFailed` or `PoolWeightPolicyFailed`. | `test/fuzz/AntseedUsageAccountingFuzz.t.sol` |
| A side zeroed by one modifier stays zero. No policy means raw points. | `test/AntseedPointsPolicyRegistry.t.sol` |
| Deposits stays solvent and conserves USDC; reserved equals the sum over active channels. Settled never exceeds a channel's deposit, and `activeChannelCount` matches live channels. | `test/invariant/AntseedProtocol.invariant.t.sol`, `test/invariant/ChannelsStateMachine.invariant.t.sol` |
| A ReserveAuth or SpendingAuth for another seller, domain, channel or amount, or with edited metadata, is rejected. | `test/AntseedChannelsAuth.fuzz.t.sol` |
| `Deposits.withdraw` pays `msg.sender`, the operator. The relay never transfers to the buyer address. | `test/AntseedDeposits.t.sol`, `test/AntseedDepositRelay.t.sol` |
| `AntseedStats` decodes SpendingAuth metadata by its first four ABI words, so new metadata versions only append. | `test/AntseedStats.t.sol` (v5) |
| `history/*.json` is append-only; every released contract carries block, tx hash, code hash, constructor args and owner; `generated-contract-addresses.ts` equals what the ledger renders. | `scripts/check-contract-deployment-history.mjs`, `scripts/validate-contract-deployments.mjs` |
| `base-local` addresses in chain config equal the deterministic nonces of the local deploy scripts. | `e2e/testbench/lib/local-deploy.mjs` |

## Connections

- Addresses: `deployments/<network>/current.json` renders into `packages/node/src/payments/generated-contract-addresses.ts` (`scripts/generate-contract-chain-config.mjs`; never edit it). `base-local` is hand-written in `chain-config.ts` and also hard-coded in `e2e/testbench/lib/local-deploy.mjs` and `e2e/scripts/full-payment-flow.mjs`.
- EIP-712 domains and types live in `packages/protocol/src/signatures.ts`. No ABI is generated: ABI strings are copied across node, buyer-core, web-sdk, wallet-config and several apps, so grep a changed signature and change every copy in the same PR.
- CI never runs `forge test`, but deploys these contracts on Anvil for the e2e and testbench jobs, so a broken `Deploy.s.sol` fails them.
- Nothing here is published. A change reaches users through a migration broadcast, its history record, the regenerated address file and a node and CLI release.

## Traps

- `README.md` lags the code (wrong build path, Channels domain version, `withdraw` recipient, fee default). Check the `.sol` file; take addresses only from chain config.
- Swapping `registry.channels()` strands every lock reserved on the old Channels; pointing back recovers them (`test/ChannelsSwap.t.sol`).
- Since M001, `registry.emissions()` is `AntseedUsageAccounting` and `registry.staking()` is `AntseedSellerRegistry`; the gate is `emissionsGate()` on the accounting contract. Calling the registry's emissions as the gate once made verification claims revert.
- Deployed contracts are re-pointed with façade registries, not upgrades (`AntseedLegacyEmissionsEscrow`, `AntseedLegacyRewardsPoolRegistry`). `AntseedEmissionsGate` hard-codes `ANTS_TOKEN` and `GENESIS`.
- An extra transaction in `Deploy.s.sol` or `DeployLocalFull.s.sol` shifts every later local address; update `base-local` and `local-deploy.mjs` together.
- `forge test` never writes gas snapshots, but `pnpm contracts:check` checks them, so a gas change in usage accounting needs `pnpm contracts:snapshot`.
- `M001RecognizedUsageFork.t.sol` returns early without `BASE_MAINNET_RPC_URL`; a green run without it proves nothing. CI's `forge install` rewrites `foundry.lock`; restore it locally.
- `bytecode_hash = "none"` and `cbor_metadata = false` keep builds reproducible; changing either breaks bytecode verification of everything deployed. The deploy runner broadcasts only from a clean tree and never overwrites a history record.

**Ask first:** every change. Deployed contracts are one-way, and repointing a policy slot changes everyone's rewards. That includes `foundry.toml` compiler settings and any `--broadcast`.

**Prove it:** `forge test`. CI doesn't run it, and root `pnpm test` skips this package, so run it yourself. Settle-path changes get a fuzz or invariant test (`FOUNDRY_PROFILE=deep-fuzz` for custody). Before a deployment, run `pnpm contracts:check`. A changed signature also runs node's and protocol's tests; a changed local deploy script runs `pnpm test:testbench`.
