# antseed-videos

Guided video generation through Antseed's local buyer proxy, with plain `curl` and `jq`.

## Install

Antseed Desktop bundles this skill in chat. For other agents, install it with the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-videos
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent. You can also point an agent directly at [`SKILL.md`](SKILL.md).

## What it does

The skill walks the user through three approved stages before it pays for a video:

1. **Idea and model.** Feedback on the idea, an improved version, and a recommended video model that takes first and last frames, with alternatives.
2. **Prompts and frames.** A video prompt written for the chosen model, first- and last-frame prompts, and frames made with a strong image model through the `antseed-images` skill. Each frame is shown for approval.
3. **Settings and go.** A recap, then duration, resolution, and the price before the create.

Both `venice-video` and `fal-video` sellers are supported. The skill writes a job file right after the create, so an interrupted wait resumes instead of creating another video. The buyer pays once, when the finished MP4 is delivered, and refuses any single video priced above $5.00.

## Files

- [`SKILL.md`](SKILL.md): the three stages and rules.
- [`references/requests.md`](references/requests.md): catalog, price, create, wait, and error commands.
- [`references/prompting.md`](references/prompting.md): model picks and prompt styles per model.

## Prerequisites

Antseed Desktop or `antseed buyer start` must be running, normally at `http://127.0.0.1:8377`, and the buyer needs deposited USDC. Deposits can be funded by card where available, an exchange withdrawal, or another wallet. The commands need `curl` and `jq`.

## Example

```text
Use the antseed-videos skill. Make a surf video with ants.
```

See [`SKILL.md`](SKILL.md) for the agent workflow and safety rules.
