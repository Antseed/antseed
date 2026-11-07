# relay-bridge

The relay lists the testbench sellers, a web-sdk buyer chats through the WebSocket bridge, and private addresses are refused unless static.

Status: planned, no scenario yet.

## What to test

- apps/relay GET /sellers, WS /bridge/<peerId>, address guard
- packages/web-sdk buyer

## What the testbench needs first

- apps/relay as a testbench process
- a web-sdk client driver on tb

Targets: local, fork. Capabilities: mockControl.
