# webrtc-fallback

With TCP between buyer and seller blocked, the WebRTC fallback still serves a paid chat.

Status: planned, no scenario yet.

## What to test

- NAT traversal and WebRTC fallback (packages/node/src/p2p/nat-traversal.ts, connection-manager.ts)

## What the testbench needs first

- network simulation (the codex/sandbox-netsim branch)

Targets: local. Capabilities: mockControl.
