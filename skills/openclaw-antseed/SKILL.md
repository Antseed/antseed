---
name: openclaw-antseed
description: "Connect OpenClaw to the Antseed P2P AI network locally or through an authenticated public tunnel. Use when: user asks to connect OpenClaw to Antseed, route OpenClaw through Antseed, set up Antseed as a service provider for OpenClaw, or use P2P AI services in OpenClaw."
user-invocable: true
metadata: { "openclaw": { "emoji": "\ud83c\udf31", "requires": { "bins": ["npm", "openclaw"] } } }
---

# Connect OpenClaw to Antseed P2P Network

Set up Antseed as a service provider for OpenClaw. The agent can connect to a buyer proxy on the same machine or to the AI VPN's authenticated public endpoint.

## Architecture

```
OpenClaw -> local buyer proxy or HTTPS tunnel -> Antseed P2P -> Provider node -> Upstream API
```

The buyer proxy discovers providers via DHT, negotiates payment channels automatically, and exposes an API-compatible HTTP endpoint. Never expose the local buyer port directly to the internet.

## Step 1: Install and initialize Antseed

```bash
npm install -g @antseed/cli
```

Verify: `antseed --version` (requires Node.js 20+).

OpenClaw has its own, newer Node.js support policy. If `openclaw --version` rejects the runtime, install a Node version supported by the current OpenClaw release before continuing.

## Step 2: Set the identity

```bash
export ANTSEED_IDENTITY_HEX=<64-char-hex-private-key>
```

The key can optionally include a `0x` prefix. This key is your EVM wallet — deposits and payments are tied to it.

## Step 3: Configure chain and fund the account

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

## Step 4: Start the buyer proxy

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

## Step 5: Choose the endpoint

For OpenClaw running on the same machine as the buyer proxy:

```bash
export ANTSEED_BASE_URL="http://127.0.0.1:8377/v1"
export ANTSEED_API_KEY="antseed-p2p"
```

The local buyer proxy accepts any non-empty placeholder key.

For OpenClaw running elsewhere:

1. Open **Agents** in the AI VPN.
2. Under **Define your internet-accessible Antseed endpoint**, configure and start ngrok or Cloudflare Tunnel.
3. Copy the displayed **OpenAI base URL** and generated **API key**.
4. Set them on the OpenClaw machine:

```bash
export ANTSEED_BASE_URL="https://your-endpoint.example/v1"
export ANTSEED_API_KEY="antseed_your_generated_key"
```

The public endpoint requires the generated key as `Authorization: Bearer <API_KEY>`.

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
    'api': 'anthropic-messages',
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

Replace `SERVICE_ID_HERE` with a model from the AI VPN's network catalog:

```bash
curl -s "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY" | jq '.data[].id'
curl -s "$ANTSEED_BASE_URL/models?type=text" -H "Authorization: Bearer $ANTSEED_API_KEY"
curl -s "$ANTSEED_BASE_URL/models/<model-id>" -H "Authorization: Bearer $ANTSEED_API_KEY"
```

`antseed network browse` remains useful for a peer-oriented table of services and pricing.

A request that names only a model selects the highest-ranked eligible offer under the shared Price + Trust preferences and can fail over on retryable peer failures. To force a specific seller instead, use `<peerId>@<service-id>` as the model id — explicit pins never fail over.

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

If the proxy returns models from across the network, the connection is working. The list is independent of any pinned peer; each model's `peers` array is ordered by the buyer's current routing preferences.

## Notes

- A local connection accepts any non-empty placeholder API key; a public endpoint requires the generated `antseed_...` key
- `authHeader: true` is required for the public endpoint so OpenClaw sends `Authorization: Bearer <API_KEY>` instead of the Anthropic-native `x-api-key` header
- Streaming is supported (SSE)
- Payment channels are negotiated automatically on first request
- The buyer wallet needs USDC deposited with `antseed buyer deposit`; it does not need ETH because sellers submit the on-chain transactions
- Extra buyer config is optional; the only required pieces are identity plus whatever payment/deposit setup the user needs

## References

- Antseed integration page: `https://antseed.com/integrations/openclaw/`
- Antseed public tunnel guide: `https://antseed.com/docs/guides/public-tunnels`
- OpenClaw model-provider documentation: `https://docs.openclaw.ai/concepts/model-providers`
- OpenClaw source: `https://github.com/openclaw/openclaw`
