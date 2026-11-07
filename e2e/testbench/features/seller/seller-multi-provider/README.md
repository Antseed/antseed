# seller-multi-provider

One seller with two providers: each model reaches the right provider upstream and settles under one channel.

Status: planned, no scenario yet.

## What to test

- several providers on one seller (packages/node/src/node.ts registerProvider)

## What the testbench needs first

- topology support for multiple providers per seller (README roadmap: multiple sellers from different configs)
- one mock per provider

Targets: local, fork. Capabilities: mockControl.
