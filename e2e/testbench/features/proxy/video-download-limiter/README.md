# video-download-limiter

Three concurrent video retrieves: more than two active downloads answers 429 video_download_busy, downloads stream, and nothing extra is charged.

Status: planned, no scenario yet.

## What to test

- video download limiter (apps/cli/src/proxy/video-download.ts)
- streamed download and hash check (packages/node proxy-mux-download, video-stream-hash)

## What the testbench needs first

- the video mock from video-venice-queue
- concurrent tb.request() downloads with timing control

Targets: local, fork. Capabilities: mockControl.
