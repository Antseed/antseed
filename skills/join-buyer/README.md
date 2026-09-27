# join-buyer

Set up an Antseed buyer on the agent's machine: install the CLI, start the local buyer proxy, fund it, and point any OpenAI- or Anthropic-compatible tool at `http://localhost:8377`.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed join-buyer
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

Node.js 20+ and `npm`. Nothing else: no account, no API key. Paid models need USDC on Base, which the skill walks the user through depositing; free models need no funds.

## Parameters

Provide the skill with any of these; it asks for what it cannot infer:

- `tool` — what to connect: `claude-code`, `codex`, `opencode`, `hermes`, `openclaw`, `cursor`, `aider`, `python`, `curl`, or `any` (default)
- `chain` — `base-mainnet` (default) or `base-sepolia`
- `proxy_url` — buyer URL; default `http://localhost:8377`
- `data_dir` — optional dedicated data directory for an isolated buyer

The skill installs `@antseed/cli`, writes the chain config, starts `antseed buyer start`, verifies `/v1/models`, funds the buyer with `antseed buyer deposit` when paid models are wanted, then configures the chosen tool.

## Example prompt

```text
Use the join-buyer skill to set this machine up as an Antseed buyer and
route Claude Code through it.
```

See [SKILL.md](SKILL.md) for the step-by-step instructions, routing and pinning rules, safety rules, and error handling.
