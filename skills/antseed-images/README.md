# antseed-images

Generate images from text prompts through Antseed's network-wide image model routing.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-images
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

Antseed Desktop or `antseed buyer start` must be running, and the buyer must have sufficient deposited USDC. The skill uses the local buyer proxy, normally at `http://127.0.0.1:8377`.

## Parameters

Provide the skill with:

- `model` — image model id or alias; optional when you want the skill to inspect the current catalog first
- `prompt` — image description

The skill first queries `/v1/models?type=images`, resolves the requested model against the returned ids and aliases, and sends the bare model id to `/v1/images/generations`. The buyer proxy applies the shared Price + Trust preferences and handles fallback between eligible sellers.

## Example prompt

```text
Use the antseed-images skill with:
model: gpt-image-2
prompt: A tiny ant astronaut planting a seed on Mars
```

See [SKILL.md](SKILL.md) for request, output, safety, and error-handling instructions.
