# decisions-systemone

/v1/systemone decisions (provider-typesafe): only typesafe peers are picked, typed answers come back, settlement is exact.

Status: planned, no scenario yet.

## What to test

- /v1/systemone routing to typesafe-systemone services
- typed decision answers (plugins/provider-typesafe)
- token-priced decision billing

## What the testbench needs first

- a mock for the typesafe upstream
- provider-typesafe in the seller worker plugin table
- decision services in the topology

Targets: local, fork. Capabilities: mockControl.
