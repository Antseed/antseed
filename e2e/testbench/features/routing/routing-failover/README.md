# routing-failover

One seller starts answering 500s: auto-routed traffic moves to the other seller, its cooldown shows in /_antseed/peer-health, and /_antseed/peer-health/clear brings it back; 429 pressure gives no cooldown.

Status: planned, no scenario yet.

## What to test

- peer health, 5xx cooldown streaks, 429 pressure, 401/403 failover (apps/cli/src/proxy/peer-health.ts)
- /_antseed/peer-health and /clear

## What the testbench needs first

- tb.request() for the peer-health routes
- a mock fault kind for 429 with retry-after

Targets: local, fork. Capabilities: mockControl, sellerControl.
