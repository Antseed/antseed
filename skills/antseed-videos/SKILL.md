---
name: antseed-videos
description: Directs video creation through the user's local Antseed buyer proxy in three approved stages — idea and model, prompts plus first and last frames, then settings and price — with prompts tuned to the chosen model and frames made with a strong image model. Uses plain curl and jq. Use when the user asks Antseed to create, generate, animate, or make a video, or supplies start or end images for one.
---

# Antseed Videos

Act as the user's video director. Do not rush to generate: shape the idea, pick a strong model, make and approve the frames, and only then pay for the video. A short request such as "make a surf video with ants" starts Stage 1, not a render.

## Prerequisites

- Antseed Desktop or `antseed buyer start` is running. Buyer URL: `$ANTSEED_PROXY_URL` when set, otherwise `http://127.0.0.1:8377`.
- The buyer has deposited USDC. Deposits can be funded by card where available, an exchange withdrawal, or another wallet. The buyer refuses any single video above $5.00.
- `curl` and `jq`. Frames are made with the `antseed-images` skill.

The exact commands are in [references/requests.md](references/requests.md). Model choices and prompt styles are in [references/prompting.md](references/prompting.md).

## The three stages

End every stage with a question and wait for the answer. Never start the next stage, and never spend money, before the user approves the current one. Skip a step only when the user already answered it in this chat. If the user says "you decide", fill in your recommendations, but still show the frames and still ask before the paid video.

### Stage 1 — Idea and model

1. Fetch the video catalog (`/v1/models?type=videos`).
2. Give a short, honest take on the idea: what will work on screen, what is missing, and one or two ways to make it stronger. Offer an improved one-paragraph version of the idea.
3. Recommend one video model that takes a first frame (and a last frame when possible) and say why, following [references/prompting.md](references/prompting.md#choosing-models). List three to five alternatives from the catalog, one line each, using only what the catalog shows.
4. Ask: "Does this version of the idea work for you? Shall I use **<model>**, or another one from the list?"

### Stage 2 — Prompts and frames

This stage has two approvals, because frames cost money.

**2a. Prompts (free).**

1. Fetch the chosen model's offers (`/v1/models/<id>`) to see its frame inputs, durations, resolutions, and aspect ratios.
2. Write the video prompt in the style the chosen model responds to best ([references/prompting.md](references/prompting.md)).
3. Write the first-frame prompt, and a last-frame prompt when the model takes `last_frame`. Both share one style phrase so the look stays consistent.
4. Propose the aspect ratio. The frames decide the video's shape, so it is fixed here.
5. Recommend a strong image model for the frames from the image catalog (`/v1/models?type=images`), with its price per image. Never pick a weak or unknown image model on your own.
6. Paste the video prompt and every frame prompt in full. Ask: "Change anything? Shall I make the frames with **<image model>** at <ratio> for about $<cost>?"

**2b. Frames (paid).**

1. Generate each frame with the `antseed-images` skill and the approved image model. Check the saved frame's shape with `frame_size` ([references/requests.md](references/requests.md#frame-shape)), not by opening the image; if it does not match the agreed ratio, tell the user and either redo it or use the frame's ratio.
2. Show each saved frame: in Antseed Desktop, call `show_media`; elsewhere, give its path.
3. Ask: "Is the first frame right, or should I redo it? And the last frame?" Redo a frame, with an adjusted prompt if needed, until the user approves.

If the user uploads frames, skip making them: get their paths (in Antseed Desktop, `get_chat_image_path`), show them, and confirm which is first and which is last. Use a text-to-video model (catalog with `frames=no`) only when the user asks to skip frames; say that the look may drift.

### Stage 3 — Recap, settings, and go

1. Recap in one message: the first frame, the last frame, and the final video prompt in full.
2. Ask for duration and resolution, showing only the values the model advertises. Recommend the highest resolution that keeps the price reasonable. Confirm the aspect ratio from Stage 2.
3. Compute the price for each compatible seller ([references/requests.md](references/requests.md#price)).
4. Ask: "<model>, <duration> s, <resolution>, <ratio>: $<price>. Go?"

### Generate

After "go", queue the video once, save the job file, wait, and save the MP4 ([references/requests.md](references/requests.md)). Show the finished video (in Antseed Desktop, call `show_media`) and report the path, model, duration, resolution, and price.

## Rules

- **One create per approved video.** Right after the create, write the job file. If a job file exists, resume it; never create again without asking. Videos are charged when the finished MP4 is delivered, so a failed or rejected create costs nothing, but a repeated create wastes the seller's upstream cost, holds deposited USDC for a while, and is charged too if it is also downloaded.
- Status checks and downloads use the saved job id and never create jobs.
- Send only values the seller advertises. Never send `audio: true`: models with audio make sound by default, and some fail the job when `audio` is set. Send `audio: false` only when the user wants a silent video.
- Always send the create to the chosen seller, as `<peerId>@<model>` (the cheapest compatible seller from the price step).
- After a failed create or job, read `error.peer_message` and fix the field it names. Do not switch models or sellers on your own; ask first. Before an approved retry, rename `<name>.job.json` to `<name>.failed.job.json`.
- Never print base64 media, signed URLs, authorization headers, private keys, or full API responses. Keep the buyer proxy on loopback.
- Pass frames and reference images by path. Do not open them with a file-reading tool unless the user asks you to look at one: every image read stays in the chat and is resent on each turn, and a few of them can make later requests too large to send or compact.
