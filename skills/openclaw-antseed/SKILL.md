---
name: openclaw-antseed
description: "Connect OpenClaw to the Antseed P2P AI network through a gateway API key: the user's own gateway, or one set up on this computer as a background service. Use when: user asks to connect OpenClaw to Antseed, route OpenClaw through Antseed, set up Antseed as a service provider for OpenClaw, or use P2P AI services in OpenClaw."
user-invocable: true
metadata: { "openclaw": { "emoji": "\ud83c\udf31", "requires": { "bins": ["npm", "openclaw"] } } }
---

# Connect OpenClaw to Antseed P2P Network

Set up Antseed as a service provider for OpenClaw through an Antseed **gateway**: it gives OpenClaw its own API key with budgets and a usage log, and works wherever OpenClaw runs. If the user has none, Step 2 sets one up on this computer.

## Architecture

```
OpenClaw -> Antseed gateway (API key) -> buyer -> Antseed P2P -> Provider node -> Upstream API
```

The buyer discovers providers via DHT, negotiates payment channels automatically, and pays sellers in USDC. The gateway sits in front of a buyer and checks an API key on every request.

## Step 1: Get a gateway base URL and API key

OpenClaw needs two values: the gateway's base URL, ending in `/v1`, and an API key (`antseed_…`) sent as
`Authorization: Bearer`. Keep them in files so later commands can read them without the key ever appearing on a
command line or in output.

**The user already has a gateway** (on a server, or their computer published through `antseed tunnel start` or the
desktop app's **Agents → Internet-accessible endpoint**): ask for its base URL (shown in the Gateway Console's top
bar) and a key created under **Keys**, then save them (replace both placeholders):

```bash
mkdir -p "$HOME/.antseed/openclaw" && chmod 700 "$HOME/.antseed/openclaw"
printf '%s\n' 'https://gateway.example.com/v1' > "$HOME/.antseed/openclaw/base-url"
( umask 077 && printf '%s\n' 'PASTE-THE-KEY-HERE' > "$HOME/.antseed/openclaw/api-key" )
```

Its funding lives in its console (**Wallet & Funding**). Skip to Step 3.

**No gateway yet:** set one up on this computer (Step 2).

## Step 2: Set up a gateway on this computer

Needs Node.js 20 or newer. OpenClaw has its own, newer Node.js support policy; if `openclaw --version` rejects the
runtime, install a Node version the current OpenClaw release supports first.

Install the CLI, or upgrade one too old for `gateway service`. `--allow-scripts` lets npm build the CLI's database
and networking modules; recent npm versions skip them otherwise and the CLI can't start:

```bash
antseed gateway --help 2>/dev/null | grep '^  service ' >/dev/null || npm install -g @antseed/cli@latest --allow-scripts=@antseed/node,better-sqlite3,node-datachannel
```

Run the gateway as a background service: a launchd agent on macOS or a systemd user service on Linux, without
`sudo`. It starts at login, restarts if it stops, starts the buyer too (or uses one already running here), and
waits until both answer:

```bash
antseed gateway service status || antseed gateway service install
```

On a Linux server, user services stop at logout unless lingering is on; the install prints the one-time
`loginctl enable-linger` command for the user to run (it needs `sudo`).

Create a key for OpenClaw and save it without showing it:

```bash
mkdir -p "$HOME/.antseed/openclaw" && chmod 700 "$HOME/.antseed/openclaw"
printf '%s\n' 'http://localhost:8379/v1' > "$HOME/.antseed/openclaw/base-url"
( umask 077 && antseed gateway key create --label openclaw | sed -n 's/^API key: //p' > "$HOME/.antseed/openclaw/api-key" )
test -s "$HOME/.antseed/openclaw/api-key" && echo KEY-SAVED || echo KEY-FAILED
```

Fund it: `antseed buyer balance` shows the Available balance. To add funds, `antseed buyer deposit --no-watch`
prints an address for USDC on Base, or pay by card in the console (`antseed gateway console-link` opens it; then
**Wallet & Funding**). Nobody needs ETH for gas.

`scripts/setup.sh` runs Steps 2 and 3 in one go.

## Step 3: Configure OpenClaw service provider

```bash
python3 - "$HOME/.antseed/openclaw" "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" SERVICE_ID_HERE <<'PY'
import json, os, sys
secrets_dir, config_path, model = sys.argv[1:4]
base_url = open(os.path.join(secrets_dir, "base-url")).read().strip()
api_key = open(os.path.join(secrets_dir, "api-key")).read().strip()
with open(config_path) as f:
    cfg = json.load(f)
cfg.setdefault("models", {}).setdefault("providers", {})["antseed"] = {
    "baseUrl": base_url,
    "apiKey": api_key,
    "authHeader": True,
    "api": "openai-completions",
    "models": [{"id": model, "name": f"{model} via Antseed", "reasoning": False,
                "input": ["text"], "contextWindow": 131072, "maxTokens": 8192}],
}
tmp = config_path + ".tmp"
with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    json.dump(cfg, f, indent=2)
os.replace(tmp, config_path)
print(f"antseed provider set: {base_url}, model {model}")
PY
```

