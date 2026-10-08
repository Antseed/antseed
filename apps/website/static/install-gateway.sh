#!/usr/bin/env bash
# Antseed gateway installer for Linux servers.
#
# Installs Node.js and the Antseed CLI under /opt/antseed, runs the buyer and
# the API-key gateway as systemd services under a dedicated `antseed` user,
# optionally publishes the gateway over HTTPS (Caddy or Cloudflare Tunnel),
# creates a first API key and prints a link to claim the gateway console.
# With --import it restores a gateway moved from another machine instead
# (`antseed gateway export`), keeping its keys, members and wallets.
#
#   curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --domain llm.example.com
#
# Re-running it upgrades the CLI and rewrites the services. Wallets and keys in
# /var/lib/antseed are never touched. Docs: https://antseed.com/docs/guides/gateway-server

set -euo pipefail

PREFIX=/opt/antseed
SERVICE_USER=antseed
SERVICE_HOME=/var/lib/antseed
ENV_FILE=/etc/antseed/gateway.env
WRAPPER=/usr/local/bin/antseed
WRAPPER_MARKER='# antseed-gateway-wrapper'
NODE_MAJOR=24
BUYER_PORT=8377

# Every option can also be set in the environment, for cloud-init and other automation.
DOMAIN="${ANTSEED_GATEWAY_DOMAIN:-}"
CLOUDFLARE_TOKEN="${CLOUDFLARED_TUNNEL_TOKEN:-}"
PUBLIC_URL="${ANTSEED_GATEWAY_PUBLIC_URL:-${ANTSEED_TUNNEL_PUBLIC_URL:-}}"
HOST="${ANTSEED_GATEWAY_HOST:-127.0.0.1}"
PORT="${ANTSEED_GATEWAY_PORT:-8379}"
KEY_LABEL="${ANTSEED_GATEWAY_KEY_LABEL:-admin}"
CLI_VERSION="${ANTSEED_CLI_VERSION:-latest}"
X402_FACILITATOR="${ANTSEED_X402_FACILITATOR_URL:-}"
OIDC_ISSUER="${ANTSEED_OIDC_ISSUER:-}"
OIDC_CLIENT_ID="${ANTSEED_OIDC_CLIENT_ID:-}"
OIDC_CLIENT_SECRET="${ANTSEED_OIDC_CLIENT_SECRET:-}"
OIDC_ALLOWED_DOMAINS="${ANTSEED_OIDC_ALLOWED_DOMAINS:-}"
CF_ACCESS_TEAM_DOMAIN="${ANTSEED_CF_ACCESS_TEAM_DOMAIN:-}"
CF_ACCESS_AUD="${ANTSEED_CF_ACCESS_AUD:-}"
IMPORT_BUNDLE="${ANTSEED_GATEWAY_IMPORT:-}"
IMPORT_PASSWORD_FILE="${ANTSEED_GATEWAY_IMPORT_PASSWORD_FILE:-}"
IMPORT_FORCE="${ANTSEED_GATEWAY_IMPORT_FORCE:-0}"
IMPORT_PASSWORD=""
DATA_DIR="$SERVICE_HOME/.antseed"
DRY_RUN="${ANTSEED_INSTALL_DRY_RUN:-0}"
VERBOSE="${ANTSEED_INSTALL_VERBOSE:-0}"
UNINSTALL=false
TMP_DIR=""

