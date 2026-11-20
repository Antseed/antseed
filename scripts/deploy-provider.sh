#!/usr/bin/env bash
set -euo pipefail

# Deploy an Antseed provider to a remote server via npm packages
#
# Examples:
#   ./scripts/deploy-provider.sh --host 1.2.3.4 \
#     --provider openai \
#     --api-key sk-... \
#     --provider-flavor openrouter \
#     --base-url https://openrouter.ai/api \
#     --services moonshotai/kimi-k2.5 \
#     --upstream-provider Together
#
#   ./scripts/deploy-provider.sh --host 1.2.3.4 \
#     --provider anthropic \
#     --api-key sk-ant-...
#
#   # Update only (no service reconfiguration):
#   ./scripts/deploy-provider.sh --host 1.2.3.4 --update-only

HOST=""
SSH_KEY="$HOME/.ssh/antseed-provider.pem"
SSH_USER="ec2-user"
SERVICE="antseed-provider"
PROVIDER=""
API_KEY=""
SERVICES=""
UPSTREAM_PROVIDER=""
PROVIDER_FLAVOR=""
BASE_URL=""
INPUT_PRICE=""
OUTPUT_PRICE=""
MAX_CONCURRENCY=""
UPDATE_ONLY=false
NODE_VERSION="22"

usage() {
  cat <<EOF
Usage: $0 --host <ip> --provider <name> --api-key <key> [options]

Required:
  --host <ip>                  Server IP or hostname
  --provider <name>            Provider plugin (openai, anthropic, local-llm)
  --api-key <key>              API key for the provider

Options:
  --key <path>                 SSH private key (default: ~/.ssh/antseed-provider.pem)
  --user <user>                SSH user (default: ec2-user)
  --service <name>             systemd service name (default: antseed-provider)
  --services <list>            Comma-separated service allow-list
  --provider-flavor <name>     OpenAI provider flavor (e.g. generic, openrouter)
  --base-url <url>             OpenAI-compatible upstream base URL
  --upstream-provider <name>   OpenRouter upstream provider (e.g. Together, DeepInfra)
  --input-price <n>            Input price USD per 1M tokens (default: 10)
  --output-price <n>           Output price USD per 1M tokens (default: 10)
  --max-concurrency <n>        Max concurrent requests (default: 10)
  --node-version <n>           Node.js major version to install (default: 22)
  --update-only                Just update npm packages and restart (no reconfigure)
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --host) HOST="$2"; shift 2 ;;
    --key) SSH_KEY="$2"; shift 2 ;;
    --user) SSH_USER="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --provider-flavor) PROVIDER_FLAVOR="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --upstream-provider) UPSTREAM_PROVIDER="$2"; shift 2 ;;
    --input-price) INPUT_PRICE="$2"; shift 2 ;;
    --output-price) OUTPUT_PRICE="$2"; shift 2 ;;
    --max-concurrency) MAX_CONCURRENCY="$2"; shift 2 ;;
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    --update-only) UPDATE_ONLY=true; shift ;;
    --help|-h) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "Error: --host is required"
  usage
fi

if [ "$UPDATE_ONLY" = false ] && { [ -z "$PROVIDER" ] || [ -z "$API_KEY" ]; }; then
  echo "Error: --provider and --api-key are required (or use --update-only)"
  usage
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
SSH_CMD="ssh -i $SSH_KEY $SSH_OPTS $SSH_USER@$HOST"

# Map provider name to npm package and env var for the API key
case "$PROVIDER" in
  openai)     PLUGIN_PKG="@antseed/provider-openai"; API_KEY_ENV="OPENAI_API_KEY" ;;
  anthropic)  PLUGIN_PKG="@antseed/provider-anthropic";  API_KEY_ENV="ANTHROPIC_API_KEY" ;;
  local-llm)  PLUGIN_PKG="@antseed/provider-local-llm";  API_KEY_ENV="" ;;
  "")         PLUGIN_PKG=""; API_KEY_ENV="" ;;
  *)          PLUGIN_PKG="@antseed/provider-$PROVIDER";   API_KEY_ENV="${PROVIDER^^}_API_KEY" ;;
