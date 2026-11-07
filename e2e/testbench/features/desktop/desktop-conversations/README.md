# desktop-conversations

Renaming, pinning and deleting a conversation in the desktop shows up in /_antseed/conversations, and tool approvals in a workspace folder are recorded.

Status: planned, no scenario yet.

## What to test

- conversation store and workspace folder (apps/desktop/src/main/chat/conversation-store.ts, workspace.ts)
- tool approval cards

## What the testbench needs first

- conversation list selectors in ui
- tb.request() for /_antseed/conversations

Targets: local, fork. Capabilities: desktop, mockControl.