usage() {
  cat <<'EOF'
Usage: install-gateway.sh [options]

Exposure (pick at most one; default is 127.0.0.1 only, reach it over SSH):
  --domain <host>              Serve https://<host> with Caddy (automatic TLS).
                               DNS must point at this server; ports 80 and 443 open.
  --cloudflare-token <token>   Publish through a Cloudflare named tunnel. Needs --public-url.
                               Prefer passing CLOUDFLARED_TUNNEL_TOKEN in the environment
                               (sudo CLOUDFLARED_TUNNEL_TOKEN=... bash ...): a flag value is
                               visible in ps and shell history.
  --public-url <url>           Public hostname configured on the Cloudflare tunnel. Without a
                               proxy, the origin your own reverse proxy serves the gateway at
                               (used for console links, passkeys and single sign-on).
  --host <addr>                Gateway listen address without a proxy (default: 127.0.0.1).
                               0.0.0.0 serves plain HTTP; use it only on a private network.
                               Ignored with --domain or a Cloudflare tunnel, which always
                               listen on 127.0.0.1 behind the proxy.

Options:
  --port <n>                   Gateway port (default: 8379).
  --key-label <name>           Label of the first API key (default: admin).
  --x402-facilitator <value>   Accept x402 key top-ups: cdp, payai or a facilitator URL.
                               cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET in the environment.

Console sign-in with your own identity provider (optional; needs an https URL):
  --oidc-issuer <url>          OpenID Connect issuer, e.g. https://accounts.google.com.
  --oidc-client-id <id>        OAuth client ID. Its redirect URI must be
                               https://<host>/console/api/auth/oidc/callback.
  --oidc-client-secret <s>     OAuth client secret. Prefer ANTSEED_OIDC_CLIENT_SECRET in the
                               environment: a flag value is visible in ps and shell history.
  --oidc-allowed-domains <d>   Comma-separated email domains that may join without an invite.
  --cf-access-team-domain <d>  Cloudflare Access team domain, e.g. myteam.cloudflareaccess.com.
  --cf-access-aud <tag>        Cloudflare Access application audience (AUD) tag.
  --cli-version <version>      @antseed/cli version or dist-tag to install (default: latest).

Moving a gateway from another machine:
  --import <bundle>            Restore a bundle made with `antseed gateway export` (keys, members,
                               workspaces, wallets, usage) before the services start, instead of
                               creating a first API key. Asks for the bundle password on the terminal.
  --import-password-file <f>   Read the bundle password from the first line of this file instead.
  --import-force               Replace a gateway or wallet already in /var/lib/antseed; the old data is
                               moved aside to a .backup-<time> directory, never deleted.
  --dry-run                    Validate the options and print the plan, without changing anything.
  --verbose                    Print every command (set -x) and npm output.
  --uninstall                  Remove the services and the CLI. Keeps /var/lib/antseed.
  -h, --help                   Show this help.

Environment variables (same as the flags):
  ANTSEED_GATEWAY_DOMAIN, ANTSEED_GATEWAY_HOST, ANTSEED_GATEWAY_PORT,
  ANTSEED_GATEWAY_KEY_LABEL, ANTSEED_CLI_VERSION, ANTSEED_X402_FACILITATOR_URL,
  CLOUDFLARED_TUNNEL_TOKEN, ANTSEED_GATEWAY_PUBLIC_URL (or ANTSEED_TUNNEL_PUBLIC_URL),
  ANTSEED_OIDC_ISSUER, ANTSEED_OIDC_CLIENT_ID, ANTSEED_OIDC_CLIENT_SECRET,
  ANTSEED_OIDC_ALLOWED_DOMAINS, ANTSEED_CF_ACCESS_TEAM_DOMAIN, ANTSEED_CF_ACCESS_AUD,
  ANTSEED_GATEWAY_IMPORT, ANTSEED_GATEWAY_IMPORT_PASSWORD_FILE, ANTSEED_GATEWAY_IMPORT_FORCE=1,
  ANTSEED_INSTALL_DRY_RUN=1, ANTSEED_INSTALL_VERBOSE=1, NO_COLOR=1
  CDP_API_KEY_ID, CDP_API_KEY_SECRET (for --x402-facilitator cdp)

Examples:
  curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --domain llm.example.com
  curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
    | sudo CLOUDFLARED_TUNNEL_TOKEN=... bash -s -- --public-url https://llm.example.com
  curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
    | sudo bash -s -- --domain llm.example.com --import /tmp/antseed-gateway.bundle
  curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --dry-run
EOF
}

if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  C_RED=$'\033[31m' C_GREEN=$'\033[1;32m' C_YELLOW=$'\033[33m' C_RESET=$'\033[0m'
else
  C_RED="" C_GREEN="" C_YELLOW="" C_RESET=""
fi
die() { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
step() { printf '%s==>%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
note() { printf '    %s\n' "$*"; }

cleanup() { if [[ -n "$TMP_DIR" ]]; then rm -rf "$TMP_DIR"; fi; }
abort() { printf '\n' >&2; die "interrupted; re-run the installer to finish. Nothing in $SERVICE_HOME was removed."; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
      --cloudflare-token) CLOUDFLARE_TOKEN="${2:?--cloudflare-token needs a value}"; shift 2 ;;
      --public-url) PUBLIC_URL="${2:?--public-url needs a value}"; shift 2 ;;
      --host) HOST="${2:?--host needs a value}"; shift 2 ;;
      --port) PORT="${2:?--port needs a value}"; shift 2 ;;
      --key-label) KEY_LABEL="${2:?--key-label needs a value}"; shift 2 ;;
      --x402-facilitator) X402_FACILITATOR="${2:?--x402-facilitator needs a value}"; shift 2 ;;
      --oidc-issuer) OIDC_ISSUER="${2:?--oidc-issuer needs a value}"; shift 2 ;;
      --oidc-client-id) OIDC_CLIENT_ID="${2:?--oidc-client-id needs a value}"; shift 2 ;;
      --oidc-client-secret) OIDC_CLIENT_SECRET="${2:?--oidc-client-secret needs a value}"; shift 2 ;;
      --oidc-allowed-domains) OIDC_ALLOWED_DOMAINS="${2:?--oidc-allowed-domains needs a value}"; shift 2 ;;
      --cf-access-team-domain) CF_ACCESS_TEAM_DOMAIN="${2:?--cf-access-team-domain needs a value}"; shift 2 ;;
      --cf-access-aud) CF_ACCESS_AUD="${2:?--cf-access-aud needs a value}"; shift 2 ;;
      --cli-version|--version) CLI_VERSION="${2:?--cli-version needs a value}"; shift 2 ;;
      --import) IMPORT_BUNDLE="${2:?--import needs a bundle file}"; shift 2 ;;
      --import-password-file) IMPORT_PASSWORD_FILE="${2:?--import-password-file needs a file}"; shift 2 ;;
      --import-force) IMPORT_FORCE=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --verbose) VERBOSE=1; shift ;;
      --uninstall) UNINSTALL=true; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
}

