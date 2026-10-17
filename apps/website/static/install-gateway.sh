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
# Re-running it upgrades the CLI and rewrites the services; between runs,
# `antseed update` or the console's Update button installs the latest CLI
# through a root antseed-update service. Wallets and keys in
# /var/lib/antseed are never touched. Docs: https://antseed.com/docs/gateway/server

set -euo pipefail

PREFIX=/opt/antseed
SERVICE_USER=antseed
SERVICE_HOME=/var/lib/antseed
ENV_FILE=/etc/antseed/gateway.env
WALLET_ENV_FILE=/etc/antseed/wallet.env
WRAPPER=/usr/local/bin/antseed
WRAPPER_MARKER='# antseed-gateway-wrapper'
# Each CLI version is installed in its own releases/<version> directory and
# $CLI_HOME points at the one in use, so an update installs next to the
# running version and switching (or rolling back) is one symlink swap.
CLI_HOME="$PREFIX/current"
CLI_BIN="$CLI_HOME/bin/antseed"
UPDATER="$PREFIX/bin/antseed-update"
UPDATE_REQUEST="$SERVICE_HOME/update-request"
UPDATE_STATUS_DIR=/var/lib/antseed-update
UPDATE_STATUS="$UPDATE_STATUS_DIR/status.json"
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
PASSPHRASE="${ANTSEED_PASSPHRASE:-}"
REPLACE_PASSPHRASE="${ANTSEED_GATEWAY_REPLACE_PASSPHRASE:-0}"
PASSPHRASE_STORED=0
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

Wallet keys (optional; environment only, never a flag):
  ANTSEED_PASSPHRASE           Keeps wallet keys encrypted at rest. A copy of the passphrase lives
                               in /etc/antseed/wallet.env (0600, root), which both services load.
                               Keys that already exist stay as they are until you run
                               `sudo antseed buyer identity protect --all`.
  --replace-passphrase         Store a different ANTSEED_PASSPHRASE although wallet keys are already
                               encrypted with the one in wallet.env. Those keys will not open with
                               the new one: run `sudo antseed buyer identity unprotect --all` first.

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
  ANTSEED_GATEWAY_REPLACE_PASSPHRASE=1,
  ANTSEED_INSTALL_DRY_RUN=1, ANTSEED_INSTALL_VERBOSE=1, NO_COLOR=1
  CDP_API_KEY_ID, CDP_API_KEY_SECRET (for --x402-facilitator cdp)
  ANTSEED_PASSPHRASE (wallet keys encrypted at rest; see above)

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

# --verbose traces every command (set -x); secrets are handled with tracing
# paused so they never reach the terminal or a captured log.
xtrace_resume() { if [[ "$VERBOSE" == 1 ]]; then set -x; fi; }
quiet_x() {
  { set +x; } 2>/dev/null
  "$@"
  xtrace_resume
}
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
      --replace-passphrase) REPLACE_PASSPHRASE=1; shift ;;
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
  systemctl disable --now antseed-gateway.service antseed-buyer.service antseed-update.path 2>/dev/null || true
  rm -f /etc/systemd/system/antseed-gateway.service /etc/systemd/system/antseed-buyer.service \
    /etc/systemd/system/antseed-update.service /etc/systemd/system/antseed-update.path
  rm -rf "$UPDATE_STATUS_DIR"
  rm -f "$UPDATE_REQUEST"
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
  step "Done. Wallets, keys and usage history are still in $SERVICE_HOME, $ENV_FILE and $WALLET_ENV_FILE."
  note "They hold USDC credits: back them up before deleting them."
}

HOSTNAME_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'

# Values written into systemd units, env files and the Caddyfile must not
# contain whitespace, quotes or backslashes, which those formats parse.
check_value() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[^[:space:]\"\'\\]*$ ]] || die "$name must not contain spaces, quotes or backslashes"
}

