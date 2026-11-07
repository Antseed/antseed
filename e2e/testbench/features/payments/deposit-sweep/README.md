# deposit-sweep

Gasless deposit sweep: USDC sent to the buyer hot wallet is credited to AntseedDeposits minus the relay fee after /_antseed/deposits/watch, and shows in /_antseed/deposits/history.

Status: planned, no scenario yet.

## What to test

- EIP-3009 sweep via relayers (packages/node/src/payments/deposit-relayer.ts, apps/cli/src/proxy/deposit-watcher.ts)
- /_antseed/sweep, /deposits/status, /history, /watch
- desktop auto-sweep (apps/desktop/src/main/payments/deposit-sweep.ts)

## What the testbench needs first

- AntseedDepositRelay deployed by the local chain setup
- a mock relayer endpoint
- tb.usdcTransfer() to fund the hot wallet

Targets: local. Capabilities: mockControl, sourceContracts.