check_system() {
  [[ "$(id -u)" -eq 0 || "$DRY_RUN" == 1 ]] \
    || die "run as root, e.g. curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- <options>"
  [[ "$(uname -s)" == Linux ]] || die "this installer supports Linux only"
  command -v systemctl >/dev/null 2>&1 || die "systemd is required"
}

uninstall() {
  step "Removing Antseed services"
  systemctl disable --now antseed-gateway.service antseed-buyer.service 2>/dev/null || true
  rm -f /etc/systemd/system/antseed-gateway.service /etc/systemd/system/antseed-buyer.service
  systemctl daemon-reload
  if [[ -f /etc/caddy/antseed.caddy ]]; then
    rm -f /etc/caddy/antseed.caddy
    if [[ -f /etc/caddy/Caddyfile.antseed-backup ]]; then
      mv /etc/caddy/Caddyfile.antseed-backup /etc/caddy/Caddyfile
    else
      sed -i '\#^import /etc/caddy/antseed.caddy$#d' /etc/caddy/Caddyfile 2>/dev/null || true
    fi
    systemctl reload caddy 2>/dev/null || true
  fi
  if [[ -f "$WRAPPER" ]] && grep -q "$WRAPPER_MARKER" "$WRAPPER"; then rm -f "$WRAPPER"; fi
  rm -rf "$PREFIX"
  step "Done. Wallets, keys and usage history are still in $SERVICE_HOME and $ENV_FILE."
  note "They hold USDC credits: back them up before deleting them."
}

HOSTNAME_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'

# Values written into systemd units, env files and the Caddyfile must not
# contain whitespace, quotes or backslashes, which those formats parse.
check_value() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[^[:space:]\"\'\\]*$ ]] || die "$name must not contain spaces, quotes or backslashes"
}

