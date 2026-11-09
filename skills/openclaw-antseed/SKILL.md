---
name: openclaw-antseed
description: "Connect OpenClaw to the Antseed P2P AI network through a gateway API key (recommended) or a local buyer proxy on the same machine. Use when: user asks to connect OpenClaw to Antseed, route OpenClaw through Antseed, set up Antseed as a service provider for OpenClaw, or use P2P AI services in OpenClaw."
user-invocable: true
metadata: { "openclaw": { "emoji": "\ud83c\udf31", "requires": { "bins": ["npm", "openclaw"] } } }
---

# Connect OpenClaw to Antseed P2P Network

Set up Antseed as a service provider for OpenClaw. The recommended endpoint is an Antseed **gateway**: it gives OpenClaw its own API key with budgets and a usage log, and works wherever OpenClaw runs. A **local buyer proxy** works only when OpenClaw runs on the same computer as the buyer.

## Architecture

```
OpenClaw -> Antseed gateway (API key) -> buyer -> Antseed P2P -> Provider node -> Upstream API
OpenClaw -> local buyer proxy (same computer only) -> Antseed P2P -> Provider node -> Upstream API
```

The buyer discovers providers via DHT, negotiates payment channels automatically, and pays sellers in USDC. The gateway sits in front of a buyer and checks an API key on every request.

## Step 1: Get a gateway base URL and API key (recommended)

OpenClaw needs two values:

```bash
export ANTSEED_BASE_URL="https://gateway.example.com/v1"   # or http://localhost:8379/v1 for a gateway on this computer
export ANTSEED_API_KEY="antseed_…"                          # a gateway key, sent as Authorization: Bearer
```

