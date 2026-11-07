# gateway-key-flow

A gateway in front of the testbench buyer: a key with a spend cap pays per chat, answers 402 once the cap is reached, and the key spend equals the settled amount.

Status: planned, no scenario yet.

## What to test

- antseed gateway start, keys, limits, accounting, request shaping (apps/cli/src/gateway)
- 402 on a breached cap
- spend feed back from the buyer

## What the testbench needs first

- the gateway as a testbench process on the buyer
- tb.gateway() driver (keys, caps, requests)

Targets: local, fork. Capabilities: mockControl.
