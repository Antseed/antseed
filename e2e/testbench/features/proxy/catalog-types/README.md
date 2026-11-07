# catalog-types

/v1/models?type=text|images|decisions|videos|speech|routers lists exactly the matching testbench services.

Status: planned, no scenario yet.

## What to test

- network catalog type filters (apps/cli/src/proxy/network-models.ts)
- offer types text, image, decision, video, speech, router (packages/node/src/discovery/service-catalog.ts)

## What the testbench needs first

- mock sellers offering image, video, speech, decision and router services in one topology

Targets: local, fork. Capabilities: mockControl.
