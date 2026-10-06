---
sidebar_position: 3
slug: /guides/public-tunnels
title: Public HTTPS Tunnels
description: Expose the Antseed AI VPN's authenticated OpenAI-compatible API through Cloudflare Tunnel or ngrok for Cursor, remote agents, servers, and custom SDK clients.
---

# Public HTTPS Tunnels

The AI VPN normally exposes its buyer API only on `localhost`. A public tunnel gives that API an authenticated HTTPS address so a client running somewhere else can reach it.

This is useful for:

- **Remote agents and servers** that need to use the models and routing policy configured on your AI VPN.
- **Cursor and other hosted AI clients** whose requests may originate outside your computer.
- **Custom applications and SDKs** that support an OpenAI-compatible base URL and API key.

The tunnel does not expose the whole desktop or the unrestricted local proxy. Antseed places a small authenticated gateway in front of the buyer API and permits only the supported model routes listed below.

:::warning Protect the API key
Anyone with the public URL and API key can send requests through your AI VPN and spend its available Antseed credits. Store the key as a secret, rotate the tunnel configuration if it is exposed, and stop the tunnel when you no longer need remote access.
:::

## Configure a tunnel in the AI VPN

Open **Tunnels** in the desktop app and configure one provider. Only one provider runs at a time, but the generated Antseed API key works with either provider.

### Cloudflare Tunnel

Use Cloudflare when you want a stable hostname on a domain you control.

1. Create a named tunnel in Cloudflare Zero Trust.
2. Add a public hostname whose service points to `http://localhost:8379`.
3. Copy the tunnel's run token.
4. In **AI VPN → Tunnels → Cloudflare Tunnel**, paste the token and the public `https://` hostname.
5. Select **Save and start**.

The AI VPN manages the local authenticated gateway and starts the bundled `cloudflared` process with your named-tunnel token.

### ngrok

Use ngrok for a quick generated endpoint or an ngrok static domain.

1. Install the ngrok CLI and copy your account authtoken.
2. In **AI VPN → Tunnels → ngrok**, paste the authtoken.
3. Leave **Public hostname** blank for a generated `ngrok-free.dev` URL, or enter your configured static ngrok domain.
4. Select **Save and start**.

After the tunnel starts, the page displays two connection values:

- **OpenAI base URL** — for example, `https://example.ngrok-free.dev/v1`.
- **API key** — an Antseed-generated secret beginning with `antseed_`.

## Authentication

Send the API key as an HTTP bearer token:

```http
Authorization: Bearer antseed_your_api_key
```

The public gateway accepts the standard `Authorization` header. It does not use `x-api-key`, URL query parameters, cookies, or a key embedded in the hostname. The gateway validates the bearer token and removes it before forwarding the request to the local buyer proxy.

## Test the connection

Set the values copied from the AI VPN:

```bash
export ANTSEED_BASE_URL="https://your-tunnel.example/v1"
export ANTSEED_API_KEY="antseed_your_api_key"
```

List the models currently available through your AI VPN:

```bash
curl "$ANTSEED_BASE_URL/models" \
  -H "Authorization: Bearer $ANTSEED_API_KEY"
```

Send an OpenAI-compatible chat request:

```bash
curl "$ANTSEED_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello from a remote client"}]
  }'
```

## Use it with Cursor

In Cursor's model settings:

1. Enable the OpenAI API key option and paste the Antseed tunnel API key.
2. Enable **Override OpenAI Base URL** and paste the complete AI VPN value ending in `/v1`.
3. Add or select a model ID returned by `GET /v1/models`.
4. Run a small request and confirm it appears in the AI VPN or tunnel logs.

Use the **Antseed API key shown in AI VPN → Tunnels**, not your ngrok authtoken or Cloudflare tunnel token. Paste it into Cursor's **OpenAI API Key** field; Cursor sends that value to the tunnel as `Authorization: Bearer <API_KEY>`.

The public URL matters for Cursor because some Cursor flows can originate from Cursor's infrastructure rather than directly from your local Electron process. A `localhost` URL, private LAN address, or hostname that resolves only on your computer cannot be reached from such a flow.

If Cursor shows its own “resource not found” page and the tunnel receives no request, the failure happened before Antseed. Recheck Cursor's base URL override, API-key setting, and custom model configuration. If the tunnel log receives the request, use the HTTP status and troubleshooting section below.

## Use it from an OpenAI SDK

Most OpenAI-compatible SDKs need only the public base URL and API key. For example, with the JavaScript OpenAI SDK:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.ANTSEED_BASE_URL,
  apiKey: process.env.ANTSEED_API_KEY,
});

const response = await client.responses.create({
  model: 'deepseek-v4-flash',
  input: 'Explain peer-to-peer model routing in one paragraph.',
});
```

Use the same configuration in remote agent runtimes, CI workers, hosted development environments, or your own backend. Keep the API key in the platform's secret manager rather than source control.

## Supported public routes

The tunnel gateway intentionally allows only these routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/models` | List available models and routes |
| `POST` | `/v1/messages` | Anthropic-compatible messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible token-count preflight |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/images/generations` | Image generation |
| `POST` | `/v1/images/edits` | Image editing |

Other paths return `404 Not Found`. Requests without the exact bearer key return `401 Unauthorized`.

## CLI setup

For a headless machine, start the buyer proxy first and run the tunnel as a separate CLI process.

Cloudflare example:

```bash
export CLOUDFLARED_TUNNEL_TOKEN="your_named_tunnel_token"
export ANTSEED_TUNNEL_PUBLIC_URL="https://llm.example.com"
export ANTSEED_TUNNEL_API_KEY="antseed_generate_a_long_random_secret"

antseed tunnel start --provider cloudflare
```

ngrok example:

```bash
export NGROK_AUTHTOKEN="your_ngrok_authtoken"
export ANTSEED_TUNNEL_API_KEY="antseed_generate_a_long_random_secret"

# Optional for a static ngrok domain:
# export ANTSEED_TUNNEL_PUBLIC_URL="https://example.ngrok-free.dev"

antseed tunnel start --provider ngrok
```

Use `antseed tunnel status` from another terminal to inspect the active public URL, and `antseed tunnel stop` to stop it.

## Troubleshooting

### The tunnel receives no request

- Confirm the client uses the complete public base URL ending in `/v1`.
- Test `GET /v1/models` with `curl` from a different network.
- Confirm public DNS resolves and the tunnel is running.
- Check whether the client sends requests from a hosted backend that blocks free tunnel domains or displays an interstitial page.

### `401 Invalid API key`

- Send `Authorization: Bearer <API_KEY>` exactly.
- Do not put the key in the URL.
- Copy the Antseed API key, not the Cloudflare tunnel token or ngrok authtoken.

### `404 Not found`

- Use one of the supported routes above.
- Configure SDKs with the base URL ending in `/v1`; do not append `/v1` twice.
- For a raw HTTP call, use a path such as `/v1/models` or `/v1/responses`.

### `502 Antseed buyer proxy is unavailable`

The public tunnel is running, but the local buyer proxy is not accepting requests on its configured port. Start the AI VPN router or `antseed buyer start`, then retry.

For local-only integrations that do not need a public endpoint, see [Using the API](/docs/guides/using-the-api).
