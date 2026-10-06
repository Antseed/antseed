# M001 — Recognized usage cutover

## Recorded Base mainnet deployment

Phase 1 completed on September 6, 2026: 30 transactions in blocks
50,955,026–50,955,055 and 11 verified contracts. The append-only record is
`deployments/base-mainnet/history/001-recognized-usage-deployed.json`.
The token now points to the gate and legacy emissions to its funded escrow.
The main registry's staking/emissions pointers are still legacy.

The next operation on this deployment is **cutover**, not another deployment.
Effective epoch 22 begins September 10, 2026 at 09:54:21 UTC; run the waiting
cutover process before 09:53:21 UTC and leave signing available. Initialization
and historical proof submission must be prepared before that boundary.
See the [full contract inventory](../../../README.md#m001-deployed-stack).

The deployment key `0x48F4142F4AbF7b77a03f0cDffcd511eDD9B6d54a` held all five
M001 signer roles at the phase-1 preflight. Recheck owners before cutover and
after any ownership handoff. DIEM staking is not proxy operator authorization:
starter initialization requires an operator and is a separate transaction.

The phase-1 runner's RPC `codehash` read failed after all transactions and
explorer verifications completed. Its history was recovered from confirmed
receipts using hashes of fetched runtime bytecode, then checked against the
local build. Do not repeat deployment to repair a local recording failure.

## General workflow

Two CLI broadcast runs: deploy during the current epoch, then activate at the
next epoch boundary. They are not necessarily a full epoch apart. For the
step-by-step operator walkthrough, see
[the contracts README](../../../README.md#operator-walkthrough-deploy-then-start-the-waiting-cutover-process).
Run both through the deployment CLI:

```bash
pnpm contracts:deploy -- M001 --network <base-sepolia|base-mainnet> --dry-run
pnpm contracts:deploy -- M001 --network <base-sepolia|base-mainnet> --broadcast \
  --signer <role>=<wallet> [...]
```

The CLI reads live chain state and runs whichever phase is next. Deployment
exits after writing its record. Start the second run before boundary minus
60 seconds and leave it running: this process performs the waiting, not a
background service. Keep an operator available to sign. After a failure,
inspect receipts and live state before choosing the recovery action; do not
assume a fresh invocation can recover every partially completed transaction
sequence.

Both deployment and cutover broadcasts automatically use Foundry's `--slow`
mode: each transaction must be confirmed successfully before the next is sent.
Production and fork rehearsals use the same setting. Dry runs remain
simulation-only. This does not make the migration atomic or undo transactions
that succeeded before an interruption.

## Signers

No private key is ever read by this repository. Each role is named on the
command line as `--signer <role>=<wallet>`; the CLI resolves the wallet to an
**address**, checks on chain that the address holds the role, passes the
address to the Solidity script, and hands the wallet selection to Foundry,
which prompts to unlock it at the moment it signs. Wallet forms:

| Form | Meaning |
| --- | --- |
| `account:<name>` | encrypted keystore in `~/.foundry/keystores` (`cast wallet import <name> --interactive`) |
| `keystore:<path>` | encrypted keystore file at a path |
| `ledger[:<index>]` | Ledger hardware wallet, HD index (default 0). One Ledger per run. |
| `unlocked:<address>` | RPC-unlocked account; Anvil / fork tests only |

Two roles held by the same key map to a single wallet flag. Foundry refuses
to broadcast when any `vm.startBroadcast(address)` has no matching wallet, so
a mis-mapped role fails before the first transaction. Dry runs need no
wallets: each role is simulated as its live on-chain owner.

The scheduler that waits for the epoch boundary therefore holds no secrets
while it sleeps; a person unlocks the keystore or confirms on the Ledger when
the boundary arrives.

## Broadcast 1 — `Deploy.s.sol`

Deploys the recognized-usage stack, moves ANTS mint authority to
`AntseedEmissionsGate`, funds the legacy escrow, and re-points legacy
emissions at it. Registry `emissions`/`staking` pointers are **not** touched:
the network keeps running on the legacy stack until the in-flight epoch
finalizes.

This phase also deploys `AntseedWashTradingRegistry` and pins its address into
`AntseedWashTradingPointsPolicy`, registered in the usage-points policy registry.
Proven wash-trading sellers generate zero seller and buyer usage points, but
can still initialize starter positions and settle USDC payments. Do not deploy
a separate registry for M001.
Set `SP1_VERIFIER` to a concrete SP1 verifier (not the gateway),
`SP1_VERIFIER_HASH` to its release hash, `WASH_TRADING_SELLER_PROGRAM_VKEY` to
the seller proof program vkey, and `HISTORICAL_PERIOD_START_BLOCK` /
`HISTORICAL_PERIOD_END_BLOCK` to the proof's nonzero, ordered uint64 block range.
`WASH_TRADING_BLOCKHASH_STORE` defaults to Chainlink's Base deployment and
cannot be overridden on Base mainnet; other networks need a deployed store.
M001 uses the existing deployer signer, not `DEPLOYER_PRIVATE_KEY`.

The deployment record includes the registry's address, constructor arguments,
and bytecode provenance. Deployment and resumed cutover checks require
`AntseedWashTradingPointsPolicy.washTradingRegistry()` to match that record and
the policy to be the sole registered modifier. The CLI supplies
`WASH_TRADING_POINTS_POLICY` from the deployment record to the cutover script.
Activation history
retains these contract entries with their original provenance, marked as
inherited rather than newly deployed during cutover. Submit historical
proofs to this new registry before cutover: only usage recorded after a seller
is flagged is filtered, with no retroactive deletion of points. The registry
is empty immediately after deployment, and prior submissions to
another registry are not copied. The fork rehearsal deploys the real registry
with a test-only verifier stub by default, not a replacement status registry.

Signer: `--signer deployer=…` must own `ANTSToken` and the legacy emissions
contract (checked before anything is sent).

```bash
pnpm contracts:deploy -- M001 --network base-mainnet --broadcast \
  --signer deployer=account:antseed-owner
```

Writes `deployments/<network>/history/001-recognized-usage-deployed.json`.
Commit that record; broadcast 2 can then run from any machine.

## Broadcast 2 — `Cutover.s.sol` (next epoch)

The CLI pauses `AntseedChannels` 60 s before the epoch boundary so no usage can
land on the legacy ledger for the new epoch, waits for the boundary, runs
`Cutover.s.sol`, and unpauses **only** after verifying on chain that both
registry pointers reached the new stack. If the flip fails, Channels stays
paused: fix the cause and rerun, or force-unpause manually with the Channels
owner key.

`Cutover.s.sol` itself:

1. (staker key) syncs the DiemStakingProxy reward epochs and claims every
   pre-effective epoch whose pot is not yet funded, so each pot is stored with
   its real ANTS amount before the pointer moves.
2. (pool owner key) pins `AntseedSellerRewardsPool` to a dedicated registry
   facade so locked-path legacy sellers keep claiming.
3. (registry owner key) `setEmissions(usageAccounting)` and
   `setStaking(sellerRegistry)`.

Roles are never defaulted from one another. Required for the cutover:

| `--signer` role | Must be |
| --- | --- |
| `registryOwner` | `AntseedRegistry.owner()` |
| `channelsOwner` | `AntseedChannels.owner()` (signs pause/unpause via `cast`) |
| `deployer` | owner of the gate and points-policy registry from broadcast 1 (read-only check) |
| `diemStaker` | address with DIEM staked on the proxy (mainnet, or when `DIEM_STAKING_PROXY` is set) |
| `sellerRewardsPoolOwner` | `AntseedSellerRewardsPool.owner()` (same condition) |

For the recorded mainnet deployment, the same keystore can supply all five
roles while ownership and DIEM stake remain unchanged:

```bash
pnpm contracts:deploy -- M001 --network base-mainnet --broadcast \
  --signer deployer=account:antseed-deployer \
  --signer registryOwner=account:antseed-deployer \
  --signer channelsOwner=account:antseed-deployer \
  --signer sellerRewardsPoolOwner=account:antseed-deployer \
  --signer diemStaker=account:antseed-deployer
```

`USAGE_ACCOUNTING`, `SELLER_REGISTRY`, and the `EXPECTED_*` legacy addresses
are supplied by the CLI from the deployment record.

Writes `history/001-recognized-usage-activated.json` and updates
`current.json`.

## Post-flip checklist (manual)

- Seed the proxy's agent pool before the flip boundary to activate its power
  in the first rewarded epoch. Once the faucet is funded, an authorized proxy operator can call
  `AntseedPositionInit.initPosition(proxyAddress)`. The operator owns the lANTS
  position, staker rewards, and withdrawal rights; the proxy's agent pool gets
  the stake. Operator revocation does not remove those position rights. Usage
  of pool-less agents is not accounted, and late stake activates next epoch.
- Do **not** renounce `AntseedEmissionsGate` ownership before the verification
  rollout: that rollout rotates the editable 10% controller from
  `VERIFICATION_WALLET` to `AntseedVerification`.
- `ANTSToken` and the remaining ownable contracts still require their
  separately reviewed production ownership handoff.
- Keep `AntseedRegistry` ownership: it is the only key that can open the
  temporary `setStaking(legacy)` window needed to withdraw the proxy's legacy
  USDC stake (`SellerRegistry.unstake` reverts by design).
- Sellers staked in legacy USDC staking stay eligible via the `SellerRegistry`
  legacy fallback. Call `setLegacyStakeEligibilityEnabled(false)` only after
  seller pools are seeded with ANTS stake.
- Sellers cannot stake ANTS into pools until they are transfer-whitelisted or
  transfers are enabled.
- Fund the `AntseedPositionInit` faucet with ANTS from a wallet that already
  holds them (temporarily whitelist that wallet as a sender via
  `ANTSToken.setTransferWhitelist`, transfer, then de-whitelist). Fund in small
  increments: the faucet has no owner and no sweep, leftovers strand forever.
  Grants staked before the flip epoch's boundary have power at the first
  rewarded epoch; later claims activate one epoch after staking.
- Legacy EmissionsV2 is registered against the escrow: all its claims and
  team/reserve flushes pay from the pre-minted pot. Sweep escrow leftovers only
  after legacy claim activity has wound down.
- Fallback for locked-path stragglers: `EmissionsV2.setSellerUnlockPolicy`
  (plain `onlyOwner`, works even after any registry renouncement).

## Local CLI rehearsal

Use the persistent M001 sandbox to rehearse CLI behavior on the same pinned Base mainnet fork as the migration fork test. The sandbox runs the deploy phase first and deliberately stops before cutover, preserving the Anvil process between commands.

```bash
export BASE_MAINNET_RPC_URL=https://your-archive-base-rpc.example
export ANTS_HOLDER=0x... # ANTS balance at BASE_MAINNET_FORK_BLOCK

pnpm m001:sandbox up --port 8545 --out .m001-sandbox
pnpm m001:sandbox status --out .m001-sandbox
```

The deploy command writes a copied deployment ledger and `.m001-sandbox/cli-config.json`. Point CLI commands at that file to verify legacy mode, then cut over and reuse the refreshed file:

```bash
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller rewards

pnpm m001:sandbox cutover --out .m001-sandbox
pnpm m001:sandbox fund-position-init 5 --out .m001-sandbox
pnpm m001:sandbox advance-epoch 2 --out .m001-sandbox
pnpm m001:sandbox fund-ants 0xYourCliWallet 100 --out .m001-sandbox

antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller register
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller legacy claim-starter
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller stake 100 --epochs 4
antseed --config .m001-sandbox/cli-config.json --data-dir /tmp/antseed-m001 seller pool positions

pnpm m001:sandbox down --out .m001-sandbox
```

Additional helpers are `fund-seller <address>`, `advance-epoch [n]`, `fund-ants <address> <amount>`, and `fund-position-init <n>`. The generated config carries all ledger-derived address overrides; the CLI still reads the registry and refuses commands if either active pointer disagrees.
