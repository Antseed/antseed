---
name: join-buyer
description: Set up an Antseed buyer on the user's machine through the local buyer proxy at http://localhost:8377. Use when the user asks to install Antseed, become an Antseed buyer, use Antseed from the CLI, route a tool or agent through Antseed, or fund an Antseed buyer.
---

# Join Antseed as a Buyer

Set the user up to consume AI models from the Antseed peer-to-peer network. This file is also served at https://antseed.com/skill.md. Per-tool setup pages live at https://antseed.com/integrations. The result is a local HTTP proxy at `http://localhost:8377` that speaks the OpenAI and Anthropic API formats. Any tool, SDK, or agent that can change its base URL works unchanged.

## Picture

```
Your tool / agent  →  http://localhost:8377 (buyer proxy)  →  Antseed P2P  →  Provider peer
```

- The buyer proxy discovers providers over the DHT, opens a payment channel per seller, and signs a per-request voucher. Providers do all on-chain work; the buyer never needs ETH.
- Requests are routed across the open market by price and trust. A request that names only a model gets the highest-ranked eligible offer.
- Payment is per request in USDC on Base. Nothing is prepaid to Antseed; deposits stay in a contract the buyer can withdraw from.

## Prerequisites

- Node.js 20+ and `npm`.
- No account and no API key. Paid models need USDC on Base (Step 6); free models need nothing.

## Parameters

Use these values; ask the user only for what you cannot infer:

- `tool` — what to connect: `claude-code`, `codex`, `opencode`, `hermes`, `openclaw`, `cursor`, `aider`, `python`, `curl`, or `any` (default: any OpenAI-compatible client)
- `chain` — `base-mainnet` (default, real funds) or `base-sepolia` (testnet)
- `proxy_url` — buyer URL; default `http://localhost:8377`. Use another port only when the user provides one.
- `data_dir` — optional dedicated data directory for an isolated buyer (Step 4)

Run the steps in order. Stop and report after Step 5 if the user only wants free models; continue to Step 6 before the first paid request.

## Step 1: Install the CLI

```bash
npm install -g @antseed/cli
antseed --version
```

A global install can take 1–3 minutes; use a long timeout. Latest published version: `npm view @antseed/cli version`.

## Step 2: Write the chain config

`antseed buyer start` runs with built-in defaults (router `local`, proxy port `8377`) and needs no config file. Funding does: `antseed buyer deposit` and `antseed buyer withdraw` read `payments.crypto.chainId` and fail with "No crypto payment configuration found" without it. Create `~/.antseed/config.json` now so the later steps just work:

```json
{
  "buyer": {
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 25,
        "cachedInputUsdPerMillion": 12,
        "outputUsdPerMillion": 75
      }
    }
  },
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

**Do not hardcode contract addresses.** `@antseed/node` resolves Deposits, Channels, USDC, and the RPC URL from `chainId` via its built-in presets. To switch chains later, change only `chainId` and restart the buyer.

`maxPricing` caps what the buyer will pay (USD per 1M tokens); providers above the cap are skipped. Adjust or drop it to taste.

## Step 3: Identity

The buyer needs an EVM identity (a 32-byte secp256k1 private key). Either:

- set `ANTSEED_IDENTITY_HEX=<64-hex, optional 0x>` in the environment (for servers, put it in a `.env` or the service unit), or
- run without it and let the CLI use the key in `~/.antseed/identity.key` (created on first run).

The EVM address derived from that key is the buyer's peer id **and** its wallet address. **Never commit the key** and never move `identity.key` off the host that runs the buyer. The wallet only ever needs USDC on Base, never ETH.

## Step 4: Start the buyer proxy

```bash
antseed buyer start
# Proxy listening on http://localhost:8377
```

Leave it running in its own terminal or as a service. It binds to `127.0.0.1` only and is never exposed to the LAN. Startup logs print the Deposits/Channels addresses and RPC URL it bound to; glance at them to confirm the chain.

For an isolated buyer (one per app, test run, or concurrent process) use a dedicated data directory. It holds `buyer.state.json`, SQLite databases, payment-channel state, and the fallback `identity.key`:

```bash
export BUYDIR="$HOME/.antseed-buyer-myapp"
mkdir -p "$BUYDIR"
ANTSEED_DATA_DIR="$BUYDIR" antseed --data-dir "$BUYDIR" buyer start
```

Non-default port for one run: `antseed buyer start --port 8888`. Persistent: `antseed config buyer set proxyPort 8888`.

Linux service (systemd):

```bash
sudo tee /etc/systemd/system/antseed-buyer.service > /dev/null <<UNIT
[Unit]
Description=Antseed Buyer Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=ANTSEED_IDENTITY_HEX=<64-hex-no-0x>
ExecStart=/usr/bin/env antseed buyer start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now antseed-buyer
```

## Step 5: Confirm it works before paying anything

```bash
# Every model on the network, answered locally from the discovered-peer cache
curl -s http://localhost:8377/v1/models | jq '.data[].id'

