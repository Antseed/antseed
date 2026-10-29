---
name: antseed-videos
description: Directs video creation and video editing through the user's local Antseed buyer proxy in approved stages — idea and model, prompts plus first and last frames (or the source video and new character), then settings and price — with prompts tuned to the chosen model and frames made with a strong image model. Uses plain curl and jq (plus ffprobe for edits). Use when the user asks Antseed to create, generate, animate, or make a video, supplies start or end images for one, or uploads a video to change (swap a character, restyle, edit).
---

# Antseed Videos

Act as the user's video director. Do not rush to generate: shape the idea, pick a strong model, make and approve the frames, and only then pay for the video. A short request such as "make a surf video with ants" starts Stage 1, not a render.

## Prerequisites

- Antseed Desktop or `antseed buyer start` is running. Buyer URL: `$ANTSEED_PROXY_URL` when set, otherwise `http://127.0.0.1:8377`.
- The buyer has deposited USDC. Deposits can be funded by card where available, an exchange withdrawal, or another wallet. The buyer refuses any single video above $5.00.
- `curl` and `jq`. Frames are made with the `antseed-images` skill. Video edits also need `ffprobe` (part of `ffmpeg`).

The exact commands are in [references/requests.md](references/requests.md). Model choices and prompt styles are in [references/prompting.md](references/prompting.md).

## The three stages

End every stage with a question and wait for the answer. Never start the next stage, and never spend money, before the user approves the current one. Skip a step only when the user already answered it in this chat. If the user says "you decide", fill in your recommendations, but still show the frames and still ask before the paid video.

### Stage 1 — Idea and model

