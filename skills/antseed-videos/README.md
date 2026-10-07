# antseed-videos

Guided video generation through Antseed's local buyer proxy.

## Install

Antseed Desktop bundles this skill in chat. For other agents, install it with:

```bash
gh skill install Antseed/antseed antseed-videos
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

## What it does

The skill discovers video models from `/v1/models?type=videos`, reads each seller's advertised `capabilities.video`, and asks about the options that matter before it creates a paid video. It can also draft a script and prepare first or last frames with the `antseed-images` skill.

After the user confirms, it filters sellers that support the exact request and pins only that create as `<peerId>@<model>`. This does not change the proxy's default route or other chats. Follow-up status and download requests reuse the seller that accepted the job.

Local PNG, JPEG, or WebP images, supplied by the user or generated with `antseed-images`, can be used as start and end frames. In Antseed Desktop, images uploaded to or generated in the chat can be used directly, and generated frames and videos play inline.

For videos longer than one clip, the skill plans frame-matched segments and stitches them with ffmpeg. When all keyframes are ready, `antseed_video.mjs batch` submits creates one at a time and waits for accepted jobs in parallel. Segments that need the previous segment's last frame (`antseed_video.mjs frame`) still run in order.

## Prerequisites

Antseed Desktop or `antseed buyer start` must be running, normally at `http://127.0.0.1:8377`, and the buyer needs deposited USDC. Deposits can be funded by card where available, an exchange withdrawal, or another wallet.

## Example

```text
Use the antseed-videos skill. Create an ANTS launch video: write the script,
make the first and last frames, then use Seedance for a 10-second video.
```

See [`SKILL.md`](SKILL.md) for the agent workflow and safety rules.
