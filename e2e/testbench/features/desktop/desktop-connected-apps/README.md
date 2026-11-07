# desktop-connected-apps

Messages sent through the Claude Desktop loopback gateway reach a testbench seller, and apps connect/disconnect rewrites and restores app configs under the testbench HOME only.

Status: planned, no scenario yet.

## What to test

- connected apps: Claude Desktop gateway, Cursor, custom apps (apps/desktop/src/main/connected-apps, packages/connected-apps)
- antseed apps connect and the wrapped codex/claude/opencode commands

## What the testbench needs first

- fake app config directories under the testbench HOME
- a loopback gateway driver
- an opt-in that keeps connected-app writes inside the testbench (machineWideChangesDisabled blocks them today)

Targets: local, fork. Capabilities: desktop, mockControl.
