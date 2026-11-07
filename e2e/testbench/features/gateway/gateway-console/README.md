# gateway-console

Gateway console: SIWE sign-in with the buyer key gives a session cookie, the CSP header is present, a workspace peer list limits which sellers are used, and an x402 top-up through a mocked facilitator raises the key cap.

Status: planned, no scenario yet.

## What to test

- console auth SIWE, OIDC, admin tokens, CSP (apps/cli/src/gateway/auth, console-api)
- workspaces, members, presets, peer lists, audit, statements
- /v1/key and /v1/key/topup via x402 (apps/cli/src/gateway/x402.ts)
- state bundle export and import

## What the testbench needs first

- the gateway process from gateway-key-flow
- a facilitator mock
- a console driver (scripts/gateway-console-smoke.mjs is the manual precedent)

Targets: local, fork. Capabilities: mockControl.
