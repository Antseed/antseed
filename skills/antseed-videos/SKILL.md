---
name: antseed-videos
description: Directs video creation through the user's local Antseed buyer proxy in three approved gates — idea and model, script with first and last frames, then settings and price — using leaderboard-ranked video and image models, prompts tuned to the chosen model, and one pinned seller per paid job. Use when the user asks Antseed to create, generate, animate, storyboard, extend, or make a video, or supplies start or end images for one.
---

# Antseed Videos

Act as the user's video director. Help shape the idea, recommend the best models, make and show the frames, and only then pay for the video. Do not rush to generate.

## Prerequisites

- Antseed Desktop or `antseed buyer start` is running; default proxy: `$ANTSEED_PROXY_URL`, then `http://127.0.0.1:8377`.
- The buyer has enough deposited USDC. Deposits can be funded by card where available, an exchange withdrawal, or another wallet. The buyer refuses any single video priced above $5.00.
- Node.js 18+ runs `scripts/antseed_video.mjs` (no packages to install). Antseed Desktop provides `node` in chat. `ffmpeg` is needed only for multi-clip videos.

## The three gates

Work through the gates in order. End every gate with a question and wait for the user's answer. Never start the next gate, and never spend money, before the user approves the current one. Skip a step only when the user already gave that answer in this chat.

### Gate 1 — Idea and model

1. Run `node scripts/antseed_video.mjs models`. Models come ranked by LMArena's blind-vote leaderboard; `recommended` is the best-ranked model on the network that takes a start frame.
2. Give a short, honest take on the idea: what will work on screen, what is missing, and one or two ways to make it stronger.
3. Recommend one video model and say why: its rank, that it takes a start (and end) frame, its durations and audio. Then list three to five alternatives in one line each. Prefer `tier: "top"` models that take frames.
4. Ask: "Does the sharpened idea work for you? Shall I use **<model>**, or another one from the list?"

### Gate 2 — Script, prompts, and frames

This gate has two approvals, because frames cost money.

**2a. Script and prompts (free).**

1. Run `node scripts/antseed_video.mjs options --model <id>` to see the exact frame inputs, aspect ratios, durations, and resolutions.
2. Write a short script: shots, action, camera, mood.
3. Write the video prompt in the style the chosen model responds to best (see [references/prompting.md](references/prompting.md)).
4. Write the first-frame prompt, and a last-frame prompt when the model takes `last_frame`.
5. Run `node scripts/antseed_video.mjs image-models` and recommend its `recommended` image model with its rank and price per image.
6. Ask for the aspect ratio now, because frames must be made at the video's shape.
7. Paste the script and every prompt in full. Ask: "Change anything? Shall I make the frames with **<image model>** for about $<cost>?"

**2b. Frames (paid).**

1. Generate the frames with the `antseed-images` skill and the approved image model, at the approved aspect ratio.
2. Show each saved frame (in Antseed Desktop, call `show_media`).
3. Ask: "Is the first frame right, or should I redo it? And the last frame?" Redo a frame, with an adjusted prompt if needed, until the user approves both.

If the user uploads their own frames, skip making them: get their paths (in Antseed Desktop, `get_chat_image_path`), show them, and confirm which is first and which is last. If the model takes only a start frame, make one frame. Use a text-only model only when the user asks to skip frames or no ranked model takes them; then say that the look may not stay consistent.

### Gate 3 — Recap, settings, and go

1. Recap in one message: first frame, last frame, and the final video prompt.
2. Ask for the settings the sellers advertise: duration, resolution (recommend the highest), and audio only when `audio: true`. Show only advertised values.
3. Run `node scripts/antseed_video.mjs select ...` with the exact choices. Show the model, seller, settings, frames, and estimated price.
4. Ask: "Total $<price> with seller <seller>. Go?"

### Generate

After "go", run `node scripts/antseed_video.mjs generate --peer <peerId> ...` with the same choices. For an approved multi-clip plan whose frames are all ready, run `batch` so the jobs render in parallel, then stitch the clips with ffmpeg. Show the finished video.

If the user says "just make it" or "you decide", you may fill in your recommendations for them, but still show the frames and still ask before the paid video in Gate 3.

Read [references/workflow.md](references/workflow.md) for commands, multi-clip plans, and errors, and [references/venice.md](references/venice.md) only when request fields need checking.

## Model quality rules

- Use only `tier: "top"` image models for frames unless the user picks another one. Never pick an unranked or cheap image model on your own.
- Recommend video models by rank. When `match` is `family`, the score belongs to the base model; say so (for example "a faster tier of Seedance 2.0").
- Cite the ranking briefly: "#1 on LMArena's image leaderboard (published <date>)". If `source` is `snapshot` or the ranking is stale, say the ranking may be out of date.

## Invariants

- Pin only the paid create, as `<peerId>@<model>`, after filtering compatible sellers. Never change the proxy's session pin, default route, chat model, or state files.
- Pass the selected seller from `select` to `generate --peer`; `generate` checks it again before paying.
- Create one video unless the user asks for more or approves a multi-clip plan.
- Never move a create to another seller automatically. After an unclear create failure, ask before creating again, because a second create can start a second paid job.
- Status checks and downloads use the accepted job id and never create jobs.
- Do not invent unsupported options or silently lower quality. Send an audio setting only when the seller advertises `audio: true`.
- Never print tokens, auth headers, base64 media, signed media URLs, private keys, or full API responses.
- Keep the buyer proxy on loopback.
- Report the saved MP4 path, model, seller, and job id. In Antseed Desktop, call `show_media` with the saved path so it plays in chat.
