# desktop-signer-keys

Exporting the signer key and importing it again keeps the same buyer address; in attach-only mode the import is refused.

Status: planned, no scenario yet.

## What to test

- signer key import and export (SignerKeyDialogs.tsx, identity:export-key and identity:import-key IPC)
- attach-only guard on identity import

## What the testbench needs first

- an isolated-profile desktop (not attach-only) under Playwright
- dialog selectors

Targets: local, fork. Capabilities: desktop, mockControl.
