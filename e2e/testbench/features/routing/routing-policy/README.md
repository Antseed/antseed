# routing-policy

Buyer routing policy: price caps, blockedPeerIds and minTrustScore keep traffic off a seller, a pin to it is refused with the policy reason, and /_antseed/route-preview names every excluded seller with its reason.

Status: planned, no scenario yet.

## What to test

- Price + Trust ranking and sort modes balanced, price, latency, trust (apps/cli/src/proxy/route-policy.ts, packages/node/src/routing/model-route-ranking.ts)
- blockedPeerIds, minTrustScore, minReputation, input and output price caps
- /_antseed/route-preview exclusion reasons

## What the testbench needs first

- per-seller pricing and buyer preference knobs exercised together in one topology
- tb.request() for /_antseed/route-preview

Targets: local, fork. Capabilities: mockControl.