If the user already has a gateway, ask them for its base URL (shown in the Gateway Console's top bar) and a key created under **Keys**. Otherwise, one of:

- **This computer or a server:** follow the quickstart (`https://antseed.com/docs/quickstart`). On a computer, `curl -fsSL https://antseed.com/install.sh | bash` installs the CLI and starts a gateway at `http://localhost:8379/v1`. On a Linux server, the installer with `--domain` serves it over HTTPS (`https://antseed.com/docs/gateway/server`).
- **The user's computer, published over HTTPS:** `antseed tunnel start`, or the desktop app's **Agents → Internet-accessible endpoint**. Both publish a gateway and its console, so claim the console straight away: **Claim console** in the desktop app, or `antseed gateway console-link` on the same computer (`https://antseed.com/docs/tunnels`).

Funding lives on the gateway: add funds to the workspace wallet in the console's **Wallet & Funding** page (card or USDC on Base). Then skip to Step 6.

## Step 2: Or run a local buyer on this computer

Only if OpenClaw and the buyer run on the same computer and the user doesn't want a gateway. Install the CLI:

```bash
npm install -g @antseed/cli
```

Verify: `antseed --version` (requires Node.js 20+).

OpenClaw has its own, newer Node.js support policy. If `openclaw --version` rejects the runtime, install a Node version supported by the current OpenClaw release before continuing.

## Step 3: Set the identity (local buyer)

```bash
export ANTSEED_IDENTITY_HEX=<64-char-hex-private-key>
```

The key can optionally include a `0x` prefix. This key is your EVM wallet — deposits and payments are tied to it. Without it, the first `antseed buyer start` creates `identity.key` in the data directory.

## Step 4: Configure chain and fund the account (local buyer)

Custom `config.json` is optional. `antseed buyer start` works without one.

Create `~/.antseed/config.json` only if you want advanced behavior such as a non-default chain:

```json
{
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

Fund the buyer wallet with USDC on Base, then deposit into the escrow:

```bash
antseed buyer deposit 10
```

Verify with `antseed buyer balance`.

## Step 5: Start the buyer proxy (local buyer)

Run in a terminal or set up as a persistent service:

```bash
antseed buyer start
```

For an isolated OpenClaw buyer, use a dedicated data directory. This is where Antseed writes `buyer.state.json`, SQLite databases, payment-channel state, and the fallback `identity.key`:

```bash
export BUYDIR="$HOME/.antseed-buyer-openclaw"
mkdir -p "$BUYDIR"
ANTSEED_DATA_DIR="$BUYDIR" antseed --data-dir "$BUYDIR" buyer start
```

Advanced: if you intentionally want a non-default port:

```bash
antseed --data-dir "$BUYDIR" buyer start --port 5005
```

### Persistent service (systemd)

```bash
sudo tee /etc/systemd/system/antseed-buyer.service > /dev/null <<'EOF'
[Unit]
Description=Antseed Buyer Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=ANTSEED_IDENTITY_HEX=<private-key-hex-no-0x>
Environment=ANTSEED_DATA_DIR=%h/.antseed-buyer-openclaw
ExecStart=/usr/bin/env antseed --data-dir %h/.antseed-buyer-openclaw buyer start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=antseed-buyer

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now antseed-buyer
```

Then point OpenClaw at the local proxy:

```bash
export ANTSEED_BASE_URL="http://127.0.0.1:8377/v1"
export ANTSEED_API_KEY="antseed-p2p"
```

The local buyer proxy checks no key, so any non-empty placeholder works. It listens on `127.0.0.1` only. Never expose port 8377 (a router port forward, `socat`, a reverse proxy): anyone who reaches it can spend the buyer's deposit. For OpenClaw on another machine, use a gateway (Step 1).

## Step 6: Configure OpenClaw service provider

```bash
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
providers = cfg.setdefault('models', {}).setdefault('providers', {})
providers['antseed'] = {
    'baseUrl': '${ANTSEED_BASE_URL}',
    'apiKey': '${ANTSEED_API_KEY}',
    'authHeader': True,
    'api': 'openai-completions',
    'models': [{
        'id': 'SERVICE_ID_HERE',
        'name': 'SERVICE_DISPLAY_NAME',
        'reasoning': False,
        'input': ['text'],
        'contextWindow': 131072,
        'maxTokens': 8192
    }]
}
json.dump(cfg, sys.stdout, indent=2)
" > /tmp/oc_antseed.json && mv /tmp/oc_antseed.json ~/.openclaw/openclaw.json
```

`openai-completions` with `authHeader: True` sends the key as `Authorization: Bearer <API_KEY>`, which a gateway requires, to `$ANTSEED_BASE_URL/chat/completions`. Antseed translates the request when a seller speaks another API, so this works for every text model.

Replace `SERVICE_ID_HERE` with a model from the network catalog:

```bash
curl -s "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY" | jq '.data[].id'
curl -s "$ANTSEED_BASE_URL/models?type=text" -H "Authorization: Bearer $ANTSEED_API_KEY"
curl -s "$ANTSEED_BASE_URL/models/<model-id>" -H "Authorization: Bearer $ANTSEED_API_KEY"
```

`antseed network browse` remains useful for a peer-oriented table of services and pricing.

A request that names only a model selects the highest-ranked eligible offer under the shared Price + Trust preferences and can fail over on retryable peer failures. OpenClaw cuts model ids at `@`, so `<peerId>@<service-id>` reaches the gateway as a bare peer id and fails with `502 model_not_found`. To force a specific seller, create a gateway preset and use `@preset/<slug>` as the model id (presets pass through unchanged):

```bash
antseed gateway preset create --slug openclaw-pinned --name "OpenClaw pinned" \
  --model SERVICE_ID_HERE --allow-peer <peerId>
```

On an unfunded gateway, use a preset that prefers free sellers instead of a plain model id (`--model deepseek-v4-flash --prefer-free`, or add `--max-input-price 0 --max-output-price 0` to never pay). A plain id can land on a paid seller, and after a `402` OpenClaw disables the `antseed` key for about 10 minutes for every model; `openclaw models status` shows it under **Unavailable auth profiles**.

Presets resolve only in a gateway. Through the local buyer proxy (funded or not), use a concrete model id. An unfunded local buyer works with a model that has a free seller: newer CLIs retry a free seller after a paid one answers `402`, and zero token price caps (`antseed buyer start --max-input-usd-per-million 0 --max-output-usd-per-million 0`) keep paid text sellers out entirely. A model with no free seller, such as `kimi-k2.6`, needs a funded buyer. CLI 0.1.234 and earlier pass the `402` on even when a free seller exists (check with `antseed --version`); there, fund the buyer or run `antseed gateway start` and point OpenClaw at `http://127.0.0.1:8379/v1` with a key from `antseed gateway key create --label openclaw`.

Set as default with OpenClaw's current model command:

```bash
openclaw models set "antseed/SERVICE_ID_HERE"
openclaw gateway restart
```

## Step 7: Verify

```bash
curl -s "$ANTSEED_BASE_URL/models" \
  -H "Authorization: Bearer $ANTSEED_API_KEY"
```

If it returns models from across the network, the connection is working (a gateway key limited to certain models lists only those). The list is independent of any pinned peer; each model's `peers` array is ordered by the buyer's current routing preferences.

Then send one real request through OpenClaw. With a gateway, it shows under **Logs** in the Gateway Console; with a local buyer, `antseed buyer metering` shows the channel.

## Notes

- A gateway requires its `antseed_...` key as `Authorization: Bearer`; the local buyer proxy accepts any non-empty placeholder
- Keep `authHeader: true` so OpenClaw sends `Authorization: Bearer <API_KEY>`
- The model id `antseed` (follow the model picked in the desktop app) works only against the local buyer proxy of a desktop app with a model picked. Through a gateway, use concrete model ids
- Streaming is supported (SSE)
- Payment channels are negotiated automatically on first request
- With a gateway, funds come from the key's workspace wallet (console → **Wallet & Funding**). A local buyer needs USDC deposited with `antseed buyer deposit`. Neither needs ETH, because sellers submit the on-chain transactions
- `402 insufficient_deposits` means the wallet is empty; `402 spend_limit_reached` and `403 model_not_allowed` come from the gateway key's budgets and routing policy (`https://antseed.com/docs/gateway/troubleshooting`)
- Extra buyer config is optional; for a local buyer the only required pieces are identity plus whatever payment/deposit setup the user needs

## References

- Antseed integration page: `https://antseed.com/integrations/openclaw/`
- Antseed gateway: `https://antseed.com/docs/gateway` and `https://antseed.com/docs/gateway/api`
- Antseed quickstart: `https://antseed.com/docs/quickstart`
- Antseed tunnels: `https://antseed.com/docs/tunnels`
- OpenClaw model-provider documentation: `https://docs.openclaw.ai/concepts/model-providers`
- OpenClaw source: `https://github.com/openclaw/openclaw`
