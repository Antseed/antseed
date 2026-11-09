---
name: hermes-antseed
description: "Switch a running Hermes agent's model backend to the Antseed P2P AI network, safely: use the user's Antseed gateway or set one up on this computer as a background service, check funds, pick a model that actually answers, add Antseed as a provider, test it, then make it the default. Written for the Hermes agent to follow on itself. Use when: the user asks Hermes to connect to / run on Antseed, change its Antseed model, or fix an Antseed connection."
user-invocable: true
metadata: { "hermes-antseed": { "emoji": "🐝" } }
---

# Run Hermes on Antseed

Antseed is a peer-to-peer market for AI inference. A **buyer** finds sellers and pays them per request in USDC.
Hermes talks to an Antseed **gateway**: an OpenAI-compatible API in front of a buyer that gives Hermes its own API
key, with its own budget and usage log. You need two values:

- **Base URL**, ending in `/v1`: `http://localhost:8379/v1` for a gateway on this computer, or the
  `https://…/v1` address of a gateway on a server or published through a tunnel.
- **API key** (`antseed_…`), sent as `Authorization: Bearer`.

If the user has no gateway, you set one up on this computer (step 2): one `antseed` command installs it as a
background service, with the buyer it needs.

## Rules (read first)

You are changing the config of the model you're running on. A mistake can leave the user with an agent that can't
reply. So:

1. **Snapshot first, and note what you're switching from** (step 1).
2. **Add Antseed next to the current provider, test it, and only then switch** (steps 5 and 6).
3. **Change config only with `hermes config set`, run from the terminal tool.** Don't open, edit, copy or
   overwrite `config.yaml` or `.env` with file tools or `cp`: the `hermes` CLI always targets the right Hermes home
   (yours may not be `~/.hermes`, e.g. with profiles), and direct writes trigger approval prompts. Don't read
   `.env`; it holds secrets. Never put a model id in a config *key* path
   (`providers.antseed.models.kimi-k2.6…`), because the dots get split into nested keys. Model ids are fine as
   *values* (`hermes config set model.default kimi-k2.6`).
4. **Don't run `antseed gateway start` or `antseed buyer start` in your terminal tool.** They run forever and die
   with your session. `antseed gateway service install` (step 2) runs the gateway in the background instead.
5. **Don't restart your own Hermes gateway.** At the end, ask the user to send `/restart` (step 7).
6. **No `sudo`, no deleting files.** Nothing here needs either.
7. **Keep the API key out of sight.** It lives in one file only you can read (step 0). Don't echo it, paste it into
   chat, or type it into a command; read it from the file. The `antseed_curl` helper sends it to curl through stdin.
8. 🙋 marks steps that need the user. Stop, ask, and wait for their answer.

## Step 0 — Which gateway? 🙋 if the user hasn't said

