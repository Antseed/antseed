# desktop-system-proxy

An intercepted request from a system-proxied app is rewritten to the routed model and answered by a testbench seller, with the CA and proxy settings confined to the testbench.

Status: planned, no scenario yet.

## What to test

- system proxy, CA manager, app profiles (apps/desktop/src/main/system-proxy, apps/cli/src/system-proxy)
- public tunnel lifecycle with a fake cloudflared

## What the testbench needs first

- a loopback-only system proxy mode that machineWideChangesDisabled allows
- a fake cloudflared binary

Targets: local, fork. Capabilities: desktop, mockControl.
