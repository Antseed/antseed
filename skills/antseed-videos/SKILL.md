---
name: antseed-videos
description: Generates videos through the user's local Antseed buyer proxy by discovering video models, confirming supported options, using user-supplied or generated start and end images, chaining frame-matched segments for videos longer than one clip, and pinning one compatible seller per paid job. Use when the user asks Antseed to create, generate, animate, storyboard, extend, or make a video, or supplies start or end images for one.
---

# Antseed Videos

Create videos through the user's local Antseed buyer proxy. Video options are seller-specific, and a paid create must never be guessed or silently retried elsewhere.

## Prerequisites

- Antseed Desktop or `antseed buyer start` is running; default proxy: `$ANTSEED_PROXY_URL`, then `http://127.0.0.1:8377`.
- The buyer has enough deposited USDC. Deposits can be funded by card where available, an exchange withdrawal, or another wallet.
- Node.js 18+ runs `scripts/antseed_video.mjs` (no packages to install). Antseed Desktop provides `node` in chat, and the `antseed` CLI already requires Node.js. `ffmpeg` is needed only for long videos (frame extraction and stitching); if it is missing, tell the user before planning segments.

## Conversation flow

Lead the user through these turns. Always ask; do not fill gaps with your own defaults. Each turn waits for the user's answer. Skip a turn only when the user already answered it in this chat.

1. **What video, which model.** Run `node scripts/antseed_video.mjs models`. In one message, ask what the video should show, and list the video models found on the network. For each model, give the advertised durations, resolutions, whether it takes start or end images, and audio support, from the `video` field. If no video model is found, say so and stop. Even when the user named a model, confirm it against this list and resolve it by id or alias.
2. **Model-specific inputs.** Run `node scripts/antseed_video.mjs options --model <id>`. Also check other variants of the same family, such as `-text-to-video-`, `-image-to-video-`, and first-last-frame models. Then tell the user what this model takes, for example: "Seedance takes a start shot and an end shot. You can upload them, or I can find an image model on the network and generate them." To offer generation, run `node scripts/antseed_video.mjs image-models` and name the image models available. When start and end images will be used, prefer a first-last-frame or image-to-video variant over text-to-video.
3. **Settings.** Ask, in one message, only about settings the sellers advertise: duration, resolution (recommend the highest), aspect ratio, and audio when `audio: true`. Show the advertised values as options. If the requested length is longer than the longest clip, offer a segment plan (see "Long videos" in the workflow reference).
4. **Frames.** If images will be generated, show the frame prompts, the image model, and the image cost plus video cost, and ask for approval. Generate the frames with `antseed-images`, show each saved frame (in Antseed Desktop, use `show_media`), and get approval. If the user supplied images, get their paths (in Antseed Desktop, use `get_chat_image_path` with the `<uploaded-image id>` or `<generated-image id>`). Ask which image is the start and which is the end when that isn't clear. Use text-to-video only when the user says to skip images or no compatible model accepts frames. In that case, say plainly that text-only shots may not keep the same subject or look across segments.
5. **Confirm.** Run `node scripts/antseed_video.mjs select ...` with the exact choices. Show the model, settings, frames, seller, and estimated price, then ask for confirmation. Required inputs cannot be omitted. If no seller supports a choice, show the alternatives and ask; never drop an option silently.
6. **Generate.** After confirmation, run `node scripts/antseed_video.mjs generate --peer <peerId> ...` with the same choices. For an approved segment plan where every segment already has its frames, run `batch` so the jobs render in parallel, then stitch the clips with ffmpeg.

Read [references/workflow.md](references/workflow.md) for question flow, frame handling, long videos, command examples, and errors. Read [references/venice.md](references/venice.md) only when request fields or response behavior need checking.

## Invariants

- Pin only the paid create, as `<peerId>@<model>`, after filtering compatible sellers. Never change the proxy's session pin, default route, chat model, or state files.
- Pass the selected seller from `select` to `generate --peer`; `generate` checks it again before paying.
- Create one video unless the user asks for more or approves a segment plan. Submit creates one at a time, then let accepted jobs render in parallel.
- If the user asks for a test, the first segment, or only some segments, generate only those.
- Never move a create to another seller automatically. After an unclear create failure, check with the user before creating again, because a second create can start a second paid job.
- Status checks and downloads use the accepted job id and must not create jobs.
- Do not invent unsupported options or silently lower quality. Send an audio setting only when the seller advertises `audio: true`.
- Never print or paste tokens, auth headers, base64 media, signed media URLs, private keys, or full API responses.
- Keep the buyer proxy on loopback.
- Report the saved MP4 path, model, seller, and job id. In Antseed Desktop, call `show_media` with the saved path so it plays in the chat; elsewhere, show it when the agent environment supports video.
