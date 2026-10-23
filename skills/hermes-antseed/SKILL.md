---
name: hermes-antseed
description: "Switch a running Hermes agent's model backend to the Antseed P2P AI network, safely: check the buyer proxy and funds, pick a model that actually answers, add Antseed as a provider, test it, then make it the default. Written for the Hermes agent to follow on itself. Use when: the user asks Hermes to connect to / run on Antseed, change its Antseed model, or fix an Antseed connection."
user-invocable: true
metadata: { "hermes-antseed": { "emoji": "🐝" } }
---

# Run Hermes on Antseed

Antseed is a peer-to-peer market for AI inference. A **buyer proxy** runs on the user's machine at
`http://127.0.0.1:8377/v1` (OpenAI-compatible), finds sellers, and pays them per request in USDC from the user's
Antseed balance. You'll point Hermes at that proxy.

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
4. **Don't run `antseed buyer start` in your terminal tool.** It runs forever and dies with your session. If the
   buyer isn't running, install it as a background service (step 3).
5. **Don't restart your own gateway.** At the end, ask the user to send `/restart` (step 8).
6. **No `sudo`, no deleting files.** Nothing here needs either.
7. 🙋 marks steps that need the user. Stop, ask, and wait for their answer.

## Step 0 — Same machine or remote? 🙋 only if unclear

If Hermes and the Antseed buyer (CLI or desktop app) run on the same computer, follow the steps as written. If
Hermes runs on a server and the buyer runs on the user's own computer, read **Remote Hermes** at the end first.

## Step 1 — Snapshot and note the current model

```bash
hermes backup --quick --label before-antseed
echo "provider: $(hermes config get model.provider)  model: $(hermes config get model.default)"
```

Keep the snapshot id it prints (e.g. `20261021-215105-before-antseed`) and the current provider and model: these
are OLD_PROVIDER and OLD_MODEL, your way back.

## Step 2 — Antseed CLI

```bash
antseed --version || echo "MISSING"
```

If missing: `node --version` must be 20 or newer. Then run `npm install -g @antseed/cli`; it can take 1–3
minutes, so use a long timeout. If Node isn't installed, 🙋 ask the user to install Node.js 20+ (nodejs.org) and
tell you when it's done.

## Step 3 — Is the buyer running?

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

## Step 4 — Is there money to pay sellers? 🙋 if not

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
  curl -s -m 90 http://127.0.0.1:8377/v1/chat/completions \
    -H 'Content-Type: application/json' -H 'Authorization: Bearer antseed-p2p' \
    -d "{\"model\":\"$1\",\"stream\":false,\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with: ok\"}]}" \
  | grep -q '"choices"' && echo "OK   $1" || echo "FAIL $1"
}
for m in kimi-k3 kimi-k2.6 glm-5.1 deepseek-v4-pro minimax-m2.7 deepseek-v4-flash; do try_model "$m"; done
```

If the user named a model, test that one first. More ids: `curl -s http://127.0.0.1:8377/v1/models` (each entry's
`peers` list shows sellers and prices). Each test costs a fraction of a cent.

- **MAIN** = the user's choice if it says OK, otherwise the first OK in the list above (strongest first).
- **HELPER** = the first OK of `minimax-m2.7` or `deepseek-v4-flash` (cheap), otherwise MAIN.
- Don't use the id `antseed`. It means "whatever is picked in the desktop app" and fails with `no_default_route`
  unless the user runs the desktop app and has picked a model there.

No model says OK: run `antseed buyer status` and check the balance. If it's funded, the network may be thin right
now. Tell the user and stop; nothing has been changed yet.

## Step 6 — Add Antseed as a provider, then test it before switching

```bash
hermes config set ANTSEED_API_KEY antseed-p2p                  # stored in Hermes' .env; any non-empty value works locally
hermes config set providers.antseed.name Antseed
hermes config set providers.antseed.base_url http://127.0.0.1:8377/v1
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

It must print `default-ok`. If it doesn't, switch back right away and report the error:

```bash
hermes config set model.provider OLD_PROVIDER
hermes config set model.default OLD_MODEL
```

## Step 8 — Wrap up 🙋

Run `antseed buyer metering` (a channel should show your test requests) and `antseed buyer balance`. Then send the
user, briefly:

- the model you're now on (MAIN) and the helper model (HELPER)
- their Available balance
- that each request is paid per use from that balance
- how to undo: send `/snapshot restore <snapshot id from step 1>`, then `/restart`
- the last step: **"Send `/restart` so I come back on Antseed."** (In a terminal-only session, starting a new
  `hermes` session is enough.) Don't restart the gateway yourself.

## Remote Hermes (buyer on another computer)

Never expose port 8377 to the internet. On the computer that runs the buyer, the user opens the Antseed desktop
app → **Agents** → **Define your internet-accessible Antseed endpoint**, starts the public endpoint from there, and sends
you the **OpenAI base URL** and the generated **`antseed_…` API key** (🙋). Then:

- Skip steps 2–4 on the Hermes host. Funding and the buyer live on the user's computer, so ask them to confirm it's
  funded.
- In step 5, replace `http://127.0.0.1:8377/v1` with their URL and `Bearer antseed-p2p` with `Bearer <their key>`.
- In step 6, use their URL for `providers.antseed.base_url` and their key for `ANTSEED_API_KEY`.

## Changing models later

Repeat step 5 for the new model, then `hermes config set model.default <model>` and ask the user to send
`/restart`. The buyer stays up and picks a seller for the new model automatically.

Pinning a seller is optional and turns off failover: `antseed buyer connection set --peer <peerId>`, or
`<peerId>@<model>` as the model id. Undo with `antseed buyer connection clear`.

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `curl: (7) Failed to connect … 8377` | Buyer not running | Step 3 |
| `no_default_route` | Model id `antseed` used without a model picked in the desktop app | Use a concrete id from step 5 |
| `model_not_found … No policy-allowed peer currently serves model` | No seller that meets the trust/price policy serves it right now | Pick another OK model from step 5 |
| `HTTP 400: Stream must be set to true` | Model served only over the streaming Responses protocol | Choose MAIN/HELPER that passed step 5 (non-streaming) |
| `402` / `insufficient_deposits` | Balance too low or tied up in channel reserves | Step 4; `antseed buyer balance` shows Available vs Reserved |
| `Unknown provider 'antseed'` | Provider block missing or keys misspelled | `hermes config get providers.antseed`, redo step 6 |
| Hermes still answers with the old model | Gateway hasn't reloaded | User sends `/restart` |
