# video-fal-avatar

fal video queue and retrieve: a talking-avatar job with audio_url is charged by audio length; a source-length mismatch is refused before payment; Alibaba Model Studio speaks the same fal-video protocol.

Status: planned, no scenario yet.

## What to test

- /fal/v1/video/queue and /retrieve (plugins/provider-fal-video, plugins/provider-alibaba-video)
- avatar pricing by audio duration (WAV block alignment check)
- refusal before payment on invalid video options

## What the testbench needs first

- a mock fal queue API with job states and a fixture video
- a fixture WAV with known duration
- video and avatar services in the topology

Targets: local, fork. Capabilities: mockControl.