- **The user gave you a gateway base URL and key:** use them.
- **No gateway yet (the usual case):** you'll set one up on this computer in step 2. Tell the user, and go on.
- **Hermes runs on a server and the user wants to pay from their own computer:** 🙋 ask them to publish a gateway
  from that computer (`antseed tunnel start`, or the desktop app's **Agents → Internet-accessible endpoint**),
  claim its console straight away (**Claim console** in the desktop app, or `antseed gateway console-link`), and
  send you the base URL and a key from the console's **Keys**. See
  [Tunnels](https://antseed.com/docs/tunnels).

Save the two values where every later command can read them, even if your terminal tool doesn't keep variables
between calls. For a gateway you set up in step 2, step 2 does this for you. For values the user sent you
(replace both placeholders; the key goes only into this file):

```bash
mkdir -p "$HOME/.antseed/hermes" && chmod 700 "$HOME/.antseed/hermes"
printf '%s\n' 'https://gateway.example.com/v1' > "$HOME/.antseed/hermes/base-url"
( umask 077 && printf '%s\n' 'PASTE-THE-KEY-HERE' > "$HOME/.antseed/hermes/api-key" )
```

Start every command below that talks to the gateway with these two lines (they never print the key):

```bash
ANTSEED_BASE_URL="$(cat "$HOME/.antseed/hermes/base-url")"
antseed_curl() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.antseed/hermes/api-key")" | curl -s -K - "$@"; }
```

For a gateway the user sent you, check it answers now, then do step 1 and skip to step 4:

```bash
antseed_curl -o /dev/null -w '%{http_code}\n' -m 15 "$ANTSEED_BASE_URL/models"
```

`200`: good. `401`: wrong key or base URL (🙋 ask again). Anything else, or no answer: the gateway isn't reachable
from here; tell the user and stop.

## Step 1 — Snapshot and note the current model

```bash
hermes backup --quick --label before-antseed
echo "provider: $(hermes config get model.provider)  model: $(hermes config get model.default)"
```

Keep the snapshot id it prints (e.g. `20261021-215105-before-antseed`) and tell the user the current provider and
model. Then go on to step 2, or to step 4 for a gateway the user sent you.

## Step 2 — Set up a gateway on this computer (no gateway yet)

Skip this step if the user gave you a gateway in step 0.

**The CLI.** It needs Node.js 20 or newer. If `node --version` fails or is older, 🙋 ask the user to install
Node.js 20+ (nodejs.org) and tell you when it's done. Then:

```bash
antseed gateway service --help >/dev/null 2>&1 && echo READY || echo INSTALL
```

`INSTALL` (no CLI, or one too old for `gateway service`): install or upgrade it. It can take a few minutes, so use a
long timeout. `--allow-scripts` lets npm build the CLI's database and networking modules; recent npm versions skip
them otherwise and the CLI can't start.

```bash
npm install -g @antseed/cli@latest --allow-scripts=@antseed/node,better-sqlite3,node-datachannel
```

**The background service.** This installs the gateway as a launchd agent (macOS) or systemd user service (Linux)
that starts at login and restarts if it stops. It starts the buyer too, or uses one already running here, and
waits until both answer (the first start can take a minute or two):

```bash
antseed gateway service status || antseed gateway service install
```

If `status` already shows the gateway answering (a gateway the user runs here), the install is skipped. If the
install fails, show the user its output and the log command it prints, and stop. On a Linux server, if it says the
service stops at logout, tell the user to run the `loginctl enable-linger` command it prints, once (🙋, it needs
`sudo`, so never run it yourself).

**A key for Hermes**, saved straight into the key file without showing it. A key saved by an earlier run is
reused while the gateway still accepts it:

```bash
mkdir -p "$HOME/.antseed/hermes" && chmod 700 "$HOME/.antseed/hermes"
printf '%s\n' 'http://localhost:8379/v1' > "$HOME/.antseed/hermes/base-url"
antseed_curl() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.antseed/hermes/api-key")" | curl -s -K - "$@"; }
if [ -s "$HOME/.antseed/hermes/api-key" ] && antseed_curl -o /dev/null -w '%{http_code}' -m 15 'http://localhost:8379/v1/models' | grep -qx 200; then
  echo KEY-REUSED
else
  ( umask 077 && antseed gateway key create --label hermes | sed -n 's/^API key: //p' > "$HOME/.antseed/hermes/api-key" )
  test -s "$HOME/.antseed/hermes/api-key" && echo KEY-SAVED || echo KEY-FAILED
fi
```

## Step 3 — Is there money to pay sellers? 🙋 if not (gateway on this computer)

Skip this step for a gateway the user sent you: its funding is in its own console.

```bash
antseed buyer balance
```

Read the `Deposits Account → Available` line. **0.5 USDC or more**: go to step 4. Less than that: get the funding
address:

```bash
antseed buyer deposit --no-watch
```

Send the user the address with this message: "To pay for AI requests, add funds to Antseed: send USDC **on the Base
network** to `<address>` (first deposit at least $1). You can also pay by card in the gateway console: run
`antseed gateway console-link` on this computer, open the link to claim the console, then go to **Wallet &
Funding**. Tell me when it's done." The gateway's buyer picks up the deposit automatically. Re-check
`antseed buyer balance` when they reply. Nobody needs ETH for gas. Never ask for or handle private keys.

## Step 4 — Pick models that actually answer

A model being listed in `/v1/models` doesn't mean a seller you can use is serving it right now. Test with a real
non-streaming request. Non-streaming matters, because Hermes' background helpers (titles, compression) don't
stream. Ids are case-sensitive and change over time, so take them from the list, never from memory:

```bash
ANTSEED_BASE_URL="$(cat "$HOME/.antseed/hermes/base-url")"
antseed_curl() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.antseed/hermes/api-key")" | curl -s -K - "$@"; }
antseed_curl -m 30 "$ANTSEED_BASE_URL/models?type=text" \
  | python3 -c 'import json,sys; print("\n".join(m["id"] for m in json.load(sys.stdin)["data"]))' > "$HOME/.antseed/hermes/models.txt"
wc -l < "$HOME/.antseed/hermes/models.txt"
grep -iE 'kimi|glm|deepseek|qwen|minimax' "$HOME/.antseed/hermes/models.txt" | head -20
```

Then test candidates, strongest first (a user's own choice first; replace the ids with ones from the list):

```bash
ANTSEED_BASE_URL="$(cat "$HOME/.antseed/hermes/base-url")"
antseed_curl() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.antseed/hermes/api-key")" | curl -s -K - "$@"; }
try_model() {
  antseed_curl -m 90 "$ANTSEED_BASE_URL/chat/completions" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$1\",\"stream\":false,\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with: ok\"}]}" \
  | grep -q '"choices"' && echo "OK   $1" || echo "FAIL $1"
}
for m in FIRST-ID SECOND-ID THIRD-ID; do try_model "$m"; done
```

Each test costs a fraction of a cent. Each entry in `/models` also has a `peers` list with sellers and prices; a
gateway key limited to certain models lists only those.

- **MAIN** = the user's choice if it says OK, otherwise the strongest model that says OK.
- **HELPER** = a cheap, fast model that says OK (a `flash`, `mini` or small variant), otherwise MAIN.
- Don't use the id `antseed`. It means "whatever is picked in the desktop app" and fails with `no_default_route`
  through a gateway. Always use concrete ids.

No model says OK: show the user the response of one failed test (drop `| grep …` to see it). `402
insufficient_deposits` means the wallet is empty: for a gateway on this computer, go back to step 3; otherwise 🙋
ask an admin to add funds in the console's **Wallet & Funding**. `402 spend_limit_reached`, `403
model_not_allowed` or `401` come from the gateway key's budget, routing policy or validity: 🙋 the user fixes them
in the console. `429 free_tier_exhausted` means that model's free sellers are busy: try another model, or again in a
few minutes. Otherwise the network may be thin right now. Tell the user and stop; nothing has been changed yet.

## Step 5 — Add Antseed as a provider, then test it before switching

```bash
hermes config set ANTSEED_API_KEY "$(cat "$HOME/.antseed/hermes/api-key")"   # Hermes keeps it with its secrets
hermes config set providers.antseed.name Antseed
hermes config set providers.antseed.base_url "$(cat "$HOME/.antseed/hermes/base-url")"
hermes config set providers.antseed.key_env ANTSEED_API_KEY
hermes config set providers.antseed.api_mode chat_completions
hermes config set providers.antseed.default_model MAIN         # replace MAIN with the model from step 4
```

Test it while your current provider is still the default:

```bash
hermes -z "Reply with exactly: antseed-ok" --provider antseed -m MAIN
```

It must print `antseed-ok`. If it doesn't, don't switch. Check **Troubleshooting**, fix, and re-test. If you're
stuck, remove the half-done provider with `hermes config unset providers.antseed` and report the error to the
user.

## Step 6 — Make Antseed the default

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

## Step 7 — Wrap up 🙋

The test requests show under **Logs** in the Gateway Console. This shows the key's spend and limits:

```bash
ANTSEED_BASE_URL="$(cat "$HOME/.antseed/hermes/base-url")"
antseed_curl() { printf 'header = "Authorization: Bearer %s"\n' "$(cat "$HOME/.antseed/hermes/api-key")" | curl -s -K - "$@"; }
antseed_curl -m 15 "$ANTSEED_BASE_URL/key"
```

For a gateway on this computer, `antseed buyer balance` shows what's left. Then send the user, briefly:

- the model you're now on (MAIN) and the helper model (HELPER)
- the gateway's base URL, and that it runs as a background service if you set it up — never the key
- the key's spend so far, and the Available balance for a gateway on this computer
- that each request is paid per use from the gateway's wallet
- for a gateway you set up: `antseed gateway console-link` opens its console (keys, budgets, logs, card funding),
  and `antseed gateway service uninstall` removes the background service
- how to undo: send `/snapshot restore <snapshot id from step 1>`, then `/restart`
- the last step: **"Send `/restart` so I come back on Antseed."** (In a terminal-only session, starting a new
  `hermes` session is enough.) Don't restart the Hermes gateway yourself.

Never expose the gateway's buyer port (8377) to other machines, for example with a port forward, `socat` or a
reverse proxy: it checks no key, so anyone who reaches it can spend the user's funds. To reach a gateway from
another machine, use a tunnel or the server installer's HTTPS setup.

## Changing models later

Repeat step 4 for the new model, then `hermes config set model.default <model>` and ask the user to send
`/restart`. The gateway stays up and picks a seller for the new model automatically.

Pinning a seller is optional and turns off failover: use `<peerId>@<model>` as the model id.

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `curl: (7) Failed to connect … 8379` | Gateway on this computer not running | `antseed gateway service status`; `antseed gateway service install` |
| `401 invalid_api_key`, `key_revoked`, `key_expired` | Gateway key wrong, revoked or expired, or wrong base URL | New key (step 2, or 🙋 from the console's **Keys**); redo step 5 |
| `402 spend_limit_reached` | A gateway budget (key, member or workspace) ran out | 🙋 Wait for `resets_at`, or an admin raises the limit |
| `403 model_not_allowed` | The gateway key's routing policy doesn't allow that model | Pick an allowed model, or 🙋 an admin allows it |
| `no_default_route` | Model id `antseed` used | Use a concrete id from step 4 |
| `model_not_found … No policy-allowed peer currently serves model` | No seller that meets the trust/price policy serves it right now | Pick another OK model from step 4 |
| `429 free_tier_exhausted` | That model's free sellers are busy | Another model, or retry in a few minutes |
| `HTTP 400: Stream must be set to true` | Model served only over the streaming Responses protocol | Choose MAIN/HELPER that passed step 4 (non-streaming) |
| `402` / `insufficient_deposits` | Balance too low or tied up in channel reserves | Gateway on this computer: step 3 (`antseed buyer balance` shows Available vs Reserved). Otherwise 🙋 add funds in the console's **Wallet & Funding** |
| `Unknown provider 'antseed'` | Provider block missing or keys misspelled | `hermes config get providers.antseed`, redo step 5 |
| Hermes still answers with the old model | Hermes hasn't reloaded | User sends `/restart` |
