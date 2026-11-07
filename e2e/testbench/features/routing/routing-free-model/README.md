# routing-free-model

The free-model router ranks only free candidates and opens no payment channel for the rank.

Status: planned, no scenario yet.

## What to test

- free-model-router (plugins/provider-free-model-router)
- no channel for free traffic

## What the testbench needs first

- free (zero-priced) services in the topology
- provider-free-model-router in the seller worker plugin table

Targets: local, fork. Capabilities: mockControl.
