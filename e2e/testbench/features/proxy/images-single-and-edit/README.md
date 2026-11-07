# images-single-and-edit

One /v1/images/generations request is charged images x price; a multipart /v1/images/edits with fixtures/pixel.png routes only to a seller that takes image input and is charged per image.

Status: planned, no scenario yet.

## What to test

- single image generation charge (packages/protocol/src/billing.ts output_images)
- /v1/images/edits multipart, required parameters, image-input routing (plugins/provider-openai/src/venice-image-edit.ts)
- a non-image seller is never picked for an edit

## What the testbench needs first

- a mock /v1/images/edits endpoint
- multipart support in tb.request()
- an image-input capability on mock seller services (topology services.capabilities)

Targets: local, fork. Capabilities: mockControl.
