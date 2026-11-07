# desktop-views

The peers view lists exactly the testbench sellers, diagnostics shows the attached proxy, the model and router views match /v1/models, and telemetry makes no egress under the testbench.

Status: planned, no scenario yet.

## What to test

- peers, diagnostics, explore, model, router, rewards, activity views
- telemetry disabled under the testbench

## What the testbench needs first

- accessible names on those views
- an egress check on tb (no non-loopback connections from the desktop)

Targets: local, fork. Capabilities: desktop, mockControl.
