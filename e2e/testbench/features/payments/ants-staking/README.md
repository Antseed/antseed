# ants-staking

ANTS staking through the ants CLI on the local chain: stake, extend, split, merge, withdraw; positions and pools match the chain.

Status: planned, no scenario yet.

## What to test

- ants stake, positions, extend, split, merge, move, withdraw, pools (apps/cli/src/cli/commands/ants)
- AntseedStaking and AntseedSellerPools (packages/contracts)

## What the testbench needs first

- ANTS token and staking contracts in the local chain setup (Deploy.s.sol deploys the registry stack only)
- a CLI transcript driver

Targets: local. Capabilities: sourceContracts.
