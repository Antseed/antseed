---
name: hermes-antseed
description: "Switch a running Hermes agent's model backend to the Antseed P2P AI network, safely: check the endpoint (a gateway API key, or the local buyer proxy) and funds, pick a model that actually answers, add Antseed as a provider, test it, then make it the default. Written for the Hermes agent to follow on itself. Use when: the user asks Hermes to connect to / run on Antseed, change its Antseed model, or fix an Antseed connection."
user-invocable: true
metadata: { "hermes-antseed": { "emoji": "🐝" } }
---

# Run Hermes on Antseed

Antseed is a peer-to-peer market for AI inference. A **buyer** finds sellers and pays them per request in USDC.
You'll point Hermes at one of two OpenAI-compatible endpoints, both described by two values:

- **A gateway (recommended).** The user's own Antseed gateway gives Hermes an API key with its own budget and
  usage log. `ANTSEED_BASE_URL` is the gateway's base URL ending in `/v1` (`https://gateway.example.com/v1` on a
  server or tunnel, `http://localhost:8379/v1` for a gateway on this computer) and `ANTSEED_API_KEY` is a gateway
  key (`antseed_…`), always sent as `Authorization: Bearer`. Works wherever Hermes runs.
- **The local buyer proxy.** Only when the buyer (CLI or desktop app) runs on this same computer:
  `ANTSEED_BASE_URL=http://127.0.0.1:8377/v1`. It checks no key, so `ANTSEED_API_KEY` is any placeholder
  (`antseed-p2p`). It listens on localhost only.

## Rules (read first)

You are changing the config of the model you're running on. A mistake can leave the user with an agent that can't
reply. So:

1. **Snapshot first, and note what you're switching from** (step 1).
2. **Add Antseed next to the current provider, test it, and only then switch** (steps 6 and 7).
3. **Change config only with `hermes config set`, run from the terminal tool.** Don't open, edit, copy or
   overwrite `config.yaml` or `.env` with file tools or `cp`: the `hermes` CLI always targets the right Hermes home
   (yours may not be `~/.hermes`, e.g. with profiles), and direct writes trigger approval prompts. Don't read
   `.env`; it holds secrets. Never put a model id in a config *key* path
   (`providers.antseed.models.kimi-k2.6…`), because the dots get split into nested keys. Model ids are fine as
   *values* (`hermes config set model.default kimi-k2.6`).
4. **Don't run `antseed buyer start` or `antseed gateway start` in your terminal tool.** They run forever and die
   with your session. If a local buyer isn't running, install it as a background service (step 3).
5. **Don't restart your own Hermes gateway.** At the end, ask the user to send `/restart` (step 8).
6. **No `sudo`, no deleting files.** Nothing here needs either.
7. **Treat the gateway key as a secret.** Don't echo it back, paste it into chat summaries, or write it anywhere but
   `hermes config set ANTSEED_API_KEY` (step 6).
8. 🙋 marks steps that need the user. Stop, ask, and wait for their answer.

## Step 0 — Gateway or local buyer? 🙋 if the user hasn't said

**Gateway (default).** If the user gave you a gateway base URL and API key, use them. If not, ask for them (🙋):
"Send me your Antseed gateway's base URL (ending in `/v1`) and an API key for me, from **Keys** in the Gateway
Console." If they have no gateway yet, point them to one of these, then wait for the two values:

