# antseed-images

Generate images from text prompts, or edit and combine existing images, through Antseed's network-wide image model routing.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-images
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

Antseed Desktop, another Antseed gateway, or `antseed buyer start` must be running, and the buyer must have sufficient deposited USDC. The skill uses the gateway in `ANTSEED_PROXY_URL`, with the key in `ANTSEED_API_KEY`. Antseed Desktop sets them for the copies it adds to an agent; otherwise set them yourself. Without them the skill stops and asks which gateway to use; to use your own CLI buyer, set `ANTSEED_PROXY_URL=http://127.0.0.1:8377`.

## Parameters

Provide the skill with:

- `model` — image model id or alias; optional when you want the skill to inspect the current catalog first
- `prompt` — image description, or what to change in an edit
- `images` — optional input images to edit, base image first

The skill first queries `/v1/models?type=images`, resolves the requested model against the returned ids and aliases, and sends the bare model id to `/v1/images/generations`, or with input images to `/v1/images/edits`. The buyer proxy applies the shared Price + Trust preferences and handles fallback between eligible sellers.

## Example prompt

```text
Use the antseed-images skill with:
model: gpt-image-2
prompt: A tiny ant astronaut planting a seed on Mars
```

Editing example:

```text
Use the antseed-images skill with:
model: qwen-image-3-pro
images: sofa.png, cat.png
prompt: Put the cat from the second image on the sofa
```

See [SKILL.md](SKILL.md) for request, output, safety, and error-handling instructions.
