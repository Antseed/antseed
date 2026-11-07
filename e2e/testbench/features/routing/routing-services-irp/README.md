# routing-services-irp

A router set as the default routing service: the antseed alias is ranked on every turn, the irp-suggest rank is billed as one completed request, inference then runs on the suggested seller, and both settle.

Status: planned, no scenario yet.

## What to test

- /_antseed/routing-services and /_antseed/route (apps/cli/src/proxy/routing-services.ts)
- irp-suggest unit billing completed_requests (plugins/provider-irp-router, packages/protocol/src/irp.ts)
- router execution (apps/cli/src/proxy/router-execution.ts)

## What the testbench needs first

- a router seller (provider-irp-router) in the topology with a mock ranking upstream
- tb.request()

Targets: local, fork. Capabilities: mockControl.
