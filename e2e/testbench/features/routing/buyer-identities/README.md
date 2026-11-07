# buyer-identities

Two buyer identities (x-antseed-buyer-identity) pay on two separate on-chain channels; an unknown identity gets 400.

Status: planned, no scenario yet.

## What to test

- /_antseed/buyer-identities and the identity header (apps/cli/src/buyer-identities/store.ts)
- per-identity channels and settlement

## What the testbench needs first

- the proxy control secret exposed to tb
- a second funded identity in the topology

Targets: local, fork. Capabilities: mockControl.