# Filter by modality, or inspect one model and its ranked offers
curl -s 'http://localhost:8377/v1/models?type=text'
curl -s 'http://localhost:8377/v1/models?type=images'
curl -s http://localhost:8377/v1/models/<model-id>

# Peers, services, pricing, reputation
antseed network browse
```

Providers that advertise a price of zero can be used without a deposit. Anything paid needs Step 6 first.

## Step 6: Fund the buyer

`antseed buyer deposit` prints the buyer's funding address and a QR code (an EIP-681 payment request), then watches the wallet and deposits incoming USDC into the buyer's credits automatically. The node signs a gasless EIP-3009 authorization and a permissionless relayer submits the transaction for a fixed ~$0.05 USDC fee, so the buyer never needs ETH.

```bash
antseed buyer deposit              # address + QR, waits and auto-deposits incoming USDC
antseed buyer deposit --no-watch   # just print the address + QR
antseed buyer deposit --amount 10  # prefill 10 USDC in the QR / checkout link
```

Send USDC **on the Base network only** to the printed address: from any wallet, an exchange withdrawal, or a card on-ramp. The command also serves a connected-wallet checkout page and prints its link (`http://127.0.0.1:3118?token=…`) for depositing from a browser-extension wallet. On a remote host run it inside the SSH session; the QR renders in the terminal.

While `antseed buyer start` is running, incoming wallet USDC is swept into deposits automatically even without the deposit command open (`buyer.autoSweep`, default `true`). `antseed buyer sweep` triggers one sweep by hand. A first-ever deposit must net at least 1 USDC after the relay fee.

Check and manage funds:

```bash
antseed buyer balance            # wallet USDC, deposited, reserved in channels, available
antseed buyer withdraw <amount>  # move unused deposits back to the wallet
antseed buyer activity           # tokens, spend history, savings, channels, claimable ANTS
antseed buyer channels           # open payment channels
```

## Step 7: Point the tool at the proxy

The API key is never validated by the local proxy, but most clients require a non-empty value; use any placeholder.

### Any OpenAI-compatible tool or SDK

```bash
export OPENAI_BASE_URL=http://localhost:8377/v1
export OPENAI_API_KEY=antseed
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8377/v1", api_key="antseed")
r = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello"}],
)
```

### Anthropic-format clients (Claude Code and SDKs)

```bash
antseed claude --model kimi-k2.6          # wrapper: sets the env and launches Claude Code
antseed claude --model <peerId>@kimi-k2.6 # pinned to one seller
```

Manual equivalent: `ANTHROPIC_BASE_URL=http://localhost:8377` and `ANTHROPIC_API_KEY=antseed`, then run `claude --model kimi-k2.6`. Claude Code talks to `/v1/messages`; the proxy translates to the seller's native format when needed.

### Codex and OpenCode

Recent Codex versions ignore `OPENAI_BASE_URL`, so use the wrappers, which write a per-run provider config:

```bash
antseed codex --model deepseek-v4-flash
antseed opencode --model gpt-oss-120b
```

### Hermes and OpenClaw

Use the dedicated skills, which cover their provider schemas and remote-agent endpoints: `skills/hermes-antseed` and `skills/openclaw-antseed` in the Antseed repository.

### Agents on another machine

`localhost:8377` is only reachable on the buyer host. For a remote agent or hosted tool, define an authenticated public endpoint from the AI VPN desktop app's **Agents** view (see `https://antseed.com/docs/guides/agents`). Never expose port 8377 to the internet directly.

### curl

