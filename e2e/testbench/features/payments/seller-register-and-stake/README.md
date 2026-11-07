# seller-register-and-stake

antseed seller register and seller stake against the local chain: the ERC-8004 agentId resolves to the seller wallet and the stake shows in the pool.

Status: planned, no scenario yet.

## What to test

- seller register (apps/cli/src/cli/commands/seller/register.ts, packages/node/src/payments/evm/identity-client.ts)
- seller stake and legacy stake/unstake with slashing conditions

## What the testbench needs first

- cli mode (today the supervisor registers and stakes with its own chain client, not the CLI)
- a CLI transcript driver

Targets: local. Capabilities: sourceContracts.
