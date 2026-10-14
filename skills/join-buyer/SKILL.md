---
name: join-buyer
description: Set the user up with their own Antseed gateway, run as the Gateway Console at http://localhost:8379/console, and connect their tools to it with an Antseed API key. Use when the user asks to install Antseed, become an Antseed buyer, use Antseed from the CLI, route a tool or agent through Antseed, or fund Antseed.
---

# Join Antseed with a Gateway

Set the user up to consume AI models from the Antseed peer-to-peer network through their own **gateway**. This file is also served at https://antseed.com/skill.md. Per-tool setup pages live at https://antseed.com/integrations.

The result is an OpenAI- and Anthropic-compatible API at `http://localhost:8379/v1` (or `https://<domain>/v1` on a server), protected by Antseed API keys, plus a web console at `/console` where the user funds the wallet, creates keys, picks models and reads the request log.

## Picture

```
Your tool / agent  →  gateway :8379 (API keys, budgets, console)  →  buyer :8377  →  Antseed P2P  →  Provider peer
```

- The gateway checks the API key, applies budgets and routing policies, logs the request, and hands it to the buyer. `antseed gateway start` starts the buyer too.
- The buyer discovers providers over the DHT, opens a payment channel per provider and signs a per-request voucher. Providers do all on-chain work; the wallet never needs ETH.
- Payment is per request in USDC on Base, from the workspace's wallet. Funds can come from a card checkout in the console or from USDC sent on Base. Nothing is prepaid to Antseed.

## Prerequisites

- macOS or Linux, Node.js 20+ and `npm` (the installer handles a Linux server with systemd itself).
- No account. Free models need no funds.

## Parameters

Use these values; ask the user only for what you cannot infer:

- `where` — `local` (default: this computer) or `server` (always-on Linux host)
- `domain` — for `server`: a hostname whose DNS points at the server, to serve HTTPS. Without it, the gateway listens only on the server.
- `tool` — what to connect: `claude-code`, `codex`, `opencode`, `hermes`, `openclaw`, `cursor`, `python`, `curl`, or `any` (default: any OpenAI-compatible client)

Run the steps in order. Steps 2 and 3 need the user in a browser; wait for them.

## Step 1: Install and start the gateway

One line:

```bash
curl -fsSL https://antseed.com/install.sh | bash
```

- **macOS**: installs `@antseed/cli` with npm, starts `antseed gateway start` in the background and prints the console setup link.
- **Linux with systemd**: runs the server installer with `sudo`, which installs the gateway and buyer as services. For HTTPS at a hostname: `curl -fsSL https://antseed.com/install.sh | bash -s -- --domain <host>`. The server installer prints a summary with the base URL, a first API key labelled `admin` (shown once), the wallet address, the console URL and the setup link. See https://antseed.com/docs/gateway/server.

Manual alternative (any machine with Node.js):

```bash
npm install -g @antseed/cli
antseed gateway start          # also starts the buyer; keep it running
```

```
API-key gateway listening on http://127.0.0.1:8379/v1
Console: http://localhost:8379/console
The console has no owner yet. Get a one-time setup link with `antseed gateway console-link`.
```

Then, in another terminal:

```bash
antseed gateway console-link
# Console setup link (single use, valid for 1 hour):
#   http://localhost:8379/console/setup#…
```

Installs take 1–3 minutes; use a long timeout. Run `antseed gateway start` as a background process or service and keep it running after setup. On a server installed with an encrypted wallet passphrase, run CLI commands as `sudo antseed …`.

## Step 2: The user claims the console

Give the user the setup link and ask them to open it. **Do not open it or register a passkey yourself**: whoever claims the console becomes the owner and controls the workspace wallets.

1. The page says **Set up your Antseed console**.
2. The user clicks **Create a passkey** (or **Sign in with a wallet**).

The link works once and expires after one hour; `antseed gateway console-link` prints a fresh one. If the console already has an owner, the command prints the console URL instead; `antseed gateway console-link --recover` gives a recovery link.

Passkeys are bound to the hostname they were made on. They work on `localhost` and `https://` hostnames, not on bare IP addresses or plain-HTTP hostnames. A passkey made on `localhost` does not work at the server's domain later, and all gateways on `localhost` share passkeys. For a server without `--domain`, have the user forward the port and open the link on their machine:

