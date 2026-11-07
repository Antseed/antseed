# skills-smoke

The shipped agent skills work against the testbench: antseed-images, antseed-decisions and antseed-videos request flows, join-buyer against a testbench gateway key, and the openclaw setup script answers one chat.

Status: planned, no scenario yet.

## What to test

- skills/antseed-images, antseed-videos, antseed-decisions, antseed-verify-model, join-buyer, hermes-antseed, openclaw-antseed

## What the testbench needs first

- the image, video, speech and decision mocks
- the gateway from gateway-key-flow
- ANTSEED_PROXY_URL pointed at the testbench proxy for each skill script

Targets: local, fork. Capabilities: mockControl.
