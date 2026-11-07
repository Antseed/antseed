# buyer-withdraw-and-exit

antseed buyer withdraw returns the free balance while the reserved part stays locked; with the seller offline, buyer channels request-close, the grace period, then withdraw releases the reserve.

Status: covered. Scenario: `buyer-withdraw-and-exit` (`../../../scenarios/buyer-withdraw-and-exit.mjs`, cli mode, `--chain local` with the full contract stack).

## What to test

- buyer withdraw (apps/cli/src/cli/commands/buyer/withdraw.ts)
- unilateral exit request-close, grace, withdraw through the buyer CLI (apps/cli/src/cli/commands/buyer/channel-withdraw.ts)

## What the testbench needs first

- driving the real buyer CLI from a scenario (cli mode); today tb.buyerRequestClose() impersonates the buyer on Anvil instead of going through the CLI

Targets: local, fork. Capabilities: mockControl, sellerControl, warpTime.