# Validate everything before changing the system.
validate() {
  MODE=local
  if [[ -n "$DOMAIN" && -n "$CLOUDFLARE_TOKEN" ]]; then die "use either --domain or --cloudflare-token, not both"; fi
  if [[ -n "$DOMAIN" ]]; then
    MODE=caddy
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
    DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"; DOMAIN="${DOMAIN%%:*}"
    [[ "$DOMAIN" =~ $HOSTNAME_RE ]] || die "--domain must be a hostname such as llm.example.com"
    HOST=127.0.0.1
  elif [[ -n "$CLOUDFLARE_TOKEN" ]]; then
    MODE=cloudflare
    [[ "$PUBLIC_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] \
      || die "--public-url https://<hostname> is required with a Cloudflare tunnel"
    check_value "the Cloudflare tunnel token" "$CLOUDFLARE_TOKEN"
    HOST=127.0.0.1
  elif [[ -n "$PUBLIC_URL" ]]; then
    [[ "$PUBLIC_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] \
      || die "--public-url must be an origin such as https://llm.example.com"
  fi
  PUBLIC_URL="${PUBLIC_URL%/}"
  # Where the console is reached; empty means localhost only.
  case "$MODE" in
    caddy) CONSOLE_ORIGIN="https://$DOMAIN" ;;
    *) CONSOLE_ORIGIN="$PUBLIC_URL" ;;
  esac
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "--port must be between 1 and 65535"
  PORT=$((10#$PORT))
  if (( PORT < 1 || PORT > 65535 )); then die "--port must be between 1 and 65535"; fi
  (( PORT != BUYER_PORT )) || die "--port $BUYER_PORT is the buyer's port; pick another"
  [[ "$HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || die "--host must be an IP address or hostname"
  [[ "$CLI_VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || die "--cli-version must be an npm version or tag"
  [[ -n "${KEY_LABEL// /}" ]] || die "--key-label cannot be empty"
  check_value "--x402-facilitator" "$X402_FACILITATOR"
  check_value "CDP_API_KEY_ID" "${CDP_API_KEY_ID:-}"
  check_value "CDP_API_KEY_SECRET" "${CDP_API_KEY_SECRET:-}"
  if [[ "$X402_FACILITATOR" == cdp && -z "${CDP_API_KEY_SECRET:-}" ]] \
    && ! grep -qs '^CDP_API_KEY_SECRET=' "$ENV_FILE"; then
    die "--x402-facilitator cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET in the environment (sudo CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... bash ...) or in $ENV_FILE"
  fi
  validate_sso
  validate_import

  for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac
}

# Operator-owned console sign-in: OIDC (Google, Okta, ...) and Cloudflare Access.
validate_sso() {
  local name
  for name in OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_ALLOWED_DOMAINS CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD; do
    check_value "ANTSEED_$name" "${!name}"
  done
  if [[ -n "$OIDC_ISSUER$OIDC_CLIENT_ID$OIDC_CLIENT_SECRET" ]]; then
    [[ -z "$OIDC_ISSUER" || "$OIDC_ISSUER" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] \
      || die "--oidc-issuer must be an https URL such as https://accounts.google.com"
    for name in OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET; do
      if [[ -z "${!name}" ]] && ! grep -qs "^ANTSEED_${name}=" "$ENV_FILE"; then
        die "single sign-on needs --oidc-issuer, --oidc-client-id and --oidc-client-secret (or ANTSEED_${name} in $ENV_FILE)"
      fi
    done
    [[ "$CONSOLE_ORIGIN" == https://* ]] \
      || die "single sign-on needs an https console URL: use --domain, a Cloudflare tunnel, or --public-url https://..."
  fi
  if [[ -n "$OIDC_ALLOWED_DOMAINS" ]]; then
    local domain
    for domain in ${OIDC_ALLOWED_DOMAINS//,/ }; do
      [[ "${domain#@}" =~ $HOSTNAME_RE ]] || die "--oidc-allowed-domains must be comma-separated domains such as example.com"
    done
  fi
  if [[ -n "$CF_ACCESS_TEAM_DOMAIN$CF_ACCESS_AUD" ]]; then
    if [[ -z "$CF_ACCESS_TEAM_DOMAIN" || -z "$CF_ACCESS_AUD" ]]; then
      die "Cloudflare Access needs both --cf-access-team-domain and --cf-access-aud"
    fi
    CF_ACCESS_TEAM_DOMAIN="$(printf '%s' "$CF_ACCESS_TEAM_DOMAIN" | tr '[:upper:]' '[:lower:]')"
    CF_ACCESS_TEAM_DOMAIN="${CF_ACCESS_TEAM_DOMAIN#https://}"; CF_ACCESS_TEAM_DOMAIN="${CF_ACCESS_TEAM_DOMAIN%%/*}"
    [[ "$CF_ACCESS_TEAM_DOMAIN" =~ $HOSTNAME_RE ]] || die "--cf-access-team-domain must be a hostname such as myteam.cloudflareaccess.com"
    [[ "$CF_ACCESS_AUD" =~ ^[A-Za-z0-9]+$ ]] || die "--cf-access-aud must be the application's AUD tag"
  fi
}

# A bundle from `antseed gateway export` on another machine.
validate_import() {
  if [[ -z "$IMPORT_BUNDLE" ]]; then
    [[ -z "$IMPORT_PASSWORD_FILE" && "$IMPORT_FORCE" != 1 ]] || die "--import-password-file and --import-force need --import <bundle>"
    return 0
  fi
  [[ -f "$IMPORT_BUNDLE" && -r "$IMPORT_BUNDLE" ]] || die "--import: cannot read $IMPORT_BUNDLE"
  head -c 23 "$IMPORT_BUNDLE" | grep -q '^ANTSEED-GATEWAY-BUNDLE' \
    || die "--import: $IMPORT_BUNDLE is not a bundle from antseed gateway export"
  if [[ -n "$IMPORT_PASSWORD_FILE" ]]; then
    [[ -f "$IMPORT_PASSWORD_FILE" && -r "$IMPORT_PASSWORD_FILE" ]] || die "--import-password-file: cannot read $IMPORT_PASSWORD_FILE"
  elif [[ "$DRY_RUN" != 1 ]] && ! { [[ -r /dev/tty ]] && : </dev/tty; } 2>/dev/null; then
    die "--import needs the bundle password: run it from a terminal, or pass --import-password-file <file>"
  fi
  if [[ "$IMPORT_FORCE" != 1 ]]; then
    local path
    for path in identity.key identity.enc gateway/gateway.db; do
      [[ ! -e "$DATA_DIR/$path" ]] \
        || die "$DATA_DIR already holds a gateway or wallet ($path); add --import-force to move it aside and import over it"
    done
  fi
}

# Asked before anything changes, so a typo costs nothing.
ask_import_password() {
  [[ -n "$IMPORT_BUNDLE" && -z "$IMPORT_PASSWORD_FILE" ]] || return 0
  printf 'Password for %s: ' "$(basename "$IMPORT_BUNDLE")" >/dev/tty
  IFS= read -r -s IMPORT_PASSWORD </dev/tty || die "could not read the bundle password"
  printf '\n' >/dev/tty
  [[ -n "$IMPORT_PASSWORD" ]] || die "the bundle password cannot be empty"
}

# Restores the bundle as the service user while both services are stopped.
import_bundle() {
  step "Importing $(basename "$IMPORT_BUNDLE")"
  systemctl stop antseed-gateway.service antseed-buyer.service 2>/dev/null || true
  TMP_DIR="$(mktemp -d)"
  local dir="$TMP_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$dir"
  chmod 0700 "$dir"
  install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$IMPORT_BUNDLE" "$dir/gateway.bundle"
  if [[ -n "$IMPORT_PASSWORD_FILE" ]]; then
    install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$IMPORT_PASSWORD_FILE" "$dir/password"
  else
    (umask 077 && printf '%s\n' "$IMPORT_PASSWORD" >"$dir/password")
    chown "$SERVICE_USER:$SERVICE_USER" "$dir/password"
  fi
  IMPORT_PASSWORD=""
  local args=(gateway import "$dir/gateway.bundle" --password-file "$dir/password" --port "$PORT")
  if [[ -n "$CONSOLE_ORIGIN" ]]; then args+=(--public-url "$CONSOLE_ORIGIN"); fi
  if [[ "$IMPORT_FORCE" == 1 ]]; then args+=(--force); fi
  if ! (cd "$dir" && "$WRAPPER" "${args[@]}"); then
    rm -rf "$dir"
    TMP_DIR=""
    die "the import failed (see above); nothing was started. Fix it and re-run the installer."
  fi
  rm -rf "$dir"
  TMP_DIR=""
}

install_node() {
  local current=""
  [[ -x "$PREFIX/node/bin/node" ]] && current="$("$PREFIX/node/bin/node" -p 'process.versions.node.split(".")[0]')"
  if [[ "$current" == "$NODE_MAJOR" ]]; then
    note "Node.js $("$PREFIX/node/bin/node" --version) already installed"
    return
  fi
  step "Installing Node.js $NODE_MAJOR ($NODE_ARCH)"
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  local line file sum tmp
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E " node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.gz$")" \
    || die "could not find a Node.js $NODE_MAJOR build for linux-$NODE_ARCH"
  sum="${line%% *}"
  file="${line##* }"
  TMP_DIR="$(mktemp -d)"
  tmp="$TMP_DIR"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  echo "$sum  $tmp/$file" | sha256sum -c --quiet - || die "Node.js checksum mismatch"
  # Extract beside the old version and swap, so a failed install leaves it in place.
  rm -rf "$PREFIX/node.new"
  mkdir -p "$PREFIX/node.new"
  tar -xzf "$tmp/$file" -C "$PREFIX/node.new" --strip-components=1
  rm -rf "$tmp" "$PREFIX/node.old"
  TMP_DIR=""
  [[ -d "$PREFIX/node" ]] && mv "$PREFIX/node" "$PREFIX/node.old"
  mv "$PREFIX/node.new" "$PREFIX/node"
  rm -rf "$PREFIX/node.old"
}

install_cli() {
  step "Installing @antseed/cli@$CLI_VERSION"
  PATH="$PREFIX/node/bin:$PATH" "$PREFIX/node/bin/npm" install --global --prefix "$PREFIX/cli" \
    --no-fund --no-audit --loglevel="$([[ "$VERBOSE" == 1 ]] && echo notice || echo error)" "@antseed/cli@$CLI_VERSION"
  note "antseed $(PATH="$PREFIX/node/bin:$PATH" "$PREFIX/cli/bin/antseed" --version 2>/dev/null | head -1 || true)"
}

create_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    step "Creating system user $SERVICE_USER"
    useradd --system --home-dir "$SERVICE_HOME" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  mkdir -p "$SERVICE_HOME"
  chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"
  chmod 0700 "$SERVICE_HOME"
}

install_wrapper() {
  if [[ -e "$WRAPPER" ]] && ! grep -q "$WRAPPER_MARKER" "$WRAPPER" 2>/dev/null; then
    die "$WRAPPER already exists and was not installed by this script; remove it (e.g. npm uninstall -g @antseed/cli) and re-run"
  fi
  cat >"$WRAPPER" <<EOF
#!/bin/sh
$WRAPPER_MARKER
# Runs the Antseed CLI as the $SERVICE_USER service user, against the gateway's data.
export PATH="$PREFIX/node/bin:\$PATH"
if [ "\$(id -un)" = "$SERVICE_USER" ]; then exec "$PREFIX/cli/bin/antseed" "\$@"; fi
if [ "\$(id -u)" = 0 ]; then
  exec runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="\$PATH" "$PREFIX/cli/bin/antseed" "\$@"
fi
exec sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" PATH="\$PATH" "$PREFIX/cli/bin/antseed" "\$@"
EOF
  chmod 0755 "$WRAPPER"
}

write_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  (umask 077 && touch "$ENV_FILE")
  chmod 0600 "$ENV_FILE"
  set_env() {
    local name="$1" value="$2"
    sed -i "/^${name}=/d" "$ENV_FILE"
    [[ -n "$value" ]] && printf '%s=%s\n' "$name" "$value" >>"$ENV_FILE"
    return 0
  }
  if [[ "$MODE" == cloudflare ]]; then
    set_env CLOUDFLARED_TUNNEL_TOKEN "$CLOUDFLARE_TOKEN"
    set_env ANTSEED_TUNNEL_PUBLIC_URL "$PUBLIC_URL"
  fi
  [[ -n "$X402_FACILITATOR" ]] && set_env ANTSEED_X402_FACILITATOR_URL "$X402_FACILITATOR"
  [[ -n "${CDP_API_KEY_ID:-}" ]] && set_env CDP_API_KEY_ID "$CDP_API_KEY_ID"
  [[ -n "${CDP_API_KEY_SECRET:-}" ]] && set_env CDP_API_KEY_SECRET "$CDP_API_KEY_SECRET"
  # Console sign-in; only what was passed is written, so re-runs keep the rest.
  [[ -n "$OIDC_ISSUER" ]] && set_env ANTSEED_OIDC_ISSUER "$OIDC_ISSUER"
  [[ -n "$OIDC_CLIENT_ID" ]] && set_env ANTSEED_OIDC_CLIENT_ID "$OIDC_CLIENT_ID"
  [[ -n "$OIDC_CLIENT_SECRET" ]] && set_env ANTSEED_OIDC_CLIENT_SECRET "$OIDC_CLIENT_SECRET"
  [[ -n "$OIDC_ALLOWED_DOMAINS" ]] && set_env ANTSEED_OIDC_ALLOWED_DOMAINS "$OIDC_ALLOWED_DOMAINS"
  [[ -n "$CF_ACCESS_TEAM_DOMAIN" ]] && set_env ANTSEED_CF_ACCESS_TEAM_DOMAIN "$CF_ACCESS_TEAM_DOMAIN"
  [[ -n "$CF_ACCESS_AUD" ]] && set_env ANTSEED_CF_ACCESS_AUD "$CF_ACCESS_AUD"
  return 0
}

write_units() {
  step "Writing systemd services"
  # Both services run as $SERVICE_USER with the same data dir, so the gateway
  # can read the buyer-control secret the buyer creates. Restart=always also
  # brings the buyer back after the console restarts it (exit code 75).
  local common
  common="User=$SERVICE_USER
Group=$SERVICE_USER
Environment=HOME=$SERVICE_HOME
Environment=PATH=$PREFIX/node/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$SERVICE_HOME
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet="

  cat >/etc/systemd/system/antseed-buyer.service <<EOF
[Unit]
Description=Antseed buyer
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$PREFIX/cli/bin/antseed buyer start --port $BUYER_PORT
$common

[Install]
WantedBy=multi-user.target
EOF

  local exec_start
  if [[ "$MODE" == cloudflare ]]; then
    exec_start="$PREFIX/cli/bin/antseed tunnel start --provider cloudflare --buyer-port $BUYER_PORT --gateway-port $PORT"
  else
    exec_start="$PREFIX/cli/bin/antseed gateway start --host $HOST --port $PORT --buyer-port $BUYER_PORT"
    [[ -n "$CONSOLE_ORIGIN" ]] && exec_start+=" --public-url $CONSOLE_ORIGIN"
  fi
  cat >/etc/systemd/system/antseed-gateway.service <<EOF
[Unit]
Description=Antseed API-key gateway
After=network-online.target antseed-buyer.service
Wants=network-online.target antseed-buyer.service

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$exec_start
$common

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

wait_for_buyer() {
  local _
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$BUYER_PORT/_antseed/buyer-identities" 2>/dev/null; then return 0; fi
    if (( $(systemctl show -p NRestarts --value antseed-buyer.service) > 0 )); then
      journalctl -u antseed-buyer -n 30 --no-pager >&2 || true
      die "the buyer exited during startup; see the log above or: journalctl -u antseed-buyer -n 100"
    fi
    sleep 1
  done
  die "the buyer did not start within 90s; check: journalctl -u antseed-buyer -n 100"
}

API_KEY=""
WALLET=""
create_first_key() {
  local count
  count="$("$WRAPPER" gateway key list --json | "$PREFIX/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')"
  if [[ "$count" != 0 ]]; then
    note "$count active API key(s) already exist; not creating a new one"
    return
  fi
  step "Creating API key \"$KEY_LABEL\""
  local json
  json="$("$WRAPPER" gateway key create --label "$KEY_LABEL" --json)"
  API_KEY="$(printf '%s' "$json" | "$PREFIX/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).apiKey))')"
  WALLET="$(printf '%s' "$json" | "$PREFIX/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).identityAddress ?? ""))')"
}

install_caddy() {
  if ! command -v caddy >/dev/null 2>&1; then
    step "Installing Caddy"
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
      chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq
      apt-get install -y -qq caddy >/dev/null
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q 'dnf-command(copr)'
      dnf copr enable -y -q @caddy/caddy
      dnf install -y -q caddy
    else
      die "install Caddy (https://caddyserver.com/docs/install) and re-run"
    fi
  fi

  step "Configuring Caddy for https://$DOMAIN"
  cat >/etc/caddy/antseed.caddy <<EOF
# Managed by install-gateway.sh: Antseed API-key gateway.
# Every path is proxied, including the console at /console, which sets its
# own CSP and frame headers.
$DOMAIN {
	header Strict-Transport-Security "max-age=31536000"
	# The gateway logs, rate-limits and audits by client address: drop a
	# client-sent Cf-Connecting-Ip and X-Forwarded-For so only the address
	# Caddy saw reaches it (reverse_proxy then sets X-Forwarded-For itself).
	request_header -Cf-Connecting-Ip
	request_header -X-Forwarded-For
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
  local caddyfile=/etc/caddy/Caddyfile
  # The stock package Caddyfile serves a placeholder page on :80, which would
  # shadow the HTTPS redirect. Replace it; otherwise import alongside.
  if [[ ! -s "$caddyfile" ]] || grep -q '/usr/share/caddy' "$caddyfile"; then
    [[ -s "$caddyfile" ]] && cp "$caddyfile" "$caddyfile.antseed-backup"
    echo 'import /etc/caddy/antseed.caddy' >"$caddyfile"
  elif ! grep -qx 'import /etc/caddy/antseed.caddy' "$caddyfile"; then
    printf '\nimport /etc/caddy/antseed.caddy\n' >>"$caddyfile"
  fi
  local validation
  if ! validation="$(caddy validate --config "$caddyfile" --adapter caddyfile 2>&1)"; then
    printf '%s\n' "$validation" | tail -5 >&2
    die "Caddy rejected $caddyfile"
  fi
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload-or-restart caddy
}

print_plan() {
  step "Dry run: nothing will be changed"
  note "Node.js $NODE_MAJOR ($NODE_ARCH) and @antseed/cli@$CLI_VERSION -> $PREFIX"
  note "System user $SERVICE_USER, data in $SERVICE_HOME"
  note "Services: antseed-buyer (port $BUYER_PORT), antseed-gateway ($HOST:$PORT)"
  case "$MODE" in
    caddy) note "HTTPS: Caddy for https://$DOMAIN -> 127.0.0.1:$PORT" ;;
    cloudflare) note "HTTPS: Cloudflare named tunnel at $PUBLIC_URL" ;;
    *) note "Exposure: none beyond $HOST:$PORT" ;;
  esac
  if [[ -n "$X402_FACILITATOR" ]]; then note "x402 top-ups through $X402_FACILITATOR"; fi
  if [[ -n "$IMPORT_BUNDLE" ]]; then
    note "Import: $IMPORT_BUNDLE into $DATA_DIR before the services start (keys, members, wallets, usage)"
    note "        password from ${IMPORT_PASSWORD_FILE:-a prompt on the terminal}; console sessions end, API keys keep working"
    if [[ "$IMPORT_FORCE" == 1 ]]; then note "        an existing gateway or wallet is moved aside to $DATA_DIR.backup-<time>"; fi
    note "First API key: none (the imported keys are kept)"
  else
    note "First API key label: $KEY_LABEL (only if no keys exist)"
  fi
  if [[ -n "$IMPORT_BUNDLE" ]]; then
    note "Console: ${CONSOLE_ORIGIN:-http://localhost:$PORT}/console (the imported owner signs in again)"
  else
    note "Console: ${CONSOLE_ORIGIN:-http://localhost:$PORT}/console (setup link printed after install)"
  fi
  if [[ -n "$OIDC_ISSUER" ]]; then
    note "Console single sign-on: $OIDC_ISSUER (redirect URI $CONSOLE_ORIGIN/console/api/auth/oidc/callback)"
  fi
  if [[ -n "$OIDC_ALLOWED_DOMAINS" ]]; then note "Console auto-join domains: $OIDC_ALLOWED_DOMAINS"; fi
  if [[ -n "$CF_ACCESS_TEAM_DOMAIN" ]]; then note "Console Cloudflare Access: $CF_ACCESS_TEAM_DOMAIN"; fi
}

CONSOLE_URL=""
SETUP_LINK=""
# A fresh owner setup link while nobody has claimed the console, else its URL.
console_link() {
  local json
  json="$("$WRAPPER" gateway console-link --json 2>/dev/null)" || { warn "could not read the console link; run: antseed gateway console-link"; return 0; }
  CONSOLE_URL="$(printf '%s' "$json" | "$PREFIX/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).url ?? ""))')"
  SETUP_LINK="$(printf '%s' "$json" | "$PREFIX/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).setupLink ?? ""))')"
}

