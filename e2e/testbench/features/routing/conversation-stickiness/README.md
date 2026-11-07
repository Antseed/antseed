# conversation-stickiness

A conversation stays on one seller across turns, its spend rolls up in /_antseed/conversations, and it fails over when that seller stops.

Status: planned, no scenario yet.

## What to test

- conversation identity and soft peer preference (apps/cli/src/proxy/conversation-identity.ts)
- /_antseed/conversations and /update (rename, pin, delete)

## What the testbench needs first

- tb.request() with conversation headers
- tb.chat() returning the serving seller per turn

Targets: local, fork. Capabilities: mockControl, sellerControl.