`openai-completions` with `authHeader: True` sends the key as `Authorization: Bearer <API_KEY>`, which a gateway requires, to the gateway's `/chat/completions`. Antseed translates the request when a seller speaks another API, so this works for every text model.

Replace `SERVICE_ID_HERE` with a model from the network catalog. Ids are case-sensitive; copy them from the list.
`antseed_curl` sends the key to curl through stdin, so it never shows on a command line:

```bash
ANTSEED_BASE_URL="$(cat "$HOME/.antseed/openclaw/base-url")"
antseed_curl() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.antseed/openclaw/api-key")" | curl -s -K - "$@"; }
antseed_curl "$ANTSEED_BASE_URL/models?type=text" | jq -r '.data[].id'
antseed_curl "$ANTSEED_BASE_URL/models/<model-id>"
```

`antseed network browse` remains useful for a peer-oriented table of services and pricing.

A request that names only a model selects the highest-ranked eligible offer under the shared Price + Trust preferences and can fail over on retryable peer failures. OpenClaw cuts model ids at `@`, so `<peerId>@<service-id>` reaches the gateway as a bare peer id and fails with `502 model_not_found`. To force a specific seller, create a gateway preset and use `@preset/<slug>` as the model id (presets pass through unchanged):

```bash
antseed gateway preset create --slug openclaw-pinned --name "OpenClaw pinned" \
  --model SERVICE_ID_HERE --allow-peer <peerId>
```

On an unfunded gateway, use a preset that prefers free sellers instead of a plain model id (`--model deepseek-v4-flash --prefer-free`, or add `--max-input-price 0 --max-output-price 0` to never pay). A plain id can land on a paid seller, and after a `402` OpenClaw disables the `antseed` key for about 10 minutes for every model; `openclaw models status` shows it under **Unavailable auth profiles**.

Set as default with OpenClaw's current model command:

```bash
openclaw models set "antseed/SERVICE_ID_HERE"
openclaw gateway restart
```

## Step 4: Verify

```bash
ANTSEED_BASE_URL="$(cat "$HOME/.antseed/openclaw/base-url")"
antseed_curl() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.antseed/openclaw/api-key")" | curl -s -K - "$@"; }
antseed_curl -o /dev/null -w '%{http_code}\n' "$ANTSEED_BASE_URL/models"
```

`200` means the key and base URL work. `antseed_curl "$ANTSEED_BASE_URL/models"` lists models from across the network (a gateway key limited to certain models lists only those); each model's `peers` array is ordered by the buyer's current routing preferences.

Then send one real request through OpenClaw. It shows under **Logs** in the Gateway Console.

## Notes

- A gateway requires its `antseed_...` key as `Authorization: Bearer`; keep `authHeader: true` so OpenClaw sends it
- Use concrete model ids; the id `antseed` (follow the model picked in the desktop app) fails through a gateway
- `antseed gateway service status` checks a gateway set up on this computer; `antseed gateway service uninstall` removes the background service (keys, wallet and settings stay)
- Never expose the buyer port 8377 (a router port forward, `socat`, a reverse proxy): it checks no key, so anyone who reaches it can spend the deposit. Reach a gateway from another machine through a tunnel or the server installer's HTTPS setup
- Streaming is supported (SSE)
- Payment channels are negotiated automatically on first request
- Funds come from the key's workspace wallet (console → **Wallet & Funding**, or `antseed buyer deposit` for a gateway on this computer). No ETH is needed, because sellers submit the on-chain transactions
- `402 insufficient_deposits` means the wallet is empty; `402 spend_limit_reached` and `403 model_not_allowed` come from the gateway key's budgets and routing policy (`https://antseed.com/docs/gateway/troubleshooting`)

## References

- Antseed integration page: `https://antseed.com/integrations/openclaw/`
- Antseed gateway: `https://antseed.com/docs/gateway` and `https://antseed.com/docs/gateway/api`
- Antseed quickstart: `https://antseed.com/docs/quickstart`
- Antseed tunnels: `https://antseed.com/docs/tunnels`
- OpenClaw model-provider documentation: `https://docs.openclaw.ai/concepts/model-providers`
- OpenClaw source: `https://github.com/openclaw/openclaw`
