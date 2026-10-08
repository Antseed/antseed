# antseed-videos

Guided video generation through Antseed's local buyer proxy.

## Install

Antseed Desktop bundles this skill in chat. For other agents, install it with the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-videos
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent. You can also point an agent directly at [`SKILL.md`](SKILL.md).

## What it does

The skill walks the user through three approved gates before it pays for a video:

1. **Idea and model.** Feedback on the idea, and a recommended video model with alternatives.
2. **Script, prompts, and frames.** A short script, a video prompt written for the chosen model, first- and last-frame prompts, and frames made with a top-ranked image model through the `antseed-images` skill. Each frame is shown for approval.
3. **Settings and go.** A recap, then duration, resolution, audio, seller, and price before the paid create.

Video and image models are ranked by [LMArena](https://lmarena.ai)'s public blind-vote leaderboards (CC BY 4.0), read without an API key from the [Hugging Face dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) and cached for a day in `~/.antseed/cache/model-rankings.json`. Only the leaderboard is requested; nothing about the user's prompt or media leaves the machine. When the leaderboard is unreachable, a built-in snapshot is used. Set `ANTSEED_MODEL_RANKINGS=off` to disable the lookup.

Both `venice-video` and `fal-video` sellers are supported. After the user confirms, the skill pins only that create to one compatible seller as `<peerId>@<model>`; status and download requests go back to the seller that accepted the job. The buyer pays once, when the finished MP4 is delivered, and refuses any single video priced above $5.00.

For videos longer than one clip, the skill plans frame-matched segments and stitches them with ffmpeg. When all keyframes are ready, `antseed_video.mjs batch` submits creates one at a time and waits for accepted jobs in parallel.

## Prerequisites

Antseed Desktop or `antseed buyer start` must be running, normally at `http://127.0.0.1:8377`, and the buyer needs deposited USDC. Deposits can be funded by card where available, an exchange withdrawal, or another wallet. Node.js 18 or newer runs the helper script.

## Example

```text
Use the antseed-videos skill. I want a short video of a lighthouse keeper
watching a storm roll in at dusk.
```

See [`SKILL.md`](SKILL.md) for the agent workflow and safety rules.