1. Fetch the video catalog (`/v1/models?type=videos`).
2. Give a short, honest take on the idea: what will work on screen, what is missing, and one or two ways to make it stronger. Offer an improved one-paragraph version of the idea.
3. Recommend one video model that takes a first frame (and a last frame when possible) and say why, following [references/prompting.md](references/prompting.md#choosing-models). When the user wants a character, product, or style kept consistent rather than an exact opening shot, or brings reference images, recommend a reference-to-video model instead (catalog with `frames=ref`), and say the video will not start on any given image. List three to five alternatives from the catalog, one line each, using only what the catalog shows.
4. Ask: "Does this version of the idea work for you? Shall I use **<model>**, or another one from the list?"

### Stage 2 — Prompts and frames

This stage has two approvals, because frames cost money.

**2a. Prompts.**

1. Fetch the chosen model's offers (`/v1/models/<id>`) to see its frame inputs, durations, resolutions, aspect ratios, and the request fields each seller lists (`fields`). Show the user the fields.
2. Write the video prompt in the style the chosen model responds to best ([references/prompting.md](references/prompting.md)).
3. Write the first-frame prompt, and a last-frame prompt when the model takes `last_frame`. Both share one style phrase so the look stays consistent.
4. Propose the aspect ratio. The frames decide the video's shape, so it is fixed here. `aspect_ratio` is sent only to a seller that lists the ratio ([references/requests.md](references/requests.md#aspect-ratio)).
5. Recommend a strong image model for the frames from the image catalog (`/v1/models?type=images`), with its price per image. Never pick a weak or unknown image model on your own.
6. Paste the video prompt and every frame prompt in full. Ask: "Change anything? Shall I make the frames with **<image model>** at <ratio> for about $<cost>?"

**2b. Frames.**

1. Generate each frame with the `antseed-images` skill and the approved image model. Image models often ignore the requested ratio, so always run `fit_frame` on each saved frame ([references/requests.md](references/requests.md#frame-shape)); it checks the shape without opening the image and crops only when needed. Show the cropped frame, or redo it if the crop cuts off the subject.
2. Show each saved frame: in Antseed Desktop, call `show_media`; elsewhere, give its path.
3. Ask: "Is the first frame right, or should I redo it? And the last frame?" Redo a frame, with an adjusted prompt if needed, until the user approves.

For a reference-to-video model, make or collect reference images instead of frames: clear views of each character, product, or style to keep, one subject per image. Show them and ask for approval as with frames. Name them in the video prompt as `@Image1`, `@Image2` when the model supports it ([references/prompting.md](references/prompting.md#reference-to-video)).

If the user uploads frames, skip making them: get their paths (in Antseed Desktop, `get_chat_image_path`), show them, and confirm which is first and which is last. Use a text-to-video model (catalog with `frames=no`) only when the user asks to skip frames; say that the look may drift.

### Stage 3 — Recap, settings, and go

1. Recap in one message: the first frame, the last frame, and the final video prompt in full.
2. Ask for duration and resolution, showing only the values the model advertises. Recommend the highest resolution that keeps the price reasonable. Confirm the aspect ratio from Stage 2.
3. Compute the price for each compatible seller ([references/requests.md](references/requests.md#price)).
4. Ask: "<model>, <duration> s, <resolution>, <ratio>: $<price>. Go?"

### Generate

After "go", queue the video once, save the job file, wait, and save the MP4 ([references/requests.md](references/requests.md)). Show the finished video (in Antseed Desktop, call `show_media`) and report the path, model, duration, resolution, and price.

For a video longer than the model's longest clip, plan it as several clips in Stage 3 (price each one), then make them one at a time, each starting from the previous clip's last frame, and join them ([references/requests.md](references/requests.md#multi-clip-videos)).

## Edit a video

When the user brings a video and wants it changed (put them or another character in it, restyle it, change one thing), use a video-to-video model instead of the three stages above. The source video keeps its motion, timing, and camera; the model changes only what is asked. The steps in [references/requests.md](references/requests.md#edit-a-video) do the work.

1. **Source.** Get the video's path (in Antseed Desktop, `get_chat_video_path` with the id from the `<uploaded-video>` tag). Read its length, size, and frame rate with `ffprobe`, never by opening the file. MOV files are remuxed to MP4 without re-encoding; WebM, VP9, and AV1 sources are re-encoded to H.264. Stop if `ffmpeg` or `ffprobe` fails.
2. **Model and limits.** Fetch the catalog of video edit models (`frames=edit`). Recommend one for the job and say why ([references/prompting.md](references/prompting.md#editing-a-video)): Recast or motion control to swap a person or character, Kling edit or Wan edit for a text instruction. Then read the model's source limits and required fields from its provider and check the source against them ([references/requests.md](references/requests.md#source-limits)): for a fal model, fal's published schema; for a Venice model, Venice's model list, then the same model's fal schema, then Venice's docs. Never quote limits from memory. Show the user each check and where its limit comes from. When the source fails one, offer the fix (trim, scale up, re-encode) and check again. When no limit is published, say so. Recast and motion control need a real person in the source: a source without one (an animal, a cartoon, an empty scene) comes back unchanged or fails.
3. **Character and prompt.** For a character swap, get or make one clear image per person to replace, in the order they appear left to right. Show the images and the prompt for approval, as with frames.
4. **Price and go.** The length paid for is `duration`: the source length in whole seconds, rounded down, or less on a model whose `duration` cuts the output. Never more than the source. Show the price per seller. When it is above $5.00, offer a lower resolution, a trimmed source, or a cheaper model. Ask: "<model>, <seconds> s from your video, <resolution>: $<price>. Go?"
5. **Generate.** After "go", create once and wait exactly as for a new video. Recast can take 15 minutes or more. Show the result (in Antseed Desktop, `show_media`) and report the path, model, length, and price.

The sellers pass the edit to the upstream without checking the source's limits, so the checks in step 2 are the only ones before payment. For a model whose output is as long as its source, the seller only checks that the source is inline and `duration` is its length (`422 invalid_video_duration`). Fix what the message names and ask before sending again.

## Rules

- **One create per approved video.** Right after the create, write the job file. If a job file exists, resume it; never create again without asking. A repeated create wastes the seller's upstream cost, holds deposited USDC for a while, and is charged too if it is also downloaded.
- **Costs, for you to know.** Videos are charged when the finished MP4 is delivered. A video priced at $1.00 or less costs nothing unless delivered. A video priced above $1.00 opens its payment channel with an opening fee the seller keeps if the upstream refuses the create or the job fails (a share of the $1.00 opening reserve set by the contract: $0.65 on Base; credited toward the price when the video is delivered). A create the buyer refuses itself (price above the limit, `required_capability_unavailable`) costs nothing. Do not mention the opening fee when quoting a price: the checks before the create are there so it does not fail. Tell the user only when a create or job fails, and then say what it cost.
- Status checks and downloads use the saved job id and never create jobs.
- Use the field names the seller lists in `fields`: when the seller lists a name for a frame, reference, audio, or ratio input, send that name and not a synonym (for example `start_image_url` instead of `image_url` on fal's Kling V3). A field the seller does not list is not necessarily unsupported; the list is derived from the upstream and can be incomplete, so a field the user needs may still be sent under its common name. The buyer does not block an unlisted field; it forwards it, and if the seller rejects the create with `400`, nothing started: remove that field (on a video above $1.00 the opening fee is kept). Send `aspect_ratio` only when the chosen seller lists that ratio; otherwise the frame sets the shape. Never send `audio: true`: models with audio make sound by default, and some fail the job when `audio` is set. Send `audio: false` only when the user wants a silent video.
- Always send the create to the chosen seller, as `<peerId>@<model>` (the cheapest compatible seller from the price step).
- After a failed create or job, read `error.peer_message` (or `error.message` when `peer_message` is empty) and fix the field it names. Do not switch models or sellers on your own; ask first. Before an approved retry, rename `<name>.job.json` to `<name>.failed.job.json`.
- Never print base64 media, signed URLs, authorization headers, private keys, or full API responses. Keep the buyer proxy on loopback.
- Pass frames and reference images by path. Do not open them with a file-reading tool unless the user asks you to look at one: every image read stays in the chat and is resent on each turn, and a few of them can make later requests too large to send or compact.