# The gateway answers 401 to a request without a key once it is serving.
verify_gateway() {
  local _ code=""
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/models" || true)"
    if [[ "$code" == 401 ]]; then return 0; fi
    sleep 1
  done
  journalctl -u antseed-gateway -n 30 --no-pager >&2 || true
  die "the gateway is not answering on 127.0.0.1:$PORT (last status: ${code:-none}); see the log above"
}

# The whole script runs from main, so a truncated download executes nothing.
main() {
  parse_args "$@"
  check_system
  if [[ "$UNINSTALL" == true ]]; then uninstall; return; fi
  validate
  if [[ "$HOST" != 127.0.0.1 && "$HOST" != localhost && "$HOST" != ::1 ]]; then
    warn "the gateway will serve plain HTTP on $HOST; API keys cross the network unencrypted."
  fi
  if [[ "$DRY_RUN" == 1 ]]; then print_plan; return; fi
  ask_import_password
  if [[ "$VERBOSE" == 1 ]]; then set -x; fi
  trap cleanup EXIT
  trap abort INT TERM

  install_node
  install_cli
  create_user
  install_wrapper
  write_env_file
  write_units
  if [[ -n "$IMPORT_BUNDLE" ]]; then import_bundle; fi

  step "Starting the buyer"
  systemctl enable antseed-buyer.service >/dev/null 2>&1
  systemctl restart antseed-buyer.service
  wait_for_buyer

  if [[ -z "$IMPORT_BUNDLE" ]]; then create_first_key; fi

  step "Starting the gateway"
  systemctl enable antseed-gateway.service >/dev/null 2>&1
  systemctl restart antseed-gateway.service

  if [[ "$MODE" == caddy ]]; then install_caddy; fi
  verify_gateway
  console_link

  case "$MODE" in
    caddy) BASE_URL="https://$DOMAIN/v1" ;;
    cloudflare) BASE_URL="${PUBLIC_URL%/}/v1" ;;
    *) BASE_URL="http://$HOST:$PORT/v1" ;;
  esac
  [[ -n "$WALLET" ]] || WALLET="$("$WRAPPER" buyer identity list --json 2>/dev/null \
    | "$PREFIX/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);console.log((l.find?.(i=>i.name==="default")??{}).address??"")}catch{console.log("")}})' || true)"

  echo
  step "Antseed gateway is running"
  note "Base URL:  $BASE_URL"
  if [[ -n "$API_KEY" ]]; then
    note "API key:   $API_KEY"
    note "           (shown once; store it now)"
  fi
  if [[ -n "$WALLET" ]]; then note "Wallet:    $WALLET  (send USDC on Base to fund paid models)"; fi
  if [[ -n "$CONSOLE_URL" ]]; then note "Console:   $CONSOLE_URL"; fi
  if [[ -n "$SETUP_LINK" ]]; then
    note "Setup:     $SETUP_LINK"
    note "           (open it to claim the console as its owner; single use, valid 1 h;"
    note "            a new one: antseed gateway console-link)"
  elif [[ -n "$CONSOLE_URL" ]]; then
    note "           (already claimed; invite people: antseed gateway member invite --label <name>)"
  fi
  echo
  note "Test it:"
  note "  curl $BASE_URL/models -H \"Authorization: Bearer <api-key>\""
  echo
  note "Manage keys:   in the console, or antseed gateway key create --label alice --weekly-limit 5"
  note "Fund wallet:   antseed buyer deposit --no-watch"
  note "Logs:          journalctl -u antseed-gateway -u antseed-buyer -f"
  if [[ "$MODE" == local && "$HOST" == 127.0.0.1 ]]; then
    echo
    note "The gateway only listens on this server. From your machine:"
    note "  ssh -N -L $PORT:127.0.0.1:$PORT <user>@<this-server>"
    note "or re-run with --domain <host> to publish it over HTTPS."
  fi
  if [[ "$MODE" == caddy ]]; then
    echo
    note "Caddy requests the TLS certificate on first use; ports 80 and 443 must be reachable."
  fi
  if [[ -n "$IMPORT_BUNDLE" ]]; then
    echo
    note "Imported gateway: point your apps at $BASE_URL (API keys are unchanged),"
    note "stop the gateway on the old machine, and delete the bundle from both machines."
    note "Lost console sign-in after the move (e.g. passkeys from another domain)?"
    note "  antseed gateway console-link --recover"
  fi
}

# ANTSEED_INSTALL_SH_NO_RUN=1 loads the functions without running, for tests.
if [[ "${ANTSEED_INSTALL_SH_NO_RUN:-0}" != 1 ]]; then main "$@"; fi
