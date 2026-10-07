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

## Workflow

1. Run `node scripts/antseed_video.mjs models` to list current video models. Resolve the user's model against ids and aliases. If no model is chosen, show the relevant options and ask.
2. Run `node scripts/antseed_video.mjs options --model <id>` to inspect each seller's `capabilities.video` and pricing.
3. Ask only about advertised choices that matter: duration, resolution, aspect ratio, audio, start image, end image, and output path. Recommend the highest advertised resolution, but let the user choose.
4. Start and end images: use images the user supplied as local PNG, JPEG, or WebP files. Otherwise, when a seller supports frames, ask whether to supply images, generate them with `antseed-images`, or omit optional frames. Required inputs cannot be omitted. Prefer models that advertise the supplied inputs (`first_frame`, `last_frame`). If no seller supports a supplied end image, say so and offer alternatives; never silently drop it. In Antseed Desktop, call `get_chat_image_path` with the id from an `<uploaded-image id="...">` or `<generated-image id="...">` tag to get a local path.
5. For storyboard requests, draft the script and frame prompts first. Generate frames only after the user approves them, then show the saved frames (with `show_media` in Antseed Desktop) and ask for approval.
6. Run `node scripts/antseed_video.mjs select ...` with the exact choices. Show the model, choices, frames, seller, and estimated price, then ask for confirmation.
7. After confirmation, run `node scripts/antseed_video.mjs generate --peer <peerId> ...` with the same choices.
8. Longer than the longest advertised duration: plan frame-matched segments, show the plan and total price, get one confirmation, generate them, and stitch them with ffmpeg. When every approved segment already has its frames, use `batch` so jobs render in parallel. See "Long videos" in the workflow reference.

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