esac

echo "==> Deploying to $SSH_USER@$HOST"

# 1. Install Node.js + CLI + plugin via npm
echo "==> Installing Node.js $NODE_VERSION and @antseed/cli..."
$SSH_CMD "bash -s" <<INSTALL
set -e
if ! command -v node &>/dev/null; then
  curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | sudo bash -
  sudo dnf install -y nodejs
fi
echo "  Node.js \$(node --version)"

sudo npm install -g @antseed/cli 2>&1 | tail -1
echo "  CLI \$(antseed --version)"
INSTALL

if [ -n "$PLUGIN_PKG" ]; then
  echo "==> Installing plugin $PLUGIN_PKG..."
  $SSH_CMD "antseed plugin add $PLUGIN_PKG </dev/null 2>&1 | tail -3 || true"
fi

# 2. Configure systemd service (skip if --update-only)
if [ "$UPDATE_ONLY" = true ]; then
  echo "==> Update only — skipping service configuration"
else
  echo "==> Writing systemd service ($SERVICE)..."

  # Build environment lines
  ENV_LINES="Environment=\"ANTSEED_DEBUG=1\""
  [ -n "$API_KEY_ENV" ] && [ -n "$API_KEY" ] && \
    ENV_LINES="$ENV_LINES\nEnvironment=\"${API_KEY_ENV}=${API_KEY}\""
  [ -n "$SERVICES" ] && \
    ENV_LINES="$ENV_LINES\nEnvironment=\"ANTSEED_ALLOWED_SERVICES=${SERVICES}\""
  if [ "$PROVIDER" = "openai" ]; then
    [ -n "$PROVIDER_FLAVOR" ] && \
      ENV_LINES="$ENV_LINES\nEnvironment=\"OPENAI_PROVIDER_FLAVOR=${PROVIDER_FLAVOR}\""
    [ -n "$BASE_URL" ] && \
      ENV_LINES="$ENV_LINES\nEnvironment=\"OPENAI_BASE_URL=${BASE_URL}\""
    [ -n "$UPSTREAM_PROVIDER" ] && \
      ENV_LINES="$ENV_LINES\nEnvironment=\"OPENAI_UPSTREAM_PROVIDER=${UPSTREAM_PROVIDER}\""
  fi
  [ -n "$INPUT_PRICE" ] && \
    ENV_LINES="$ENV_LINES\nEnvironment=\"ANTSEED_INPUT_USD_PER_MILLION=${INPUT_PRICE}\""
  [ -n "$OUTPUT_PRICE" ] && \
    ENV_LINES="$ENV_LINES\nEnvironment=\"ANTSEED_OUTPUT_USD_PER_MILLION=${OUTPUT_PRICE}\""
  [ -n "$MAX_CONCURRENCY" ] && \
    ENV_LINES="$ENV_LINES\nEnvironment=\"ANTSEED_MAX_CONCURRENCY=${MAX_CONCURRENCY}\""

  $SSH_CMD "sudo tee /etc/systemd/system/${SERVICE}.service > /dev/null" <<SERVICE_FILE
[Unit]
Description=Antseed Provider (${PROVIDER})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SSH_USER}
$(echo -e "$ENV_LINES")
ExecStart=/usr/bin/antseed seller start --provider ${PROVIDER}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE}

[Install]
WantedBy=multi-user.target
SERVICE_FILE

  $SSH_CMD "sudo systemctl daemon-reload && sudo systemctl enable $SERVICE"
fi

# 3. Restart
echo "==> Restarting $SERVICE..."
$SSH_CMD "sudo systemctl restart $SERVICE"
sleep 5
echo "==> Service status:"
$SSH_CMD "sudo systemctl is-active $SERVICE && sudo journalctl -u $SERVICE --no-pager -n 10"

echo "==> Done"
