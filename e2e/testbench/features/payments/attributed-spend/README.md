# attributed-spend

Spend tagged per request is summed per tag by /_antseed/attributed-spend and equals the settled amount.

Status: planned, no scenario yet.

## What to test

- spend attribution (apps/cli/src/proxy/spend-attribution.ts, gateway spend feed)

## What the testbench needs first

- the spend-tag header through tb.request() with the control secret

Targets: local, fork. Capabilities: mockControl.
