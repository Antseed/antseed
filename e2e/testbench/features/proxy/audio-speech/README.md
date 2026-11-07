# audio-speech

/v1/audio/speech: audio bytes come back unchanged, the charge is input characters x price, and an unsupported voice is refused with 400 before any SpendingAuth.

Status: planned, no scenario yet.

## What to test

- /v1/audio/speech unit billing by input_characters (packages/buyer-core/src/unit-billing.ts, plugins/provider-openai/src/speech.ts)
- seller voice pre-check 400 unsupported_voice before payment (packages/node/src/seller-request-handler.ts)
- binary response passthrough

## What the testbench needs first

- a mock /v1/audio/speech endpoint returning audio bytes and voice errors
- speech services in the testbench topology
- tb.request() with binary bodies

Targets: local, fork. Capabilities: mockControl.
