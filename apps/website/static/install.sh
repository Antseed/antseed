#!/usr/bin/env bash
# Antseed gateway installer: an OpenAI- and Anthropic-compatible API with API
# keys, budgets and a web console.
#
#   curl -fsSL https://antseed.com/install.sh | bash
#
# On Linux with systemd it runs the server installer (install-gateway.sh) as
# root, passing every argument through:
#
#   curl -fsSL https://antseed.com/install.sh | bash -s -- --domain gateway.example.com
#
# On macOS (and Linux without systemd, such as WSL) it installs the Antseed CLI
# for the current user with npm, starts the gateway in the background and
# prints a link to claim its console. Docs: https://antseed.com/docs/quickstart

set -euo pipefail

BASE_URL="${ANTSEED_INSTALL_BASE_URL:-https://antseed.com}"
CLI_VERSION="${ANTSEED_CLI_VERSION:-latest}"
PORT="${ANTSEED_GATEWAY_PORT:-8379}"
DATA_DIR="${ANTSEED_DATA_DIR:-$HOME/.antseed}"
LOG_FILE="$DATA_DIR/gateway.log"
DRY_RUN="${ANTSEED_INSTALL_DRY_RUN:-0}"
NODE_MIN=20
DOCS_URL="https://antseed.com/docs/install"
TMP_DIR=""

if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  C_RED=$'\033[31m' C_GREEN=$'\033[1;32m' C_BOLD=$'\033[1m' C_RESET=$'\033[0m'
else
  C_RED="" C_GREEN="" C_BOLD="" C_RESET=""
