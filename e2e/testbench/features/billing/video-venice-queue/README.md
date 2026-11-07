# video-venice-queue

Venice native video: queue, poll, download; exactly one charge once a full MP4 (at least 0.9 of the duration) is delivered; an unknown job gets 404 video_route_not_found.

Status: planned, no scenario yet.

## What to test

- /api/v1/video/queue and /retrieve through the proxy (packages/api-adapter/src/native-video.ts, apps/cli/src/proxy/native-video-proxy.ts)
- video_seconds / video_generations billing on delivery
- retrieve pinned to the accepting seller; failed jobs retired

## What the testbench needs first

- a mock Venice video API (queue, status, download with a fixture MP4)
- provider-venice-video in the seller worker plugin table
- video services in the topology
- tb.request()

Targets: local, fork. Capabilities: mockControl.
