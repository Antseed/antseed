# emissions-rewards

Paid chats accrue buyer and seller points; warping past the epoch and claiming pays out exactly the pending ANTS.

Status: planned, no scenario yet.

## What to test

- emissions and reward claims (packages/node/src/payments/reward-claims.ts, evm/emissions-client.ts)
- seller rewards claim and emissions CLI

## What the testbench needs first

- emissions contracts and the M001 cutover in the local chain setup
- epoch helpers on tb
- a CLI transcript driver

Targets: local. Capabilities: sourceContracts, warpTime, mockControl.