fi
die() { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
step() { printf '%s==>%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
note() { printf '    %s\n' "$*"; }
# In dry-run mode, print commands that change the system instead of running them.
run() { if [[ "$DRY_RUN" == 1 ]]; then note "would run: $*"; else "$@"; fi; }

# Stdin is the script itself under curl | bash: give child processes the terminal instead.
tty_in() { if { : </dev/tty; } 2>/dev/null; then "$@" </dev/tty; else "$@" </dev/null; fi; }

install_server() {
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  step "Linux with systemd: running the server installer ($BASE_URL/install-gateway.sh)"
  curl -fsSL --proto '=https' --tlsv1.2 "$BASE_URL/install-gateway.sh" -o "$TMP_DIR/install-gateway.sh" \
    || die "could not download $BASE_URL/install-gateway.sh"
  local args=("$@")
  if [[ "$DRY_RUN" == 1 ]]; then args+=(--dry-run); fi
  if [[ "$(id -u)" -eq 0 ]]; then
    tty_in bash "$TMP_DIR/install-gateway.sh" "${args[@]}"
  else
    command -v sudo >/dev/null 2>&1 || die "run as root, or install sudo"
    note "It needs root: sudo may ask for your password."
    tty_in sudo bash "$TMP_DIR/install-gateway.sh" "${args[@]}"
  fi
}

ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi
  if [[ "$major" -ge "$NODE_MIN" ]]; then return 0; fi
  if [[ "$(uname -s)" == Darwin ]] && command -v brew >/dev/null 2>&1; then
    step "Installing Node.js with Homebrew (found ${major/#0/none}, need $NODE_MIN or later)"
    run brew install node
    if [[ "$DRY_RUN" != 1 ]]; then hash -r; ensure_node_installed; fi
    return 0
  fi
  die "Antseed needs Node.js $NODE_MIN or later (found ${major/#0/none}). Install it from https://nodejs.org and run this again."
}
ensure_node_installed() {
  command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MIN" ]] \
    || die "Node.js $NODE_MIN or later is still not on PATH. Install it from https://nodejs.org and run this again."
}

install_cli() {
  local prefix target
  prefix="$(npm prefix -g)" || die "npm is not working; reinstall Node.js from https://nodejs.org"
  target="$prefix/lib/node_modules"; [[ -d "$target" ]] || target="$prefix"
  [[ -w "$target" ]] || die "npm cannot write to $target without sudo. Point npm at a folder you own
    (npm config set prefix ~/.npm-global, then add ~/.npm-global/bin to PATH), or use a Node version
    manager such as nvm, and run this again. Do not use sudo npm."
  step "Installing @antseed/cli@$CLI_VERSION"
  run npm install -g --no-fund --no-audit "@antseed/cli@$CLI_VERSION"
  # Prefer the binary npm just installed over another one earlier on PATH.
  ANTSEED="$prefix/bin/antseed"
  if [[ ! -x "$ANTSEED" ]]; then ANTSEED="$(command -v antseed || true)"; fi
  if [[ -z "$ANTSEED" && "$DRY_RUN" != 1 ]]; then die "antseed was installed but is not on PATH; add $prefix/bin to PATH"; fi
  ANTSEED="${ANTSEED:-antseed}"
}

gateway_up() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/console/api/auth/config" 2>/dev/null; }

start_gateway() {
  if gateway_up; then step "The gateway is already running on port $PORT"; return 0; fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $PORT is in use by something else. Pick another with ANTSEED_GATEWAY_PORT=<port>."
  fi
  step "Starting the gateway and its buyer in the background"
  if [[ "$DRY_RUN" == 1 ]]; then note "would run: nohup $ANTSEED gateway start --port $PORT >>$LOG_FILE 2>&1 &"; return 0; fi
  mkdir -p "$DATA_DIR"
  nohup "$ANTSEED" gateway start --port "$PORT" >>"$LOG_FILE" 2>&1 </dev/null &
  GATEWAY_PID=$!
  echo "$GATEWAY_PID" >"$DATA_DIR/gateway.pid"
  # The gateway listens once its buyer answers, which can take up to a minute.
  local i
  for ((i = 0; i < 90; i++)); do
    if gateway_up; then return 0; fi
    kill -0 "$GATEWAY_PID" 2>/dev/null || { tail -n 20 "$LOG_FILE" >&2; die "the gateway exited; see $LOG_FILE"; }
    sleep 1
  done
  die "the gateway did not answer on port $PORT within 90 seconds; see $LOG_FILE"
}

open_url() {
  if [[ "$DRY_RUN" == 1 || -n "${ANTSEED_INSTALL_NO_OPEN:-}" ]]; then return 0; fi
  if [[ "$(uname -s)" == Darwin ]]; then open "$1" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

install_local() {
  [[ "$#" -eq 0 ]] || die "options are for the Linux server installer; on this machine run it without arguments"
  ensure_node
  install_cli
  start_gateway
  local console="http://localhost:$PORT/console" link=""
  if [[ "$DRY_RUN" != 1 ]]; then
    local json
    json="$("$ANTSEED" gateway console-link --port "$PORT" --json)" || die "could not create a console link; see $LOG_FILE"
    link="$(printf '%s' "$json" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.setupLink||"")')"
    console="$(printf '%s' "$json" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).url)')"
  fi
  printf '\n%sAntseed gateway is running.%s\n\n' "$C_BOLD" "$C_RESET"
  if [[ -n "$link" ]]; then
    printf '  Claim your console (single use, valid for 1 hour):\n  %s%s%s\n\n' "$C_BOLD" "$link" "$C_RESET"
    open_url "$link"
  else
    open_url "$console"
  fi
  note "Console:   $console"
  note "API base:  http://localhost:$PORT/v1"
  note "Log:       $LOG_FILE"
  local pid="${GATEWAY_PID:-}"
  if [[ -z "$pid" && -f "$DATA_DIR/gateway.pid" ]] && kill -0 "$(cat "$DATA_DIR/gateway.pid")" 2>/dev/null; then
    pid="$(cat "$DATA_DIR/gateway.pid")"
  fi
  if [[ -n "$pid" ]]; then note "Stop:      kill $pid   (the PID is saved in $DATA_DIR/gateway.pid)"
  else note "Stop:      Ctrl-C or kill the \`antseed gateway start\` process already running"; fi
  note "Start:     antseed gateway start   (or run this installer again)"
  note "Next:      https://antseed.com/docs/quickstart#claim-the-console"
}

# The whole script runs from main, so a truncated download executes nothing.
main() {
  case "$(uname -s)" in
    Linux)
      if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then install_server "$@"
      else install_local "$@"; fi ;;
    Darwin) install_local "$@" ;;
    *) die "this installer supports macOS and Linux (including WSL). For Windows, see $DOCS_URL" ;;
  esac
}

main "$@"