```bash
ssh -N -L 8379:127.0.0.1:8379 <user>@<server>
```

## Step 3: The user adds funds

Skip this if the user only wants free models (marked **Free** on the console's **Models** page).

The user opens **Wallet & Funding** and clicks **Add funds**, then either:

- **Deposit by card**: a Crossmint checkout inside the console ($1–$200 per payment; not available in every region), or
- **Quick deposit**: send USDC on Base to the workspace's address (QR code shown), from an exchange withdrawal or another wallet. The first deposit into a wallet must be at least $1.

The balance updates by itself once funds arrive. **Never send funds yourself and never suggest an amount**; the user decides. Details: https://antseed.com/docs/gateway/funding.

Headless only (no browser available): the Default workspace pays from the buyer's `default` wallet, so `antseed buyer deposit --no-watch` prints its address and a QR code. For another workspace, `antseed gateway workspace show <workspace>` prints its wallet address. The running buyer deposits incoming USDC automatically. Card checkout is only in the console.

## Step 4: Create an API key

Preferred: the user opens **Keys**, clicks **Create key**, enters a **Name** and copies the secret (`antseed_…`). It is shown once.

On the gateway host you can create one instead:

```bash
antseed gateway key create --label "<tool name>"
# Optional: --workspace <name>, --daily-limit / --weekly-limit / --monthly-limit / --total-limit <usd>, --expires-in-days <n>
```

It prints `API key: antseed_…` once. Put the secret straight into the tool's config or an environment variable (`ANTSEED_API_KEY`) and do not echo it again, log it or paste it into chat output. `antseed gateway key list` shows keys without secrets; `antseed gateway key revoke <keyId>` revokes one.

## Step 5: Point the tool at the gateway

Use the base URL shown in the console's top bar: `http://localhost:8379/v1` locally, `https://<domain>/v1` on a server. The key is always sent as `Authorization: Bearer <key>`.

Models: copy ids from the console's **Models** page. A bare id (`deepseek-v4-flash`, `kimi-k2.6`, `gpt-oss-120b`) lets the gateway pick the best provider and fail over. `<peerId>@deepseek-v4-flash` pins one provider; use it only when the user asks to pin.

### Any OpenAI-compatible tool or SDK (Cursor, Python, JS)

```bash
export OPENAI_BASE_URL=http://localhost:8379/v1
export OPENAI_API_KEY="$ANTSEED_API_KEY"
```

```python
import os
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8379/v1", api_key=os.environ["ANTSEED_API_KEY"])
r = client.chat.completions.create(model="deepseek-v4-flash", messages=[{"role": "user", "content": "Hello"}])
```

### Anthropic-format clients (Claude Code, Anthropic SDK)

The base URL has **no** `/v1`. Use a bearer token (`ANTHROPIC_AUTH_TOKEN` / `authToken`), not `ANTHROPIC_API_KEY`, which is sent as `x-api-key` and rejected by the gateway.

```bash
export ANTHROPIC_BASE_URL=http://localhost:8379
export ANTHROPIC_AUTH_TOKEN="$ANTSEED_API_KEY"
export ANTHROPIC_MODEL=kimi-k2.6
claude
```

### Codex

Add a provider to `~/.codex/config.toml`. Prefer a preset (`@preset/<slug>`, from the console's **Presets** page) as the model:

```toml
model = "@preset/coder"
model_provider = "antseed"

[model_providers.antseed]
name = "Antseed gateway"
base_url = "http://localhost:8379/v1"
env_key = "ANTSEED_API_KEY"
wire_api = "responses"
```

The `antseed claude | codex | opencode` wrappers target the local buyer proxy by default and send a placeholder key. Against the gateway, configure the tools directly as above.

### Hermes and OpenClaw

Use the dedicated skills, which cover their provider schemas: `skills/hermes-antseed` and `skills/openclaw-antseed` in the Antseed repository. Give them the gateway base URL and API key. See https://antseed.com/docs/agents.

### Agents on another machine

A local gateway is only reachable on its own machine. For agents elsewhere, run the gateway on a server with `--domain` (Step 1), or move the local one there: https://antseed.com/docs/gateway/migrate.

## Step 6: Verify

```bash
curl -s http://localhost:8379/v1/models -H "Authorization: Bearer $ANTSEED_API_KEY" | jq '.data[].id'

curl http://localhost:8379/v1/chat/completions \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'
```

Then have the user open **Logs** in the console: the request is at the top with its model, provider, status and cost (cost can show `pending` for a moment). `curl -s http://localhost:8379/v1/key -H "Authorization: Bearer $ANTSEED_API_KEY"` shows the key's usage and limits.

## Without a gateway (local buyer proxy only)

For a single local tool with no keys, budgets or console, run just the buyer:

```bash
npm install -g @antseed/cli
antseed buyer start             # OpenAI/Anthropic API at http://localhost:8377, no API key
antseed buyer deposit           # funding address + QR for USDC on Base
antseed claude --model kimi-k2.6
```

The wrappers `antseed claude | codex | opencode` work against it unchanged. Full guide: https://antseed.com/docs/api.

## Safety and Output Rules

- Never print, paste or log API key secrets beyond writing them into the user's tool config, and never print wallet private keys, `identity.key`, `ANTSEED_IDENTITY_HEX`, `ANTSEED_PASSPHRASE`, `/etc/antseed/wallet.env` or config files that hold them. Refer to them by path.
- Never open a setup, recovery or invite link yourself, and never register a passkey or wallet sign-in for the user.
- Do not expose ports 8379 or 8377 beyond loopback: no `--host 0.0.0.0`, port forwards or ad-hoc reverse proxies. For remote access use the server installer with `--domain`, a Cloudflare tunnel, or an SSH forward.
- Never send funds, never invent funding amounts, and never send USDC anywhere except a workspace address shown by the console or the CLI, on Base only.
- Do not construct `<peerId>@<model>` unless the user asks to pin a provider.
- Long-running commands (`curl … | bash`, `npm install -g`, `antseed gateway start`) need a long timeout or a background process. Keep the gateway running after setup.
- After setup, tell the user the base URL, the console URL, the tool configuration you applied (without the secret) and whether funds are needed.

## Verification checklist

- [ ] `antseed --version` prints a version
- [ ] `antseed gateway start` logs `API-key gateway listening on http://127.0.0.1:8379/v1`
- [ ] The user claimed the console and can sign in
- [ ] For paid models: **Wallet & Funding** shows an available balance
- [ ] `GET /v1/models` with the key lists models
- [ ] The user's tool answers a prompt, and the request appears in **Logs**

## Troubleshooting

- **`401 invalid_api_key` / `key_revoked` / `key_expired`**: wrong, revoked or expired key, or the wrong base URL. Check the `Authorization: Bearer` header; create a new key on **Keys**.
- **`402 spend_limit_reached`**: a key, member or workspace budget ran out; `error.limit` says which and `resets_at`. Wait, or have an admin raise it.
- **`403 model_not_allowed`**: a routing policy allows only certain models. Use an allowed model; the **Routing** page shows the effective policy.
- **`502 buyer_unavailable` / `503 spend_tracking_unavailable`**: the buyer isn't running or doesn't match the gateway. Run both from `antseed gateway start` with the same `--data-dir`.
- **No "Sign in with a passkey" button / passkey refused**: the console is open on an IP, plain HTTP, or a different hostname than the passkey's. Open it at `http://localhost:8379` or its HTTPS domain, or sign in with a wallet.
- **"This link is not valid"**: the setup link was used, expired or replaced. Run `antseed gateway console-link` again.
- **"Identity at … is encrypted"**: run CLI commands on the server as `sudo antseed …`.
- **Connection refused on 8379**: the gateway isn't running, or runs on another `--port`.
- **Slow first request**: the first request discovers and connects to a provider (5–10s); later ones reuse the connection.

More: https://antseed.com/docs/gateway/troubleshooting.

## References

- Quickstart: https://antseed.com/docs/quickstart
- The gateway: https://antseed.com/docs/gateway
- Calling the API: https://antseed.com/docs/gateway/api
- Funding: https://antseed.com/docs/gateway/funding
- Gateway on a server: https://antseed.com/docs/gateway/server
- Local buyer proxy API: https://antseed.com/docs/api
- Agents: https://antseed.com/docs/agents