- On their computer or a server: the [quickstart](https://antseed.com/docs/quickstart), which has the one-line
  installer for them to run. A gateway on a computer other than the one Hermes runs on
  is reachable only through a tunnel or the server installer's HTTPS setup.
- Their computer, published over HTTPS: `antseed tunnel start`, or the desktop app's **Agents → Internet-accessible
  endpoint**. Both publish a gateway and its console, so tell them to claim the console straight away
  (**Claim console** in the desktop app, or `antseed gateway console-link`). See
  [Tunnels](https://antseed.com/docs/tunnels).

**Local buyer.** Only if the user wants Hermes to use a buyer on this same computer, with no gateway.

Then set the two values in your shell for the steps below (replace the placeholders; never print the key back):

```bash
# Gateway:
export ANTSEED_BASE_URL="https://gateway.example.com/v1"   # or http://localhost:8379/v1
export ANTSEED_API_KEY="<the gateway key>"
# Local buyer on this computer instead:
# export ANTSEED_BASE_URL="http://127.0.0.1:8377/v1"
# export ANTSEED_API_KEY="antseed-p2p"
```

If your terminal tool doesn't keep variables between calls, repeat these two `export` lines at the top of each
command below that uses them.

With a gateway, check it answers now. Then do step 1 (the snapshot is what undo relies on), skip steps 2–4 (the
buyer, its wallet and funding live on the gateway) and continue with step 5:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$ANTSEED_API_KEY" | curl -s -K - -o /dev/null -w '%{http_code}\n' -m 15 "$ANTSEED_BASE_URL/models"
```

Every request that carries the key pipes it into `curl -K -` (curl's config, read from stdin) instead of putting
it on the command line, so it never appears in a process's arguments. Keep that pattern. Shell tracing
(`set -x`) or a terminal tool that records commands as run can still capture it.

`200`: go on to step 1. `401`: wrong key or base URL (🙋 ask again). Anything else, or no answer: the gateway isn't reachable
from here; tell the user and stop.

## Step 1 — Snapshot and note the current model

```bash
hermes backup --quick --label before-antseed
echo "provider: $(hermes config get model.provider)  model: $(hermes config get model.default)"
```

Keep the snapshot id it prints (e.g. `20261021-215105-before-antseed`) and tell the user the current provider and
model.

With a gateway, go on to step 5 now; steps 2–4 are for a local buyer only.

## Step 2 — Antseed CLI (local buyer only)

```bash
antseed --version || echo "MISSING"
```

If missing: `node --version` must be 20 or newer. Then run `npm install -g @antseed/cli`; it can take 1–3
minutes, so use a long timeout. If Node isn't installed, 🙋 ask the user to install Node.js 20+ (nodejs.org) and
tell you when it's done.

## Step 3 — Is the buyer running? (local buyer only)

```bash
curl -sf -m 5 http://127.0.0.1:8377/v1/models >/dev/null && echo RUNNING || echo DOWN
```

**RUNNING** (CLI service or desktop app): go to step 4.

**DOWN**: install the buyer as a background service that starts at login and restarts if it crashes.

macOS (launchd, no sudo):

```bash
ANTSEED_BIN="$(command -v antseed)"; NODE_DIR="$(dirname "$(command -v node)")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.antseed/logs"
cat > "$HOME/Library/LaunchAgents/com.antseed.buyer.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.antseed.buyer</string>
  <key>ProgramArguments</key><array><string>$ANTSEED_BIN</string><string>buyer</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.antseed/logs/buyer.log</string>
  <key>StandardErrorPath</key><string>$HOME/.antseed/logs/buyer.log</string>
</dict></plist>
EOF
plutil -lint "$HOME/Library/LaunchAgents/com.antseed.buyer.plist" && launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.antseed.buyer.plist"
```

Linux (systemd user service, no sudo):

```bash
ANTSEED_BIN="$(command -v antseed)"; NODE_DIR="$(dirname "$(command -v node)")"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/antseed-buyer.service" <<EOF
[Unit]
Description=Antseed buyer proxy
After=network-online.target

[Service]
ExecStart=$ANTSEED_BIN buyer start
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now antseed-buyer
```

On a Linux server, tell the user that keeping the service up after they log out needs a one-time
`sudo loginctl enable-linger $USER` from them (🙋, don't run it yourself).

The full path to `node` matters: with nvm, Node isn't on the service's default PATH. Then wait for the buyer to
come up (the first start can take about a minute to find sellers):

```bash
for i in $(seq 1 40); do curl -sf -m 3 http://127.0.0.1:8377/v1/models >/dev/null && { echo RUNNING; break; }; sleep 3; done
```

Still down: show the user the last 30 lines of `~/.antseed/logs/buyer.log` (macOS) or
`journalctl --user -u antseed-buyer -n 30` (Linux) and stop.

## Step 4 — Is there money to pay sellers? 🙋 if not (local buyer only)

```bash
antseed buyer balance
```

Read the `Deposits Account → Available` line. **0.5 USDC or more**: go to step 5. Less than that: stop and get the
funding address:

```bash
antseed buyer deposit --no-watch
```

Send the user the address with this message: "To pay for AI requests, add funds to Antseed: send USDC **on the Base
network** to `<address>` (first deposit at least $1), or add funds by card in the Antseed desktop app. Tell me when
it's sent." The running buyer picks up the deposit automatically. Re-check `antseed buyer balance` when they reply.
The buyer never needs ETH for gas. Never ask for or handle private keys.

## Step 5 — Pick models that actually answer

A model being listed in `/v1/models` doesn't mean a seller you can use is serving it right now. Test with a real
non-streaming request. Non-streaming matters, because Hermes' background helpers (titles, compression) don't
stream.

```bash
try_model() {
  printf 'header = "Authorization: Bearer %s"\n' "$ANTSEED_API_KEY" | curl -s -K - -m 90 "$ANTSEED_BASE_URL/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$1\",\"stream\":false,\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with: ok\"}]}" \
  | grep -q '"choices"' && echo "OK   $1" || echo "FAIL $1"
}
for m in kimi-k3 kimi-k2.6 glm-5.1 deepseek-v4-pro minimax-m2.7 deepseek-v4-flash; do try_model "$m"; done
```

If the user named a model, test that one first. More ids:
`printf 'header = "Authorization: Bearer %s"\n' "$ANTSEED_API_KEY" | curl -s -K - "$ANTSEED_BASE_URL/models"` (each entry's `peers` list shows
sellers and prices; a gateway key limited to certain models lists only those). Each test costs a fraction of a cent.

- **MAIN** = the user's choice if it says OK, otherwise the first OK in the list above (strongest first).
- **HELPER** = the first OK of `minimax-m2.7` or `deepseek-v4-flash` (cheap), otherwise MAIN.
- Don't use the id `antseed`. It means "whatever is picked in the desktop app": it works only against the local
  buyer proxy of a desktop app that has a model picked, and fails with `no_default_route` otherwise. Through a
  gateway, always use concrete ids.

No model says OK: show the user the response of one failed test (drop `| grep …` to see it). `402
insufficient_deposits` means the wallet is empty: with a gateway, the workspace wallet needs funds (🙋 ask an admin
to add them in the console's **Wallet & Funding**); with a local buyer, go back to step 4. `402
spend_limit_reached`, `403 model_not_allowed` or `401` come from the gateway key's budget, routing policy or
validity: 🙋 the user fixes them in the console. Otherwise the network may be thin right now. Tell the user and
stop; nothing has been changed yet.

## Step 6 — Add Antseed as a provider, then test it before switching

```bash
hermes config set ANTSEED_API_KEY "$ANTSEED_API_KEY"             # stored in Hermes' .env: the gateway key, or the local placeholder
hermes config set providers.antseed.name Antseed
hermes config set providers.antseed.base_url "$ANTSEED_BASE_URL"
hermes config set providers.antseed.key_env ANTSEED_API_KEY
hermes config set providers.antseed.api_mode chat_completions
hermes config set providers.antseed.default_model MAIN         # replace MAIN with the model from step 5
```

Test it while your current provider is still the default:

```bash
hermes -z "Reply with exactly: antseed-ok" --provider antseed -m MAIN
```

It must print `antseed-ok`. If it doesn't, don't switch. Check **Troubleshooting**, fix, and re-test. If you're
stuck, remove the half-done provider with `hermes config unset providers.antseed` and report the error to the
user.

## Step 7 — Make Antseed the default

First save the 8 settings this step changes, so you can put each one back exactly (a setting that wasn't set is
recorded as `unset`):

```bash
mkdir -p "$HOME/.antseed"
for k in model.provider model.default model.base_url model.api_mode \
         auxiliary.title_generation.provider auxiliary.title_generation.model \
         auxiliary.compression.provider auxiliary.compression.model; do
  if v="$(hermes config get "$k" 2>/dev/null </dev/null)"; then printf 'set\t%s\t%s\n' "$k" "$v"; else printf 'unset\t%s\n' "$k"; fi
done > "$HOME/.antseed/hermes-before-antseed.tsv"
cat "$HOME/.antseed/hermes-before-antseed.tsv"
```

Then switch:

```bash
hermes config set model.provider antseed
hermes config set model.default MAIN
hermes config set model.base_url ""
hermes config set model.api_mode chat_completions
hermes config set auxiliary.title_generation.provider antseed
hermes config set auxiliary.title_generation.model HELPER
hermes config set auxiliary.compression.provider antseed
hermes config set auxiliary.compression.model HELPER
hermes -z "Reply with exactly: default-ok"
```

It must print `default-ok`. If it doesn't, put all 8 settings back right away:

```bash
while IFS=$'\t' read -r state k v; do
  if [ "$state" = set ]; then hermes config set "$k" "$v" </dev/null; else hermes config unset "$k" </dev/null 2>/dev/null || true; fi
done < "$HOME/.antseed/hermes-before-antseed.tsv"
hermes -z "Reply with exactly: restored-ok"
```

It must print `restored-ok`; then report the error to the user. If even that fails, tell the user to send
`/snapshot restore <snapshot id from step 1>` and then `/restart`.

## Step 8 — Wrap up 🙋

With a local buyer, run `antseed buyer metering` (a channel should show your test requests) and
`antseed buyer balance`. With a gateway, the test requests show under **Logs** in the Gateway Console, and
`printf 'header = "Authorization: Bearer %s"\n' "$ANTSEED_API_KEY" | curl -s -K - "$ANTSEED_BASE_URL/key"` shows the key's spend and limits.
Then send the user, briefly:

- the model you're now on (MAIN) and the helper model (HELPER)
- which endpoint you use (the gateway's base URL, or the local buyer) — never the key
- their Available balance (local buyer), or the key's spend so far (gateway)
- that each request is paid per use (from the buyer's balance, or the gateway workspace's wallet)
- how to undo: send `/snapshot restore <snapshot id from step 1>`, then `/restart`
- the last step: **"Send `/restart` so I come back on Antseed."** (In a terminal-only session, starting a new
  `hermes` session is enough.) Don't restart the gateway yourself.

## Hermes on a server, buyer on the user's computer

Use a gateway (step 0): the user publishes their computer's buyer through a tunnel (`antseed tunnel start`, or the
desktop app's **Agents → Internet-accessible endpoint**) and sends you its base URL and key. Never expose port 8377
itself, for example with a port forward, `socat` or a reverse proxy: it checks no key, so anyone who reaches it can
spend the user's funds.

## Changing models later

Repeat step 5 for the new model, then `hermes config set model.default <model>` and ask the user to send
`/restart`. The buyer stays up and picks a seller for the new model automatically.

Pinning a seller is optional and turns off failover: use `<peerId>@<model>` as the model id (works with both
endpoints). With a local buyer, `antseed buyer connection set --peer <peerId>` pins every request until
`antseed buyer connection clear`.

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `curl: (7) Failed to connect … 8377` | Local buyer not running | Step 3 |
| `401 invalid_api_key`, `key_revoked`, `key_expired` | Gateway key wrong, revoked or expired, or wrong base URL | 🙋 New key from the console's **Keys**; redo step 6 |
| `402 spend_limit_reached` | A gateway budget (key, member or workspace) ran out | 🙋 Wait for `resets_at`, or an admin raises the limit |
| `403 model_not_allowed` | The gateway key's routing policy doesn't allow that model | Pick an allowed model, or 🙋 an admin allows it |
| `no_default_route` | Model id `antseed` used without a model picked in the desktop app | Use a concrete id from step 5 |
| `model_not_found … No policy-allowed peer currently serves model` | No seller that meets the trust/price policy serves it right now | Pick another OK model from step 5 |
| `HTTP 400: Stream must be set to true` | Model served only over the streaming Responses protocol | Choose MAIN/HELPER that passed step 5 (non-streaming) |
| `402` / `insufficient_deposits` | Balance too low or tied up in channel reserves | Gateway: 🙋 add funds in the console's **Wallet & Funding**. Local buyer: step 4; `antseed buyer balance` shows Available vs Reserved |
| `Unknown provider 'antseed'` | Provider block missing or keys misspelled | `hermes config get providers.antseed`, redo step 6 |
| Hermes still answers with the old model | Gateway hasn't reloaded | User sends `/restart` |
