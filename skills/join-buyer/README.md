# join-buyer

Set the user up with their own Antseed gateway, run as the Gateway Console: install and start it, have the user claim the console and add funds, create an API key, and point any OpenAI- or Anthropic-compatible tool at `http://localhost:8379/v1` (or the server's HTTPS URL).

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed join-buyer
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

macOS or Linux with Node.js 20+ and `npm`; a Linux server with systemd for an always-on gateway. No account. The user needs a browser to claim the console with a passkey and, for paid models, to add funds by card or USDC on Base. Free models need no funds.

## Parameters

Provide the skill with any of these; it asks for what it cannot infer:

- `where` — `local` (default) or `server`
- `domain` — for a server: the hostname to serve HTTPS at
- `tool` — what to connect: `claude-code`, `codex`, `opencode`, `hermes`, `openclaw`, `cursor`, `python`, `curl`, or `any` (default)

The skill runs `curl -fsSL https://antseed.com/install.sh | bash` (or `npm install -g @antseed/cli` and `antseed gateway start`), hands the user the one-time console setup link, waits while they claim the console and fund it in **Wallet & Funding**, creates an API key, configures the chosen tool and verifies a first request in the console's **Logs**. It also covers the plain local buyer proxy (`antseed buyer start` on port 8377) as a fallback.

## Example prompt

```text
Use the join-buyer skill to set up an Antseed gateway on this machine and
route Claude Code through it.
```

See [SKILL.md](SKILL.md) for the step-by-step instructions, the console steps, tool configuration, safety rules, and error handling.
