---
title: Run a gateway on a server
slug: /gateway/server
description: Install the Antseed buyer and gateway on a Linux server with one command, publish them over HTTPS, and keep them running.
sidebar_label: Run on a server
---

# Run a gateway on a server

A [gateway](/docs/gateway) is most useful when it is always on. The gateway installer sets one up on a Linux server with a single command.

**Prerequisites:** a Linux server with systemd (Ubuntu, Debian, Fedora, RHEL and similar) on x64 or arm64, root access, and, for HTTPS on your own domain, a DNS record pointing at the server with ports 80 and 443 open.

## Install

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --domain gateway.example.com
```

The short form does the same: on a Linux server with systemd, `install.sh` downloads `install-gateway.sh` and runs it as root through `sudo`, passing every option through.

```bash
curl -fsSL https://antseed.com/install.sh | bash -s -- --domain gateway.example.com
```

[Read the script](https://antseed.com/install-gateway.sh) before running it. Its source is [`apps/website/static/install-gateway.sh`](https://github.com/AntSeed/antseed/blob/main/apps/website/static/install-gateway.sh) in the Antseed repository. It validates every option before it changes anything, then:

1. Installs Node.js 24 and the Antseed CLI under `/opt/antseed`, without touching any Node.js already on the server.
2. Creates an `antseed` system user whose home, `/var/lib/antseed`, holds the wallets and the gateway database.
3. Runs the buyer and the gateway as the systemd services `antseed-buyer` and `antseed-gateway`, which restart on failure and start on boot.
4. Publishes the gateway over HTTPS, if you ask it to (see below).
5. Creates a first API key, unless keys already exist.
6. Checks that the gateway answers, and prints the details.

To move an existing gateway from your computer instead of starting fresh, add `--import`: see [Move a local gateway to a server](/docs/gateway/migrate).

## Choose how clients reach it

| Option | What you get | Requirements |
|---|---|---|
| `--domain gateway.example.com` | `https://gateway.example.com/v1`, with a TLS certificate from Let's Encrypt, served by [Caddy](https://caddyserver.com) | A DNS record pointing at the server, ports 80 and 443 open. Caddy is installed for you on apt and dnf systems. |
| `--cloudflare-token <token> --public-url https://gateway.example.com` | The gateway behind a Cloudflare named tunnel, with no inbound ports | A Cloudflare tunnel whose public hostname points at `http://localhost:8379` (see [Public tunnels](/docs/tunnels)) |
| `--public-url https://gateway.example.com` alone | The gateway on `127.0.0.1`, for your own reverse proxy to serve at that address | Your proxy forwards to `http://127.0.0.1:8379` |
| None of these | `http://127.0.0.1:8379/v1` on the server only | Reach it over SSH: `ssh -N -L 8379:127.0.0.1:8379 user@server` |

Pick at most one of `--domain` and `--cloudflare-token`. `--host 0.0.0.0` (without a domain or tunnel) serves plain HTTP on every interface. Use it only on a private network: API keys are bearer secrets.

Flag values are visible in `ps` and shell history, so pass secrets in the environment instead:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
  | sudo CLOUDFLARED_TUNNEL_TOKEN="…" bash -s -- --public-url https://gateway.example.com
```

### Console sign-in options

These configure how people sign in to the console. They need an `https` console address (`--domain`, a tunnel, or `--public-url https://…`). [Sign-in and access](/docs/gateway/sign-in) explains each one.

| Option | Default |
|---|---|
| `--oidc-issuer <url>`, `--oidc-client-id <id>`, `--oidc-client-secret <secret>` | Off. Sign-in with your own OpenID Connect provider, such as Google. Prefer passing the secret as `ANTSEED_OIDC_CLIENT_SECRET` in the environment. |
| `--oidc-allowed-domains <domains>` | None. Comma-separated email domains whose verified users may join without an invite. |
| `--cf-access-team-domain <domain>`, `--cf-access-aud <tag>` | Off. Trust Cloudflare Access for console sign-in. |

### Other options

| Option | Default |
|---|---|
| `--port <n>` | `8379`, the gateway port |
| `--host <addr>` | `127.0.0.1`. Ignored with `--domain` or a tunnel, which always listen on `127.0.0.1` behind the proxy. |
| `--key-label <name>` | `admin`, the label of the first key |
| `--x402-facilitator <cdp\|payai\|url>` | Off. Turns on x402 top-ups (see [API keys](/docs/gateway/api)). For `cdp`, pass `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in the environment. |
| `--cli-version <version>` | `latest` |
| `--dry-run` | Validates the options and prints what would be installed, without changing anything |
| `--verbose` | Prints every command and npm's output |

Every option can also be set in the environment, which suits cloud-init and other automation: `ANTSEED_GATEWAY_DOMAIN`, `ANTSEED_GATEWAY_HOST`, `ANTSEED_GATEWAY_PORT`, `ANTSEED_GATEWAY_KEY_LABEL`, `ANTSEED_CLI_VERSION`, `ANTSEED_X402_FACILITATOR_URL`, `CLOUDFLARED_TUNNEL_TOKEN`, `ANTSEED_GATEWAY_PUBLIC_URL` (or `ANTSEED_TUNNEL_PUBLIC_URL`), `ANTSEED_OIDC_ISSUER`, `ANTSEED_OIDC_CLIENT_ID`, `ANTSEED_OIDC_CLIENT_SECRET`, `ANTSEED_OIDC_ALLOWED_DOMAINS`, `ANTSEED_CF_ACCESS_TEAM_DOMAIN` and `ANTSEED_CF_ACCESS_AUD`. Run the script with `--help` for the full list.

### Encrypt wallet keys at rest

To keep wallet keys encrypted on disk, pass a passphrase of at least 12 characters, without single quotes or line breaks, in the environment:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
  | sudo ANTSEED_PASSPHRASE='…' bash -s -- --domain gateway.example.com
```

