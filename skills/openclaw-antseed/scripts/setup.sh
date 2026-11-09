#!/usr/bin/env bash
set -euo pipefail

# Connect OpenClaw to Antseed through a gateway.
#
# With a gateway of your own, pass its base URL and key in the environment.
# Without one, this sets up a gateway on this computer as a background service
# (launchd on macOS, a systemd user service on Linux; no root needed) and creates a
# key for OpenClaw. Either way the key is kept in a file only you can read and
# never appears on a command line.
#
# Usage:
#   ./setup.sh --service <model-id> [--service-name <name>] [--context-window <n>] [--max-tokens <n>]
#
# Examples:
#   ./setup.sh --service deepseek-v4-flash
#   ANTSEED_BASE_URL=https://gateway.example.com/v1 ANTSEED_API_KEY=... ./setup.sh --service kimi-k2.6

SERVICE=""
SERVICE_NAME=""
CONTEXT_WINDOW=131072
MAX_TOKENS=8192
SECRETS_DIR="$HOME/.antseed/openclaw"
LOCAL_BASE_URL="http://localhost:8379/v1"

usage() {
  cat <<EOF
Usage: $0 --service <model-id> [options]

Required:
  --service <id>            Model id from the network catalog (e.g. deepseek-v4-flash)

Options:
  --service-name <name>     Display name in OpenClaw (default: "<id> via Antseed")
  --context-window <n>      Context window size (default: 131072)
  --max-tokens <n>          Max output tokens (default: 8192)
  -h, --help                Show this help

Environment:
  ANTSEED_BASE_URL, ANTSEED_API_KEY   Use your own gateway instead of setting one up here
  OPENCLAW_CONFIG_PATH                OpenClaw config (default: ~/.openclaw/openclaw.json)
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --service) SERVICE="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --context-window) CONTEXT_WINDOW="$2"; shift 2 ;;
    --max-tokens) MAX_TOKENS="$2"; shift 2 ;;
    # Older versions installed a buyer service with this flag; the gateway service replaces it.
    --service-flag) shift ;;
    --help|-h) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

[ -n "$SERVICE" ] || { echo "Error: --service is required"; usage; }
[ -n "$SERVICE_NAME" ] || SERVICE_NAME="$SERVICE via Antseed"

command -v openclaw >/dev/null || { echo "Error: openclaw not found. Install OpenClaw first."; exit 1; }
OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
[ -f "$OPENCLAW_CONFIG" ] || { echo "Error: OpenClaw config not found at $OPENCLAW_CONFIG"; exit 1; }

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [ -n "${ANTSEED_BASE_URL:-}" ] && [ -n "${ANTSEED_API_KEY:-}" ]; then
  echo "==> Using the gateway at $ANTSEED_BASE_URL"
  printf '%s\n' "$ANTSEED_BASE_URL" > "$SECRETS_DIR/base-url"
  (umask 077 && printf '%s\n' "$ANTSEED_API_KEY" > "$SECRETS_DIR/api-key")
else
  echo "==> Setting up a gateway on this computer"
  if ! antseed gateway service --help >/dev/null 2>&1; then
    echo "  Installing the Antseed CLI (this can take a few minutes)..."
    npm install -g @antseed/cli@latest --allow-scripts=@antseed/node,better-sqlite3,node-datachannel
  fi
  echo "  CLI version: $(antseed --version)"
  if ! antseed gateway service status >/dev/null 2>&1; then
    antseed gateway service install
  fi
  printf '%s\n' "$LOCAL_BASE_URL" > "$SECRETS_DIR/base-url"
  # A key saved by an earlier run is reused while the gateway still accepts it.
  if [ -s "$SECRETS_DIR/api-key" ] && printf 'header = "Authorization: Bearer %s"\n' "$(cat "$SECRETS_DIR/api-key")" \
      | curl -s -K - -o /dev/null -w '%{http_code}' -m 15 "$LOCAL_BASE_URL/models" | grep -qx 200; then
    echo "  Reusing the gateway key saved in $SECRETS_DIR/api-key"
  else
    (umask 077 && antseed gateway key create --label openclaw | sed -n 's/^API key: //p' > "$SECRETS_DIR/api-key")
    [ -s "$SECRETS_DIR/api-key" ] || { echo "Error: could not create a gateway key"; exit 1; }
    echo "  Created a gateway key for OpenClaw (saved in $SECRETS_DIR/api-key)"
  fi
fi

echo "==> Configuring OpenClaw..."
python3 - "$SECRETS_DIR" "$OPENCLAW_CONFIG" "$SERVICE" "$SERVICE_NAME" "$CONTEXT_WINDOW" "$MAX_TOKENS" <<'PY'
import json, os, sys
secrets_dir, config_path, model, name, context_window, max_tokens = sys.argv[1:7]
base_url = open(os.path.join(secrets_dir, "base-url")).read().strip()
api_key = open(os.path.join(secrets_dir, "api-key")).read().strip()
with open(config_path) as f:
    cfg = json.load(f)
cfg.setdefault("models", {}).setdefault("providers", {})["antseed"] = {
    "baseUrl": base_url,
    "apiKey": api_key,
    "authHeader": True,
    "api": "openai-completions",
    "models": [{"id": model, "name": name, "reasoning": False, "input": ["text"],
                "contextWindow": int(context_window), "maxTokens": int(max_tokens)}],
}
cfg.setdefault("agents", {}).setdefault("defaults", {}).setdefault("model", {})["primary"] = f"antseed/{model}"
tmp = config_path + ".tmp"
with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    json.dump(cfg, f, indent=2)
os.replace(tmp, config_path)
print(f"  Provider configured: antseed/{model}")
print(f"  Endpoint: {base_url}")
print(f"  Default model set: antseed/{model}")
PY

if [ -z "${ANTSEED_BASE_URL:-}" ]; then
  echo ""
  echo "==> Funding: 'antseed buyer balance' shows what's available."
  echo "    Add USDC on Base with 'antseed buyer deposit --no-watch', or pay by card in the console"
  echo "    ('antseed gateway console-link', then Wallet & Funding)."
fi
echo ""
echo "==> Apply the changes with: openclaw gateway restart"
echo "==> Done"
