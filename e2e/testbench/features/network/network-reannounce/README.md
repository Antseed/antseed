# network-reannounce

A seller restarts with a new price: after re-announce and /_antseed/peers/refresh the buyer sees the new price and routes by it.

Status: planned, no scenario yet.

## What to test

- DHT announce and refresh (packages/node/src/discovery/announcer.ts)
- /_antseed/peers/refresh and /connect

## What the testbench needs first

- tb.restartSeller(id, { topology overrides })
- tb.request() for peers/refresh

Targets: local, fork. Capabilities: mockControl, sellerControl.
