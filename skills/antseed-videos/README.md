# antseed-videos

Generate videos from text prompts or images through Antseed's network-wide video model routing.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-videos
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

Antseed Desktop or `antseed buyer start` (`@antseed/cli@0.1.171` or newer) must be running, and the buyer must have enough deposited USDC for the video. The skill uses the local buyer proxy, normally at `http://127.0.0.1:8377`.

## Parameters

Provide the skill with:

- `model` — video model id or alias; optional when you want the skill to inspect the current catalog first
- `prompt` — video description
- `duration`, plus `resolution` and `aspect_ratio` when the model advertises them
- `image` — optional starting frame for image-to-video models

The skill queries `/v1/models?type=videos`, reads the chosen model's advertised durations, resolutions and prices, quotes the price, queues the job (`venice-video` or `fal-video` format), polls until the MP4 is ready, and saves it. You pay once, when the finished video is delivered.

## Example prompt

```text
Use the antseed-videos skill with:
model: gemini-omni-flash-1-1-text-to-video
prompt: A tiny ant carrying a glowing seed across a mossy forest floor
duration: 4
resolution: 360p
aspect_ratio: 16:9
```

See [SKILL.md](SKILL.md) for request, polling, pricing, safety, and error-handling instructions.
