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
5. Creates a first API key, unless keys already exist, and prints the base URL, the key, the wallet address and a link to claim the [gateway console](/docs/guides/gateway-console).

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
| `--public-url <url>` | Without `--domain` or a tunnel: the origin your own reverse proxy serves the gateway at, used for console links, passkeys and single sign-on |
| `--oidc-issuer <url>`, `--oidc-client-id <id>`, `--oidc-client-secret <secret>` | Off. [Console sign-in with your own OpenID Connect provider](/docs/guides/gateway-console#set-up-google-or-another-oidc-provider), such as Google. Needs an `https` URL. Prefer passing the secret as `ANTSEED_OIDC_CLIENT_SECRET` in the environment |
| `--oidc-allowed-domains <domains>` | None. Comma-separated email domains whose verified users may join the console without an invite |
| `--cf-access-team-domain <domain>`, `--cf-access-aud <tag>` | Off. Trust [Cloudflare Access](/docs/guides/gateway-console#cloudflare-access) for console sign-in |
| `--cli-version <version>` | `latest` |
| `--dry-run` | Validates the options and prints what would be installed, without changing anything |
| `--verbose` | Prints every command and npm's output |

Every option can also be set in the environment, which suits cloud-init and other automation: `ANTSEED_GATEWAY_DOMAIN`, `ANTSEED_GATEWAY_HOST`, `ANTSEED_GATEWAY_PORT`, `ANTSEED_GATEWAY_KEY_LABEL`, `ANTSEED_CLI_VERSION`, `ANTSEED_X402_FACILITATOR_URL`, `CLOUDFLARED_TUNNEL_TOKEN`, `ANTSEED_GATEWAY_PUBLIC_URL` (or `ANTSEED_TUNNEL_PUBLIC_URL`), `ANTSEED_OIDC_ISSUER`, `ANTSEED_OIDC_CLIENT_ID`, `ANTSEED_OIDC_CLIENT_SECRET`, `ANTSEED_OIDC_ALLOWED_DOMAINS`, `ANTSEED_CF_ACCESS_TEAM_DOMAIN` and `ANTSEED_CF_ACCESS_AUD`. Run the script with `--help` for the full list.

The script validates every option before it changes anything. It finishes by checking that the gateway answers.

## After installing

The installer prints something like:

```
==> Antseed gateway is running
    Base URL:  https://llm.example.com/v1
    API key:   antseed_…
    Wallet:    0x…  (send USDC on Base to fund paid models)
    Console:   https://llm.example.com/console
    Setup:     https://llm.example.com/console/setup#…
```

Open the setup link to claim the [gateway console](/docs/guides/gateway-console) as its owner: register a passkey or sign in with a wallet, then invite your team, create workspaces and keys, and set budgets and routing policies from the browser. The link works once and expires after one hour; `antseed gateway console-link` prints a new one. Without `--domain` or a tunnel, the link points at `http://localhost:8379`: open it through the SSH port forward shown below. Re-running the installer prints the console URL instead once it has an owner.

The key is shown only once. If you run the installer from cloud-init or a CI job, it also ends up in that system's logs: revoke it there with `antseed gateway key revoke <id>` and create a new one by hand. Test it from anywhere:

```bash
curl https://llm.example.com/v1/models -H "Authorization: Bearer antseed_…"
```

Free models work right away. To use paid models, fund the wallet: pay by card from the console's **Wallet & Funding** page, send USDC on Base to the address shown, or run `antseed buyer deposit --no-watch` for the address and a QR code. The buyer deposits incoming USDC into its credits automatically.

The installer adds an `antseed` command that runs the CLI as the `antseed` user against the gateway's data, so the commands in [Shared Gateway API Keys](/docs/guides/gateway-api-keys) work as written:

```bash
antseed gateway key create --label "Alice" --new-identity --monthly-limit 20
antseed gateway key list
antseed gateway member invite --label "Bob" --email bob@example.com
antseed gateway console-link
antseed gateway usage --group-by key
antseed gateway logs --follow
antseed buyer identity list --balances
```

Key changes apply immediately; there is no need to restart anything. Everything the console manages (workspaces, members, routing policies, presets, settings, the audit log) also has a command: see the [CLI reference](/docs/guides/gateway-console#cli-reference).

## Operate it

```bash
journalctl -u antseed-gateway -u antseed-buyer -f   # logs
systemctl restart antseed-buyer antseed-gateway     # restart
systemctl status antseed-gateway
```

| Path | Contents |
|---|---|
| `/var/lib/antseed/.antseed/` | The buyer's data dir: `identity.key` (the default wallet), `buyer-identities/`, `gateway/gateway.db`, `config.json` |
| `/etc/antseed/gateway.env` | Environment for the gateway service (Cloudflare token, x402 facilitator, `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, `ANTSEED_OIDC_*` and `ANTSEED_CF_ACCESS_*` console sign-in), mode 0600 |
| `/opt/antseed/` | Node.js and the CLI |

Back up `/var/lib/antseed/.antseed/identity.key` and `buyer-identities/`: each wallet can hold USDC credits. To keep identity keys in a secret manager instead, see [Keep keys out of the data dir](/docs/guides/gateway-api-keys#keep-keys-out-of-the-data-dir) and add the variables to `/etc/antseed/gateway.env` and a drop-in for `antseed-buyer` (`systemctl edit antseed-buyer`).

To change buyer settings, such as price caps, use the console's **Settings** page, which restarts the buyer for you, or edit the config as the `antseed` user (`antseed config …`) and restart `antseed-buyer`.

### Chain RPC and rate limits

The buyer and the gateway read balances, deposits, operator settings, rewards and seller stats from Base through a JSON-RPC endpoint, by default a public one that rate limits per IP address. They keep the request rate low: one shared RPC client per process, concurrent reads folded into Multicall3 calls, short-lived caches, one deposit watcher loop for all workspace wallets (every 6 s while a wallet page is open, every 30 s to 60 s otherwise), on-chain seller stats refreshed every 10 minutes, and backoff when an endpoint throttles. When the endpoint is busy anyway, the console shows the last known values with a note instead of an error.

For a busy gateway, or many workspaces, use your own RPC endpoint (any Base provider). Set `ANTSEED_BASE_RPC_URL` for both services:

```bash
echo 'ANTSEED_BASE_RPC_URL=https://base-mainnet.example.com/<your-key>' >> /etc/antseed/gateway.env
systemctl edit antseed-buyer   # add: [Service]  EnvironmentFile=/etc/antseed/gateway.env
systemctl restart antseed-buyer antseed-gateway
```

## Move a local gateway to a server

A gateway started with `antseed gateway start` on a laptop only works while that computer is on, and other machines cannot reach it. The console shows owners and admins a banner when the gateway has no public URL, with a **Move to a server** page that walks through these steps. Everything moves: API keys (they keep working), members, workspaces, routing policies, presets, usage history, wallets and open payment channels.

1. On the computer running the gateway, write a password-protected bundle:

   ```bash
   antseed gateway export --out antseed-gateway.bundle
   ```

   It asks for a password (at least 10 characters; `--password-file <file>` reads it from a file instead). The databases are copied as a consistent snapshot even while the gateway runs, and the file is written readable only by you (mode 0600). It is encrypted with AES-256-GCM under a key derived from the password with scrypt, and every file in it is integrity-checked on import. The bundle holds the wallet keys: keep the password apart from the file. A wallet whose key comes from `--key-from env:…|file:…` is not in the bundle; provide the same variable or file on the server. A default wallet encrypted by the desktop app (`identity.enc`) cannot be exported by the CLI.

2. Copy it to the server:

   ```bash
   scp antseed-gateway.bundle user@your-server:/tmp/antseed-gateway.bundle
   ```

3. On the server, install with `--import`. The installer asks for the bundle password on the terminal, restores the bundle as the `antseed` user before the services start, and does not create a new API key:

   ```bash
   curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh \
     | sudo bash -s -- --domain llm.example.com --import /tmp/antseed-gateway.bundle
   ```

   Pass `--import-password-file <file>` (or `ANTSEED_GATEWAY_IMPORT` and `ANTSEED_GATEWAY_IMPORT_PASSWORD_FILE` in the environment) for unattended installs. An import refuses to replace a server that already has a gateway or wallet unless you add `--import-force`, which moves the old data dir aside to `.antseed.backup-<time>` instead of deleting it. `--dry-run` shows what would happen.

4. Point your apps at the new base URL, `https://llm.example.com/v1`. API keys are unchanged.

5. Stop the gateway and buyer on the old computer, then delete the bundle from both machines. Never run both: two buyers paying from the same wallet conflict over its payment channels.

Without the installer, run `antseed gateway import <bundle> --public-url https://llm.example.com` on the target with the gateway and buyer stopped; it accepts the same `--password-file` and `--force`, and prints the workspaces, key and member counts and wallet addresses it restored (never a secret).

**Signing in after the move.** Every console session ends on import; members sign in again on the new address. Wallet and single sign-on sign-in keep working (add the new redirect URI to your OIDC client). Passkeys are bound to the domain they were created on, so passkeys made on `localhost` or an old domain do not work on the new one. Create a one-time recovery link on the server and open it to add a new passkey:

```bash
antseed gateway console-link --recover                      # the owner
antseed gateway console-link --recover --member bob@example.com
```

A recovery link can only be created from the CLI on the gateway machine, works once, expires after one hour, replaces that member's earlier unused link, and is recorded in the audit log when it is created and when it is used.

**Keeping it on your computer instead.** `antseed tunnel start --provider cloudflare` (with `CLOUDFLARED_TUNNEL_TOKEN` and `ANTSEED_TUNNEL_PUBLIC_URL`) gives the gateway a public HTTPS address without moving it. Keys still stop working whenever the computer sleeps or goes offline. See [Public HTTPS Tunnels](/docs/guides/public-tunnels).

## Upgrade or remove

Run the installer again with the same options to upgrade the CLI and rewrite the services. Existing wallets and keys are kept, and no new key is created.

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --uninstall
```

`--uninstall` removes the services, the `antseed` command, the Caddy site and `/opt/antseed`. If the installer replaced the stock Caddyfile, uninstalling puts the original back, discarding any edits you made to it since. It keeps `/var/lib/antseed` and `/etc/antseed`, because the wallets may still hold credits.
