---
slug: /videos
title: Generate videos with an agent
description: Install the antseed-videos skill so a coding agent or Antseed Desktop can plan, price, generate and edit videos through your local buyer, with an approval before every paid step.
---

# Generate videos with an agent

The [`antseed-videos` skill](https://github.com/AntSeed/antseed/tree/main/skills/antseed-videos) turns an agent into a video director. Ask for a video in plain words, and the agent shapes the idea, picks a model from the network, makes and shows you the first and last frames, and tells you the price before it creates anything. Nothing is paid for until you approve it.

It works with any video model sellers offer on the network, through both `venice-video` and `fal-video` sellers. Frames are made with its companion skill, [`antseed-images`](https://github.com/AntSeed/antseed/tree/main/skills/antseed-images).

## Before you start

- **A running buyer.** Antseed Desktop, or `antseed buyer start` from the CLI. The skill talks to the [local buyer proxy](/docs/api) at `http://127.0.0.1:8377`, or at `ANTSEED_PROXY_URL` when it is set.
- **Deposited USDC.** Fund the buyer by card where available, from an exchange withdrawal or from another wallet. See [Payments](/docs/payments).
- **`curl` and `jq`.** The skill makes every request with plain `curl` and builds JSON with `jq`. `ffmpeg` is used to join [multi-clip videos](#longer-videos), and `ffprobe` (part of `ffmpeg`) to read a source video for an [edit](#edit-a-video).

## Install

### Antseed Desktop

Antseed Desktop bundles both `antseed-videos` and `antseed-images`. Ask for a video in chat; there is nothing to install.

### Agent installation

Copy and paste this to your agent, such as Codex or Claude Code:

```text
Install this skill, help me set up Antseed, and generate my first video:
https://github.com/AntSeed/antseed/tree/main/skills/antseed-videos
```

### Self installation

Install both skills with the [GitHub CLI](https://cli.github.com/) v2.90.0 or later:

```bash
gh skill install Antseed/antseed antseed-videos
gh skill install Antseed/antseed antseed-images
```

Add `--scope user` to install a skill for every project your agent supports, or `--agent <agent>` to target one agent. You can also point an agent directly at the skill's [`SKILL.md`](https://github.com/AntSeed/antseed/blob/main/skills/antseed-videos/SKILL.md).

## Ask for a video

Once the skill is installed, ask for a video in your own words. A short idea is enough; the agent starts by shaping it with you, not by rendering.

```text
Use the antseed-videos skill. Make a surf video with ants.
```

```text
Animate these two images: start on first.png and end on last.png.
```

```text
Make a 20-second product video of this sneaker, keeping the shoe the same in every shot.
```

```text
Here's a clip of me dancing. Put this character in it instead of me.
```

## How it works

The agent works in three stages and ends each one with a question. It never starts the next stage, or spends money, until you answer.

| Stage | What the agent does | What you approve |
|---|---|---|
| **1. Idea and model** | Reads the live video catalog, gives an honest take on the idea with an improved version, and recommends a model that takes a first frame (and a last frame when possible), with three to five alternatives. | The idea and the model. |
| **2. Prompts and frames** | Writes the video prompt in the style the chosen model responds to best, plus first- and last-frame prompts. Proposes the aspect ratio and a strong image model, with its price per image. Then makes each frame and shows it. | The prompts and the frame cost, then each frame. Ask for a redo until a frame is right. |
| **3. Settings and price** | Recaps the frames and final prompt, offers only the durations and resolutions the model advertises, and prices every seller that supports your choices. | The final line: model, duration, resolution, ratio and price. |

After you say go, the agent creates the video once, waits for it (usually 1 to 10 minutes) and saves the MP4. In Antseed Desktop the video plays in the chat; elsewhere the agent gives you its path, with the model, duration, resolution and price.

If you say "you decide", the agent fills in its own recommendations, but it still shows you the frames and still asks before the paid video.

### Your own images

- **Frames you already have:** upload or name them, and the agent skips making frames. It confirms which is first and which is last.
- **A character, product or style to keep consistent:** the agent recommends a reference-to-video model and uses your images as references. The video then won't start on any one image.
- **No frames at all:** ask to skip them and the agent uses a text-to-video model, but says the look may drift.

## Edit a video

Bring a video and ask for a change: put a different person or character in it, restyle it, or change one thing. The agent uses a video edit (video-to-video) model instead of the three stages above. The source keeps its motion, timing and camera; the model changes only what you ask for.

1. **Source.** The agent reads the video's length, size and frame rate with `ffprobe`. MOV files are repackaged as MP4 without re-encoding; WebM, VP9 and AV1 sources are re-encoded to H.264.
2. **Model and limits.** The agent lists the edit models on the network and recommends one: MiniMax H3 Max Recast or Kling motion control to swap a person or character, Kling edit or Wan edit for a text instruction. It then checks your video against that model's published limits and shows you each check and where it comes from. If the video fails one, it offers a fix (trim, scale up, re-encode) and checks again.
3. **Character and prompt.** For a swap, you give or approve one clear image per person to replace, left to right as they appear, plus the prompt.
4. **Price and go.** An edit is priced on the source's length in whole seconds. To pay for less, trim the source first. The agent shows the price per seller and asks before it creates anything.

Edits take longer than new videos; Recast can take 15 minutes or more. Recast and motion control need a real person in the source: a video of an animal, a cartoon or an empty scene comes back unchanged or fails. Sellers pass the video to the upstream without checking it, which is why the agent checks it first.

## What you pay

- **Frames** are ordinary image requests, charged per image when they are made. The agent quotes the image model's price before making them.
- **The video** is charged once, when the finished MP4 is first delivered. Checking a job's status costs nothing, and downloading the same video again does not charge again.
- **A video that fails** costs nothing when it is priced at $1.00 or less. Above $1.00, a create the seller or upstream refuses, or a job that fails, costs the payment channel's opening fee ($0.65 on Base). A create the buyer refuses itself, such as one above the price limit, costs nothing.
- **No single video above $5.00.** The buyer refuses it by default (`payments.maxVideoRequestUsdc`). Pick a shorter duration or lower resolution.

The agent sends the create to the cheapest seller that supports your settings, as `<peerId>@<model>`. If that seller fails, it offers the next one from the price list and asks first; it does not switch sellers or models on its own.

## Interrupted jobs

Right after the create, the agent writes a job file next to the video (`<name>.job.json`). If the chat or the wait is interrupted, ask the agent to continue: it resumes the saved job instead of creating, and paying for, a second video. A job file blocks any new create with the same output name until the video is saved, or until you approve a retry.

## Longer videos

For a video longer than the model's longest clip, the agent plans it as several clips in Stage 3 and prices each one up front. It makes them one at a time, each starting from the last frame of the clip before, and joins them with `ffmpeg`. Each clip is its own approved, paid video.

## Troubleshooting

| Problem | What to do |
|---|---|
| Connection refused | Start Antseed Desktop or `antseed buyer start`. |
| `402` | The buyer needs more deposited USDC or payment-channel capacity. See [Payments](/docs/payments). |
| `402 one_off_channel_required` | Update the buyer; versions before `@antseed/cli@0.1.171` hit this. |
| Price above $5.00, or "above the configured limit" | Choose a shorter duration or a lower resolution. |
| `400` on create | The seller rejected a field, named in the error. Nothing started; the agent fixes the field and asks before trying again. Above $1.00, the opening fee is kept. |
| `422 invalid_video_duration` | An edit's `duration` must be the source's length in whole seconds, rounded down. The agent corrects it and asks before trying again. |
| `video_not_delivered` | The seller says the job finished but sent no video. Nothing was charged; the agent offers the next seller. |

The skill's [request reference](https://github.com/AntSeed/antseed/blob/main/skills/antseed-videos/references/requests.md#errors) lists every error and what the agent does about it.

## Without the skill

The skill drives the buyer's video routes, which any client can call. Through a gateway, see [Calling the API](/docs/gateway/api#supported-routes) for the video job routes. To sell video generation, see [Image and video services](/docs/provide/media).
