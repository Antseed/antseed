---
slug: /tunnels
title: Tunnels
description: Publish your desktop app or CLI buyer at a public HTTPS tunnel endpoint through Cloudflare Tunnel or ngrok, for remote agents, Cursor and SDK clients.
---

# Tunnels

A tunnel endpoint is a public HTTPS URL for a buyer that otherwise only listens on `localhost`. Clients on other machines, hosted tools such as Cursor, and remote agents can then call it with an API key.

A tunnel runs a local gateway in front of the buyer (port `8379` by default) and publishes that gateway through Cloudflare Tunnel or ngrok. The gateway checks the API key and only allows the model routes listed in [Gateway API](/docs/gateway/api).

:::warning The tunnel also publishes the console
Unless started with `--no-console`, the tunnel serves the [Gateway Console](/docs/gateway/sign-in) at `<your tunnel URL>/console`, and the desktop app's tunnel always does. Claim it straight away: open the one-time setup link and register a passkey or connect a wallet. In the desktop app, click **Claim console** under **Gateway console** in the endpoint window; from the CLI, run `antseed gateway console-link` on the same computer. Both make the link on the tunnel's public URL, so the passkey works from anywhere. Anyone with the URL and an API key can spend your credits, so keep keys secret and stop the tunnel when you no longer need it.
:::

## From the desktop app

1. Open **Agents** and select **Internet-accessible endpoint**. The same setting is in **Preferences → Connectivity**.
2. Under **Choose a tunnel provider**, configure **ngrok** or **Cloudflare Tunnel**:
   - **ngrok**: paste your ngrok authtoken. Leave **Public hostname** blank for a generated URL, or enter your static ngrok domain.
   - **Cloudflare Tunnel**: create a named tunnel in Cloudflare Zero Trust with a public hostname pointing to `http://localhost:8379`, then paste its token and the public `https://` hostname.
3. Select **Save and start**.

**Connection details** then shows the **OpenAI base URL** (ending in `/v1`) and the **API key**. The same key works with either provider. Only one provider runs at a time.

## From the CLI

`antseed tunnel start` starts a buyer on port 8377 (or uses one already running there), starts the gateway, and publishes it. Pass `--no-buyer` to use a buyer you run yourself.

Cloudflare:

```bash
export CLOUDFLARED_TUNNEL_TOKEN="<named tunnel token>"
export ANTSEED_TUNNEL_PUBLIC_URL="https://gateway.example.com"
antseed tunnel start --provider cloudflare
```

ngrok:

```bash
export NGROK_AUTHTOKEN="<ngrok authtoken>"
# Optional, for a static ngrok domain:
# export ANTSEED_TUNNEL_PUBLIC_URL="https://example.ngrok-free.dev"
antseed tunnel start --provider ngrok
```

Clients authenticate with a gateway key from `antseed gateway key create`, or with the value of `ANTSEED_TUNNEL_API_KEY` if you set one before starting. Use `antseed tunnel status` to see the public URL and `antseed tunnel stop` to stop it.

To run a gateway permanently on a Linux server instead, see [Run a gateway on a server](/docs/gateway/server).

## Test the endpoint

```bash
export ANTSEED_BASE_URL="https://gateway.example.com/v1"
export ANTSEED_API_KEY="<your Antseed API key>"

curl "$ANTSEED_BASE_URL/models" -H "Authorization: Bearer $ANTSEED_API_KEY"

curl "$ANTSEED_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "<peerId>@deepseek-v4-flash", "messages": [{"role": "user", "content": "Hello"}]}'
```

Send the key only as `Authorization: Bearer <key>`. Use the Antseed API key, not your ngrok authtoken or Cloudflare tunnel token.

## Use it with Cursor

Cursor sends some requests from its own servers, so it cannot reach `localhost`. Use a tunnel endpoint or a gateway with a public URL.

1. In Cursor's model settings, paste the Antseed API key into the **OpenAI API Key** field.
2. Enable **Override OpenAI Base URL** and paste the base URL ending in `/v1`.
3. Add a model id returned by `GET /v1/models`, for example `<peerId>@deepseek-v4-flash`.
4. Send a small request and check that it reaches the tunnel.

If Cursor shows its own "resource not found" page and the tunnel receives nothing, recheck Cursor's base URL and key settings. For a permanent setup with a key per person, use a [gateway API key](/docs/gateway/api).

## Troubleshooting

| Problem | Fix |
|---|---|
| The tunnel receives no request | Use the full base URL ending in `/v1`. Test `GET /v1/models` with `curl` from another network. Check that the tunnel is running and its DNS resolves. |
| `401` | Send `Authorization: Bearer <key>` with the Antseed API key. Do not put the key in the URL. |
| `404` | Use a supported route and do not add `/v1` twice. |
| `502 Antseed buyer proxy is unavailable` | The buyer is not running on its port. Start the desktop app's router or `antseed buyer start`, or check the tunnel's `[buyer]` output for why it stopped. |

For clients on the same computer, skip the tunnel and use the [local buyer proxy](/docs/api).