The installer stores it in `/etc/antseed/wallet.env` (root, mode 0600), which both services load. Losing it makes the wallets unrecoverable. How to encrypt existing keys, change the passphrase, or keep it off the server's disk is on [Protecting wallet keys](/docs/gateway/wallet-keys).

## After installing

The installer finishes with something like:

```
==> Antseed gateway is running
    Base URL:  https://gateway.example.com/v1
    API key:   antseed_…
               (shown once; store it now)
    Wallet:    0x…  (send USDC on Base to fund paid models)
    Console:   https://gateway.example.com/console
    Setup:     https://gateway.example.com/console/setup#…
```

1. **Store the API key.** It is shown only once. If you ran the installer from cloud-init or a CI job, it is also in that system's logs: revoke it there and create a new one (see [API keys](/docs/gateway/api)).
2. **Claim the console.** Open the **Setup** link and register a passkey or sign in with a wallet to become the organization's owner. The link works once and expires after one hour. The installer prints it only when its output goes to a terminal; under cloud-init or CI it prints `Setup: run on this server: antseed gateway console-link` instead, so the link never lands in a log. Run that command on the server for a fresh link:

   ```bash
   sudo antseed gateway console-link
   ```

   Without `--domain` or a tunnel, the link points at `http://localhost:8379`: open it through the SSH port forward above. Re-running the installer once the console has an owner prints the console URL instead. See [Sign-in and access](/docs/gateway/sign-in).
3. **Test it** from anywhere:

   ```bash
   curl https://gateway.example.com/v1/models -H "Authorization: Bearer $ANTSEED_API_KEY"
   ```

4. **Fund the wallet** to use paid models: by card from the console's **Wallet & Funding** page, or with USDC on Base. See [Funding](/docs/gateway/funding).

## The `antseed` command on the server

The installer adds an `antseed` command that runs the CLI as the `antseed` user against the gateway's data, so `antseed gateway …` and `antseed buyer …` commands work on the server as written elsewhere in these docs. Run it with `sudo`:

```bash
sudo antseed gateway key list
sudo antseed gateway console-link
```

Only when it runs as root does the wrapper load `/etc/antseed/wallet.env`. Without `sudo`, it switches to the `antseed` user without the wallet passphrase, so any command that opens an encrypted wallet key fails.

Changes apply immediately; there is no need to restart the services. The full command list is on [CLI commands](/docs/commands).

## Operate it

```bash
journalctl -u antseed-gateway -u antseed-buyer -f   # logs
systemctl restart antseed-buyer antseed-gateway     # restart
systemctl status antseed-gateway
```

| Path | Contents |
|---|---|
| `/var/lib/antseed/.antseed/` | The data dir: `identity.key` (the default wallet), `buyer-identities/` (workspace wallets), `gateway/gateway.db`, `config.json` |
| `/etc/antseed/gateway.env` | Environment for the gateway service: Cloudflare token, x402 facilitator and CDP keys, `ANTSEED_OIDC_*` and `ANTSEED_CF_ACCESS_*`. Mode 0600. |
| `/etc/antseed/wallet.env` | `ANTSEED_PASSPHRASE`, if you gave one. Root only, mode 0600. |
| `/opt/antseed/` | Node.js and the CLI |

Back up `/var/lib/antseed/.antseed/identity.key` and `buyer-identities/`: each wallet can hold USDC credits. To keep wallet keys outside the data dir, see [API keys](/docs/gateway/api).

To change buyer settings (routing preferences, price caps, verification, payment limits, the RPC endpoint, timeouts), use the console's **Settings → Buyer** page or `sudo antseed gateway settings set-buyer`. Both restart the buyer for you when a change needs it: the installer's buyer service runs with `ANTSEED_SUPERVISED=1`, so systemd brings it back.

### Chain RPC and rate limits

The buyer and the gateway read Base through a JSON-RPC endpoint, by default a public one that rate limits per IP address. When it throttles, **Wallet & Funding** and **Rewards** show the last known values with the note "Showing last known values — the chain RPC is busy." For a busy gateway, or many workspaces, use your own endpoint (see [Base RPC URL](/docs/buyer-config#base-rpc-url)). On an installed server, set `ANTSEED_BASE_RPC_URL` for both services:

```bash
echo 'ANTSEED_BASE_RPC_URL=https://base-mainnet.example.com/<your-key>' | sudo tee -a /etc/antseed/gateway.env
sudo systemctl edit antseed-buyer   # add: [Service]  EnvironmentFile=/etc/antseed/gateway.env
sudo systemctl restart antseed-buyer antseed-gateway
```

You can also set **Base RPC URL** under **Settings → Buyer → Payments**. A value from the environment overrides the saved one.

## Upgrade

Run the installer again with the same options. It upgrades the CLI and rewrites the services. Existing wallets and keys are kept, and no new key is created.

## Uninstall

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --uninstall
```

`--uninstall` removes the services, the `antseed` command, the Caddy site and `/opt/antseed`. If the installer replaced the stock Caddyfile, uninstalling puts the original back, discarding any edits you made to it since. It keeps `/var/lib/antseed`, `/etc/antseed/gateway.env` and `/etc/antseed/wallet.env`, because the wallets may still hold credits. Back them up before you delete them.

## Next steps

- [Sign-in and access](/docs/gateway/sign-in): invite your team, add Google or Cloudflare Access.
- [Funding](/docs/gateway/funding): add funds by card or USDC.
- [API keys](/docs/gateway/api): create keys and connect your tools.
