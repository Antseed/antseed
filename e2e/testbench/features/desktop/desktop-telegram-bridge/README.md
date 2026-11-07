# desktop-telegram-bridge

With a mock Telegram API, a message from the owner gets a reply from a testbench seller through the bridge; no real Telegram endpoint is reached.

Status: planned, no scenario yet.

## What to test

- Telegram bot bridge (apps/desktop/src/main/telegram/bridge.ts)

## What the testbench needs first

- a mock Telegram getUpdates/sendMessage server
- an explicit testbench-only opt-in (attach-only never resumes the Telegram bridge today)

Targets: local, fork. Capabilities: desktop, mockControl.
