---
sidebar_position: 3
slug: /guides/gateway-server
title: Run a Gateway on a Server
description: Install the Antseed buyer and API-key gateway on a Linux server with one command, publish it over HTTPS, and hand out keys.
---

# Run a Gateway on a Server

A [shared gateway](/docs/guides/gateway-api-keys) is most useful when it is always on. The gateway installer sets one up on a Linux server with a single command:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --domain llm.example.com
```

[Read the script](https://antseed.com/install-gateway.sh) before running it. Its source is [`apps/website/static/install-gateway.sh`](https://github.com/Antseed/antseed/blob/main/apps/website/static/install-gateway.sh) in the Antseed repository.

It:

1. Installs Node.js 24 and the Antseed CLI under `/opt/antseed`, without touching any Node.js already on the server.
2. Creates an `antseed` system user whose home, `/var/lib/antseed`, holds the wallet, the buyer identities and the key database.
3. Runs `antseed buyer start` and the gateway as the systemd services `antseed-buyer` and `antseed-gateway`, which restart on failure and start on boot.
4. Publishes the gateway over HTTPS, if you ask it to (see below).
5. Creates a first API key, unless keys already exist, and prints the base URL, the key and the wallet address.

It needs a Linux server with systemd (Ubuntu, Debian, Fedora, RHEL and similar) on x64 or arm64, and root access.

## Choose how clients reach it

| Option | What you get | Requirements |
|---|---|---|
| `--domain llm.example.com` | `https://llm.example.com/v1`, with a TLS certificate from Let's Encrypt, served by [Caddy](https://caddyserver.com) | A DNS record pointing at the server, ports 80 and 443 open. Caddy is installed on apt and dnf systems. |
| `--cloudflare-token <token> --public-url https://llm.example.com` | The gateway behind a Cloudflare named tunnel, with no inbound ports | A [Cloudflare Tunnel](/docs/guides/public-tunnels#cloudflare-tunnel) whose public hostname points at `http://localhost:8379` |
| Neither | `http://127.0.0.1:8379/v1` on the server only | Reach it over SSH: `ssh -N -L 8379:127.0.0.1:8379 user@server` |

`--host 0.0.0.0` serves plain HTTP on every interface. Use it only on a private network: API keys are bearer secrets.

Instead of passing the Cloudflare token on the command line, you can provide it in the environment:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
  | sudo CLOUDFLARED_TUNNEL_TOKEN="…" bash -s -- --public-url https://llm.example.com
```

Other options:

| Option | Default |
|---|---|
| `--port <n>` | `8379`, the gateway port |
| `--key-label <name>` | `admin`, the label of the first key |
| `--x402-facilitator <cdp\|payai\|url>` | Off. Turns on [x402 top-ups](/docs/guides/gateway-api-keys#top-up-a-key-with-x402). For `cdp`, pass `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in the environment like the Cloudflare token above |
| `--cli-version <version>` | `latest` |
| `--dry-run` | Validates the options and prints what would be installed, without changing anything |
| `--verbose` | Prints every command and npm's output |

Every option can also be set in the environment, which suits cloud-init and other automation: `ANTSEED_GATEWAY_DOMAIN`, `ANTSEED_GATEWAY_HOST`, `ANTSEED_GATEWAY_PORT`, `ANTSEED_GATEWAY_KEY_LABEL`, `ANTSEED_CLI_VERSION`, `ANTSEED_X402_FACILITATOR_URL`, `CLOUDFLARED_TUNNEL_TOKEN` and `ANTSEED_TUNNEL_PUBLIC_URL`. Run the script with `--help` for the full list.

The script validates every option before it changes anything. It finishes by checking that the gateway answers.

## After installing

The installer prints something like:

```
==> Antseed gateway is running
    Base URL:  https://llm.example.com/v1
    API key:   antseed_…
    Wallet:    0x…  (send USDC on Base to fund paid models)
```

The key is shown only once. If you run the installer from cloud-init or a CI job, it also ends up in that system's logs: revoke it there with `antseed gateway key revoke <id>` and create a new one by hand. Test it from anywhere:

```bash
curl https://llm.example.com/v1/models -H "Authorization: Bearer antseed_…"
```

Free models work right away. To use paid models, fund the wallet: send USDC on Base to the address shown, or run `antseed buyer deposit --no-watch` for the address and a QR code. The buyer deposits incoming USDC into its credits automatically.

The installer adds an `antseed` command that runs the CLI as the `antseed` user against the gateway's data, so the commands in [Shared Gateway API Keys](/docs/guides/gateway-api-keys) work as written:

```bash
antseed gateway key create --label "Alice" --new-identity --monthly-limit 20
antseed gateway key list
antseed buyer identity list --balances
```

Key changes apply immediately; there is no need to restart anything.

## Operate it

```bash
journalctl -u antseed-gateway -u antseed-buyer -f   # logs
systemctl restart antseed-buyer antseed-gateway     # restart
systemctl status antseed-gateway
```

| Path | Contents |
|---|---|
| `/var/lib/antseed/.antseed/` | The buyer's data dir: `identity.key` (the default wallet), `buyer-identities/`, `gateway/gateway.db`, `config.json` |
| `/etc/antseed/gateway.env` | Environment for the gateway service (Cloudflare token, x402 facilitator, `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`), mode 0600 |
| `/opt/antseed/` | Node.js and the CLI |

Back up `/var/lib/antseed/.antseed/identity.key` and `buyer-identities/`: each wallet can hold USDC credits. To keep identity keys in a secret manager instead, see [Keep keys out of the data dir](/docs/guides/gateway-api-keys#keep-keys-out-of-the-data-dir) and add the variables to `/etc/antseed/gateway.env` and a drop-in for `antseed-buyer` (`systemctl edit antseed-buyer`).

To change buyer settings, such as price caps, edit the config as the `antseed` user (`antseed config …`) and restart `antseed-buyer`.

## Upgrade or remove

Run the installer again with the same options to upgrade the CLI and rewrite the services. Existing wallets and keys are kept, and no new key is created.

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --uninstall
```

`--uninstall` removes the services, the `antseed` command, the Caddy site and `/opt/antseed`. If the installer replaced the stock Caddyfile, uninstalling puts the original back, discarding any edits you made to it since. It keeps `/var/lib/antseed` and `/etc/antseed`, because the wallets may still hold credits.