```bash
# OpenAI format
curl http://localhost:8377/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "Hello"}]}'

# Anthropic format
curl http://localhost:8377/v1/messages \
  -H "content-type: application/json" \
  -d '{"model": "kimi-k2.6", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

## Routing and pinning

A bare model id selects the highest-ranked eligible offer under the shared Price + Trust preferences (pricing, cached-input pricing coverage, recent failures, cooldowns, free-peer preference, seller access rules). Peer-attributed retryable failures advance to the next ranked offer; 429s get up to three attempts on the same peer before fallback. For an ongoing conversation, a successful automatic route becomes a soft affinity: later turns prefer the seller that served the chat while it stays healthy.

Close aliases (`claude-opus-5`, `opus-5`, `opus5`) merge into one `/v1/models` entry with an `aliases` array and a `peers` array in routing order.

Optional preferences (a running proxy hot-reloads valid changes):

```bash
antseed config buyer set routingPreferences.minTrustScore 60        # hard eligibility gate, default 60
antseed config buyer set routingPreferences.maxInputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
```

To force a specific seller (precedence: header > model prefix > session pin). Pinned requests never fail over:

| Mechanism | Scope | How |
|---|---|---|
| Header `x-antseed-pin-peer: <peerId>` | one request | works even when the tool controls the model field |
| Model prefix `<peerId>@<model>` | one request | `"model": "<peerId>@deepseek-v4-flash"` |
| Session pin | until cleared, survives restarts | `antseed buyer connection set --peer <peerId>` |

Inspect a peer with `antseed network peer <peerId>`; show or clear the session pin with `antseed buyer connection get` / `clear`.

## Payment flow (automatic)

1. The tool sends a request to the proxy.
2. The proxy picks a seller and, on first contact, signs a `ReserveAuth` that locks USDC from deposits for that channel.
3. The seller calls `reserve()` on-chain (seller pays gas).
4. For each request the proxy signs a cumulative `SpendingAuth`; the seller settles or closes the channel later.
5. If a seller disappears, the buyer can request a close and withdraw after a grace period.

No wallet app or browser extension is involved; the identity key signs everything off-chain.

## Safety and Output Rules

- Never print, paste, or log the identity private key, `ANTSEED_IDENTITY_HEX`, the contents of `identity.key`, or full config files that contain them. Refer to them by path only.
- Never move `identity.key` off the host that runs the buyer, and never commit it or `.env` files that hold the key.
- Do not expose the buyer proxy beyond loopback. Never bind it to `0.0.0.0`, forward port 8377, or put it behind a public reverse proxy; remote agents use the AI VPN's authenticated public endpoint instead.
- Do not hardcode contract addresses or RPC URLs; `chainId` selects them.
- Do not send USDC anywhere except the address printed by `antseed buyer deposit`, on the Base network only. Show the user the address and let them send it; do not invent amounts.
- Do not construct `<peerId>@<model>` or send `x-antseed-pin-peer` unless the user asks to pin a seller; a bare model id lets the proxy route by Price + Trust and fail over.
- Long-running commands (`npm install -g`, `antseed buyer start`, `antseed buyer deposit`) need a long timeout or a background process. Keep the proxy running after setup.
- After setup, tell the user the base URL, the tool configuration you applied, and whether funds are needed.

## Verification checklist

- [ ] `antseed --version` prints a version
- [ ] `antseed buyer start` logs `Proxy listening on http://localhost:8377` and the expected chain
- [ ] `curl -s localhost:8377/v1/models | jq '.data[].id'` lists models
- [ ] For paid models: `antseed buyer balance` shows deposits available
- [ ] The user's tool answers a prompt through `localhost:8377`, and the buyer log shows a channel open then per-request voucher signing

## Troubleshooting

- **"No crypto payment configuration found"**: `~/.antseed/config.json` lacks `payments.crypto.chainId`. Add it (Step 2).
- **"Payment setup failed" / insufficient deposits**: run `antseed buyer balance`; fund with `antseed buyer deposit` (Step 6). Remember the ~$0.05 relay fee and the 1 USDC minimum first deposit.
- **"No peers found"**: the network may be sparse or the DHT still warming up. Wait a few seconds and retry `antseed network browse`.
- **`missing_routing_target` (400)**: the request named neither a model nor a peer. Send a model id.
- **`model_not_found` (502)**: no policy-allowed peer advertises that model or alias. Check `/v1/models`, loosen `maxPricing` / `minTrustScore`, or pick another model.
- **"Connection refused on 8377"**: `antseed buyer start` is not running, or runs on another port or data directory.
- **Tool says "invalid API key"**: set the key to any non-empty string.
- **Slow first request**: the first request discovers and connects to a peer via the DHT (5–10s). Later requests reuse the connection.
- **"existing_channel_still_active"**: a previous channel was not cleanly closed. Restart `antseed buyer start`.

## References

- Using the API: `https://antseed.com/docs/guides/using-the-api`
- Connect agents (remote endpoints): `https://antseed.com/docs/guides/agents`
- Payments: `https://antseed.com/docs/guides/payments`
- CLI README: `https://github.com/AntSeed/antseed/tree/main/apps/cli`
