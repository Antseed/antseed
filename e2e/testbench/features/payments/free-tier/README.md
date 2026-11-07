# free-tier

Free tier: N free requests open no channel, then the seller answers 429 rate_limit_error with retry-after on a free service, or falls back to paid on a priced service; staked delegations raise the allowance.

Status: covered. Scenario: `free-tier` (`../../../scenarios/free-tier.mjs`, cli mode, `--chain local` with the full contract stack).

## What to test

- seller free-tier limiter (packages/node/src/payments/seller-free-tier-limiter.ts)
- AntseedFreeUsage and staked delegations (buyer free-tier)
- 429 with retry-after before payment

## What the testbench needs first

- AntseedFreeUsage deployed by the local chain setup
- free-tier knobs in the topology
- a delegation setup helper

Targets: local. Capabilities: mockControl, sourceContracts.
