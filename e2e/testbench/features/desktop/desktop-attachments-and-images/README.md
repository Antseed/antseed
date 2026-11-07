# desktop-attachments-and-images

A chat with a file attachment gets a reply, and an image generated from the chat composer is shown and charged per image.

Status: planned, no scenario yet.

## What to test

- chat attachments (apps/desktop/src/main/chat/attachments)
- image generation in chat (apps/desktop/src/main/chat/image-generation.ts)

## What the testbench needs first

- an image seller in the desktop topology
- attachment and image selectors in ui (tb.desktop())

Targets: local, fork. Capabilities: desktop, mockControl.