# Characters as the CLI counts them: code points after NFKC normalisation.
# Without Node.js yet, count UTF-8 code points (bytes that do not continue a
# character), whatever the locale; main checks again once Node is installed.
passphrase_length() {
  local node="$PREFIX/node/bin/node"
  if [[ -x "$node" ]] && ANTSEED_PASSPHRASE="$PASSPHRASE" "$node" \
    -e 'console.log([...process.env.ANTSEED_PASSPHRASE.normalize("NFKC")].length)' 2>/dev/null; then
    return 0
  fi
  printf '%s' "$PASSPHRASE" | LC_ALL=C tr -d '\200-\277' | wc -c | tr -d ' '
}

check_passphrase_length() {
  [[ -n "$PASSPHRASE" ]] || return 0
  local length
  length="$(passphrase_length)"
  [[ "$length" =~ ^[0-9]+$ && "$length" -ge 12 ]] || die "ANTSEED_PASSPHRASE must be at least 12 characters"
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
  # Written single-quoted, so spaces are fine.
  [[ "$PASSPHRASE" != *"'"* && "$PASSPHRASE" != *$'\n'* ]] || die "ANTSEED_PASSPHRASE must not contain single quotes or line breaks"
  check_passphrase_length
  if [[ "$X402_FACILITATOR" == cdp && -z "${CDP_API_KEY_SECRET:-}" ]] \
    && ! grep -qs '^CDP_API_KEY_SECRET=' "$ENV_FILE"; then
    die "--x402-facilitator cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET in the environment (sudo CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... bash ...) or in $ENV_FILE"
  fi
  validate_sso
  validate_import
  validate_stored_passphrase

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

# The ANTSEED_PASSPHRASE an earlier run stored, or nothing.
stored_passphrase() {
  [[ -r "$WALLET_ENV_FILE" ]] || return 0
  local line
  line="$(grep -m1 '^ANTSEED_PASSPHRASE=' "$WALLET_ENV_FILE" 2>/dev/null)" || return 0
  line="${line#ANTSEED_PASSPHRASE=}"
  if [[ ${#line} -ge 2 && "$line" == \'*\' ]]; then line="${line:1:${#line}-2}"; fi
  printf '%s' "$line"
}

# An identity.key that holds a JSON envelope rather than 64 hex characters is
# encrypted (see packages/node/src/p2p/identity-envelope.ts).
has_encrypted_keys() {
  local file
  while IFS= read -r -d '' file; do
    if LC_ALL=C grep -q '^[[:space:]]*{' "$file" 2>/dev/null; then return 0; fi
  done < <(find "$DATA_DIR/identity.key" "$DATA_DIR/buyer-identities" -name identity.key -type f -print0 2>/dev/null)
  return 1
}

# wallet.env is the only copy of the passphrase the services have: replacing it
# with another while keys are encrypted with it locks the services out of them.
validate_stored_passphrase() {
  [[ -n "$PASSPHRASE" ]] || return 0
  local stored
  stored="$(stored_passphrase)"
  if [[ -n "$stored" && "$stored" == "$PASSPHRASE" ]]; then PASSPHRASE_STORED=1; return 0; fi
  [[ -n "$stored" && "$REPLACE_PASSPHRASE" != 1 ]] || return 0
  if has_encrypted_keys; then
    die "ANTSEED_PASSPHRASE differs from the one in $WALLET_ENV_FILE, which encrypts wallet keys in $DATA_DIR; the services could no longer open them. Re-run with the same passphrase, or without ANTSEED_PASSPHRASE to keep it. To change it, run 'sudo antseed buyer identity unprotect --all' first, then re-run with --replace-passphrase."
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
    { set +x; } 2>/dev/null
    (umask 077 && printf '%s\n' "$IMPORT_PASSWORD" >"$dir/password")
    xtrace_resume
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

# The version of the CLI installed under $1 (a release directory or $CLI_HOME), or nothing.
cli_version() {
  "$PREFIX/node/bin/node" -p "require('$1/lib/node_modules/@antseed/cli/package.json').version" 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || true
}

# Whether $PREFIX/releases/$1 holds @antseed/cli@$1 and it runs.
release_ready() {
  local dir="$PREFIX/releases/$1"
  [[ "$(cli_version "$dir")" == "$1" ]] && PATH="$PREFIX/node/bin:$PATH" "$dir/bin/antseed" --version >/dev/null 2>&1
}

# Installs @antseed/cli@$1 (an exact version) in $PREFIX/releases/$1 and
# checks that it runs; one already there (downloaded earlier) is kept. The
# release in use is never touched.
install_release() {
  local version="$1" loglevel="${2:-error}" dir="$PREFIX/releases/$1"
  if [[ "$(readlink -f "$CLI_HOME" 2>/dev/null)" == "$dir" ]] || release_ready "$version"; then return 0; fi
  rm -rf "$dir"
  mkdir -p "$PREFIX/releases"
  if PATH="$PREFIX/node/bin:$PATH" "$PREFIX/node/bin/npm" install --global --prefix "$dir" \
      --no-fund --no-audit --loglevel="$loglevel" "@antseed/cli@$version" \
    && release_ready "$version"; then
    return 0
  fi
  rm -rf "$dir"
  return 1
}

# Points $CLI_HOME at a release directory in one atomic rename.
activate_release() {
  ln -sfn "$1" "$CLI_HOME.next"
  mv -Tf "$CLI_HOME.next" "$CLI_HOME"
}

# Removes every release but the one in use and $1 (the one to roll back to).
prune_releases() {
  local keep_current keep_previous dir
  keep_current="$(readlink -f "$CLI_HOME" 2>/dev/null || true)"
  keep_previous="$(readlink -f "${1:-}" 2>/dev/null || true)"
  for dir in "$PREFIX"/releases/*; do
    [[ -d "$dir" ]] || continue
    [[ "$dir" == "$keep_current" || "$dir" == "$keep_previous" ]] && continue
    rm -rf "$dir"
  done
}

install_cli() {
  step "Installing @antseed/cli@$CLI_VERSION"
  local version
  version="$(PATH="$PREFIX/node/bin:$PATH" "$PREFIX/node/bin/npm" view "@antseed/cli@$CLI_VERSION" version 2>/dev/null | tail -1 | sed -E "s/^.*'([^']+)'$/\1/")"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "npm has no @antseed/cli@$CLI_VERSION"
  install_release "$version" "$([[ "$VERBOSE" == 1 ]] && echo notice || echo error)" || die "could not install @antseed/cli@$version"
  activate_release "$PREFIX/releases/$version"
  note "antseed $version"
}

# Installs before this layout put the CLI straight in $PREFIX/cli. The
# services stop using it once they restart on $CLI_HOME.
remove_legacy_cli() {
  if [[ -d "$PREFIX/cli" && ! -L "$PREFIX/cli" ]]; then rm -rf "$PREFIX/cli"; fi
  prune_releases ""
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
# Lets "antseed update" hand the install to the root update service.
export ANTSEED_UPDATER_REQUEST="$UPDATE_REQUEST" ANTSEED_UPDATER_STATUS="$UPDATE_STATUS"
if [ "\$(id -un)" = "$SERVICE_USER" ]; then exec "$CLI_BIN" "\$@"; fi
if [ "\$(id -u)" = 0 ]; then
  # Wallet keys encrypted at rest need the passphrase the services are given.
  if [ -r "$WALLET_ENV_FILE" ]; then set -a; . "$WALLET_ENV_FILE"; set +a; fi
  exec runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="\$PATH" \\
    ANTSEED_UPDATER_REQUEST="\$ANTSEED_UPDATER_REQUEST" ANTSEED_UPDATER_STATUS="\$ANTSEED_UPDATER_STATUS" "$CLI_BIN" "\$@"
fi
exec sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" PATH="\$PATH" \\
  ANTSEED_UPDATER_REQUEST="\$ANTSEED_UPDATER_REQUEST" ANTSEED_UPDATER_STATUS="\$ANTSEED_UPDATER_STATUS" "$CLI_BIN" "\$@"
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
    # Every request arrives through the tunnel: its CF-Connecting-IP is the client address.
    # Never elsewhere, where the origin may be reachable directly and the header forged.
    set_env ANTSEED_TRUST_CLOUDFLARE_HEADERS 1
  else
    set_env ANTSEED_TRUST_CLOUDFLARE_HEADERS ""
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
  # The wallet passphrase has a file of its own that both services load: the
  # buyer holds the wallets but has no use for the gateway's other secrets.
  if [[ -n "$PASSPHRASE" && "$PASSPHRASE_STORED" != 1 ]]; then
    (umask 077 && printf "ANTSEED_PASSPHRASE='%s'\n" "$PASSPHRASE" >"$WALLET_ENV_FILE")
    chmod 0600 "$WALLET_ENV_FILE"
  fi
  return 0
}

write_units() {
  step "Writing systemd services"
  # Both services run as $SERVICE_USER with the same data dir, so the gateway
  # can read the buyer-control secret the buyer creates. Restart=always brings
  # the buyer back after the console restarts it (exit code 75), which the
  # buyer only does when ANTSEED_SUPERVISED=1 tells it a supervisor is there.
  local common
  common="User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=-$WALLET_ENV_FILE
Environment=HOME=$SERVICE_HOME
Environment=PATH=$PREFIX/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=ANTSEED_UPDATER_REQUEST=$UPDATE_REQUEST
Environment=ANTSEED_UPDATER_STATUS=$UPDATE_STATUS
Restart=always
RestartSec=5
# Stopping lets requests in flight finish (up to a minute) before exiting.
TimeoutStopSec=90
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
ExecStart=$CLI_BIN buyer start --port $BUYER_PORT
Environment=ANTSEED_SUPERVISED=1
$common

[Install]
WantedBy=multi-user.target
EOF

  local exec_start
  if [[ "$MODE" == cloudflare ]]; then
    exec_start="$CLI_BIN tunnel start --no-buyer --provider cloudflare --buyer-port $BUYER_PORT --gateway-port $PORT"
  else
    exec_start="$CLI_BIN gateway start --no-buyer --host $HOST --port $PORT --buyer-port $BUYER_PORT"
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

# The services run unprivileged and cannot write $PREFIX. A root oneshot,
# started by a path unit when the gateway (or `antseed update`) creates
# $UPDATE_REQUEST, installs @antseed/cli@latest. Like the desktop app's
# Download and Restart & update, it takes two steps: a request with
# "action":"download" only installs the new version next to the running one
# (status "ready"), and any other request also switches to it and restarts
# the services. Nothing else in the request is read, so nobody can ask for a
# particular version, and the status goes to a root-owned directory the
# services can only read.
#
# The services keep serving until the new version is in place. The buyer
# restarts first while the gateway holds requests for it, then the gateway,
# with Caddy holding requests for that. Either one not coming back rolls
# both back to the previous version.
install_updater() {
  mkdir -p "$PREFIX/bin"
  local probe_host="$HOST"
  case "$probe_host" in 0.0.0.0|::|localhost) probe_host=127.0.0.1 ;; esac
  [[ "$probe_host" == *:* ]] && probe_host="[$probe_host]"
  {
    cat <<EOF
#!/usr/bin/env bash
# Installs @antseed/cli@latest for the Antseed gateway and restarts its services.
# Run as root by antseed-update.service; written by install-gateway.sh.
PREFIX="$PREFIX"
CLI_HOME="$CLI_HOME"
REQUEST="$UPDATE_REQUEST"
STATUS_DIR="$UPDATE_STATUS_DIR"
STATUS="$UPDATE_STATUS"
BUYER_URL="http://127.0.0.1:$BUYER_PORT/_antseed/buyer-identities"
GATEWAY_URL="http://$probe_host:$PORT/v1/models"
EOF
    declare -f cli_version release_ready install_release activate_release prune_releases
    cat <<'EOF'
set -uo pipefail
umask 022
export PATH="$PREFIX/node/bin:/usr/local/bin:/usr/bin:/bin" HOME=/root
mkdir -p "$STATUS_DIR" && chmod 0755 "$STATUS_DIR"
now() { date +%s%3N; }
str() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf null; fi; }
# status <state> <from> <to> [finishedAt] [error]
status() {
  printf '{"state":"%s","action":"%s","from":%s,"to":%s,"startedAt":%s,"finishedAt":%s,"error":%s}\n' \
    "$1" "$ACTION" "$(str "$2")" "$(str "$3")" "$STARTED" "${4:-null}" "$(str "${5:-}")" >"$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"
}
# done_status <state> ...: the run's last status; the exit trap leaves it alone.
done_status() { DONE=1; status "$@"; }
fail() { done_status failed "$FROM" "" "$(now)" "$1"; exit 1; }
# answers <url> <status>: something answers <url> with <status> within two
# minutes, as long as the gateway holds requests for a restarting buyer.
answers() {
  local _ code
  for _ in $(seq 1 120); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true)"
    if [ "$code" = "$2" ]; then return 0; fi
    sleep 1
  done
  return 1
}
# restart <unit> <url> <status>: restarts an enabled unit and waits for it to answer.
restart() {
  systemctl is-enabled --quiet "$1" || return 0
  systemctl restart "$1" && answers "$2" "$3"
}
rollback() {
  activate_release "$PREVIOUS"
  systemctl restart antseed-buyer.service
  systemctl restart antseed-gateway.service
  rm -rf "$PREFIX/releases/$TO"
  done_status failed "$FROM" "" "$(now)" "$1; rolled back to ${FROM:-the previous version}"
  exit 1
}
# Stopped part way (systemctl stop, the start timeout): go back to the
# version the services ran and say so, instead of leaving "running" behind.
interrupted() {
  [ "$DONE" = 1 ] && return
  if [ "$ACTIVATED" = 1 ]; then
    activate_release "$PREVIOUS"
    systemctl --no-block restart antseed-buyer.service antseed-gateway.service
  fi
  status failed "$FROM" "" "$(now)" "the update service stopped before finishing${ACTIVATED:+; went back to ${FROM:-the previous version}}"
}

STARTED="$(now)"
FROM="$(cli_version "$CLI_HOME")"
TO="" PREVIOUS="" ACTIVATED="" DONE=0
# The request is the antseed user's file: only a little of a regular file is
# read, never through a link, and only to pick the step. Its writers rename it
# into place whole; anything but a JSON object with no action, "download" or
# "install" restarts nothing. No request at all is root starting this
# service by hand: an install.
PARSE_REQUEST='let s="";process.stdin.on("data",(c)=>{s+=c}).on("end",()=>{let r;try{r=JSON.parse(s)}catch{return}if(!r||typeof r!=="object"||Array.isArray(r))return;const a=r.action===undefined?"install":r.action;if(a==="download"||a==="install")process.stdout.write(a)})'
ACTION=install
if [[ -e "$REQUEST" || -L "$REQUEST" ]]; then
  ACTION=""
  if [[ -f "$REQUEST" && ! -L "$REQUEST" ]]; then
    ACTION="$(timeout 5 head -c 1024 -- "$REQUEST" 2>/dev/null | timeout 10 node -e "$PARSE_REQUEST" 2>/dev/null || true)"
  fi
fi
case "$ACTION" in
  download|install) ;;
  *) ACTION=install; rm -rf -- "$REQUEST"; fail "the update request was incomplete; ask again" ;;
esac
# A version this service downloaded earlier (its own status, which only root writes).
READY="$(sed -nE 's/^\{"state":"ready","action":"download","from":[^,]*,"to":"([^"]+)".*/\1/p' "$STATUS" 2>/dev/null | head -1)"
trap interrupted EXIT
trap 'exit 1' TERM INT
status running "$FROM" ""
rm -rf -- "$REQUEST"
# Restart & update installs what was downloaded, even if npm moved on since.
if [ "$ACTION" = install ] && [ -n "$READY" ] && [ "$READY" != "$FROM" ] && release_ready "$READY"; then
  TO="$READY"
else
  TO="$(npm view @antseed/cli@latest version 2>/dev/null | tail -1)"
fi
[[ "$TO" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "could not read the latest version from npm"
# Already on it: nothing to install, nothing to restart.
if [ "$TO" = "$FROM" ]; then done_status succeeded "$FROM" "$TO" "$(now)"; exit 0; fi
status running "$FROM" "$TO"
install_release "$TO" error || fail "npm could not install @antseed/cli@$TO"
# Downloaded: the services keep running $FROM until someone restarts them onto it.
if [ "$ACTION" = download ]; then
  prune_releases "$PREFIX/releases/$TO"
  done_status ready "$FROM" "$TO" "$(now)"
  exit 0
fi
PREVIOUS="$(readlink -f "$CLI_HOME" 2>/dev/null || true)"
[ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] || fail "no release is active to go back to; re-run the installer"
ACTIVATED=1
activate_release "$PREFIX/releases/$TO"
restart antseed-buyer.service "$BUYER_URL" 200 || rollback "the buyer did not start on $TO"
restart antseed-gateway.service "$GATEWAY_URL" 401 || rollback "the gateway did not start on $TO"
prune_releases "$PREVIOUS"
done_status succeeded "$FROM" "$TO" "$(now)"
EOF
  } >"$UPDATER"
  chmod 0755 "$UPDATER"

  cat >/etc/systemd/system/antseed-update.service <<EOF
[Unit]
Description=Antseed update (installs @antseed/cli@latest and restarts the gateway)

[Service]
Type=oneshot
ExecStart=$UPDATER
TimeoutStartSec=15min
EOF
  cat >/etc/systemd/system/antseed-update.path <<EOF
[Unit]
Description=Start an Antseed update when the gateway asks for one

[Path]
PathExists=$UPDATE_REQUEST

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now antseed-update.path >/dev/null 2>&1
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
		# While the gateway restarts (an update finishing its requests in
		# flight, then starting), new requests wait for it instead of failing:
		# its 60 s drain plus a start, within the updater's two-minute wait
		# for it to answer. (The gateway holds requests for the buyer the
		# same two minutes.)
		lb_try_duration 75s
		lb_try_interval 250ms
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
  note "Updates: antseed-update.path starts a root antseed-update.service when the console or 'antseed update' asks"
  case "$MODE" in
    caddy) note "HTTPS: Caddy for https://$DOMAIN -> 127.0.0.1:$PORT" ;;
    cloudflare) note "HTTPS: Cloudflare named tunnel at $PUBLIC_URL" ;;
    *) note "Exposure: none beyond $HOST:$PORT" ;;
  esac
  if [[ -n "$X402_FACILITATOR" ]]; then note "x402 top-ups through $X402_FACILITATOR"; fi
  if [[ "$PASSPHRASE_STORED" == 1 ]]; then
    note "Wallet keys: new ones encrypted at rest with ANTSEED_PASSPHRASE (already in $WALLET_ENV_FILE, unchanged)"
  elif [[ -n "$PASSPHRASE" ]]; then
    note "Wallet keys: new ones encrypted at rest with ANTSEED_PASSPHRASE (a copy in $WALLET_ENV_FILE, 0600)"
  fi
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
  xtrace_resume
  trap cleanup EXIT
  trap abort INT TERM

  install_node
  quiet_x check_passphrase_length
  install_cli
  create_user
  install_wrapper
  quiet_x write_env_file
  write_units
  install_updater
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
  remove_legacy_cli
  quiet_x console_link

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
  # The link claims the console, so keep it out of cloud-init and CI logs.
  if [[ -n "$SETUP_LINK" && -t 1 ]]; then
    note "Setup:     $SETUP_LINK"
    note "           (open it to claim the console as its owner; single use, valid 1 h;"
    note "            a new one: antseed gateway console-link)"
  elif [[ -n "$SETUP_LINK" ]]; then
    note "Setup:     run on this server: antseed gateway console-link"
    note "           (prints the single-use link that claims the console as its owner)"
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
  note "Update:        antseed update, or Settings > General in the console"
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
