# cli-buyer-commands

antseed buyer status, balance, channels, connection, identity, metering and activity run against the testbench data dir and their transcripts match the proxy and the chain.

Status: covered. Scenario: `cli-buyer-commands` (`../../../scenarios/cli-buyer-commands.mjs`, cli mode, `--chain local` with the full contract stack).

## What to test

- buyer CLI commands (apps/cli/src/cli/commands/buyer)
- the CLI feature recipe (.claude/skills/verify-antseed/features/cli.md) as a scripted check

## What the testbench needs first

- tb.cli(args) transcript driver (stdout, stderr, exit code) on the testbench buyer dir; issue-1050 has a one-off for buyer status

Targets: local, fork. Capabilities: mockControl.
