# seller-crash-midstream

The seller is killed with SIGKILL in the middle of a streamed answer: the client sees the cut, the buyer pays only for what reached the wire, and the restarted seller settles exactly that.

Status: planned, no scenario yet.

## What to test

- seller crash mid-request and reconnect (packages/node/tests/seller-reconnect, e2e/tests/seller-disconnect.test.ts)

## What the testbench needs first

- tb.killSeller(id, { signal: "SIGKILL" }) timed against a tagged stream
- a mock stream slow enough to hit

Targets: local, fork. Capabilities: mockControl, sellerControl.
