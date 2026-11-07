# seller-dashboard-and-alerts

The seller dashboard API (with its token) reports revenue equal to the settled amount, and a webhook alert fires when a model fails.

Status: planned, no scenario yet.

## What to test

- seller monitor dashboard (apps/cli/src/seller-monitor)
- seller alerts via webhook and Telegram (apps/cli/src/seller-alerts)
- gas health and auto-refuel (packages/node/src/health/gas-auto-refuel.ts)

## What the testbench needs first

- cli mode with the dashboard enabled
- a webhook receiver on tb
- a dashboard token exposed to tb

Targets: local, fork. Capabilities: mockControl.
