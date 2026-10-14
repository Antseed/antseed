---
title: Quickstart
slug: /quickstart
description: Run an Antseed gateway, claim its console, add funds, create an API key and send your first request.
---

# Quickstart

This guide takes you from nothing to a working API request through your own Antseed gateway. The gateway gives you an OpenAI- and Anthropic-compatible API, API keys with budgets, and a web console at `/console` where you manage everything.

Pick where the gateway runs, then follow the common steps.

- **On your computer**: quickest to try. Keys only work while your computer is on.
- **On a server**: always on, reachable by your team over HTTPS.

You can start on your computer and [move the gateway to a server](/docs/gateway/migrate) later, keeping its keys, members and wallets.

## On your computer

On macOS or Linux (including WSL), one command installs the Antseed CLI, starts the gateway in the background and opens a one-time link to claim its console:

```bash
curl -fsSL https://antseed.com/install.sh | bash
```

It needs Node.js 20 or later (on macOS with Homebrew it installs Node.js for you) and installs the CLI with npm, without sudo. When it finishes it prints the setup link, the console URL, the API base URL `http://localhost:8379/v1`, the log file (`~/.antseed/gateway.log`) and how to stop the gateway. Continue with [Claim the console](#claim-the-console).

### Or step by step

1. Install the Antseed CLI. See [Install](/docs/install) for requirements.

   ```bash
   npm install -g @antseed/cli
   ```

2. Start the gateway. It also starts the buyer, the local process that pays providers.

   ```bash
   antseed gateway start
   ```

   ```
   API-key gateway listening on http://127.0.0.1:8379/v1
   0 active key(s). Manage them in the console or with `antseed gateway key …`.
   Console: http://localhost:8379/console
   The console has no owner yet. Get a one-time setup link with `antseed gateway console-link`.
   ```

3. In another terminal, get the setup link:

   ```bash
   antseed gateway console-link
   ```

   ```
   Console setup link (single use, valid for 1 hour):
     http://localhost:8379/console/setup#…
   ```

Leave `antseed gateway start` running and continue with [Claim the console](#claim-the-console).

## On a server

Run the installer on a Linux server with systemd. With `--domain`, it serves the gateway over HTTPS at that hostname:

```bash
curl -fsSL https://antseed.com/install.sh | bash -s -- --domain gateway.example.com
```

On a Linux server with systemd, `install.sh` downloads and runs the server installer, [`install-gateway.sh`](https://antseed.com/install-gateway.sh), as root (through `sudo`, which may ask for your password), passing every option through. You can also run the server installer directly:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://antseed.com/install-gateway.sh | sudo bash -s -- --domain gateway.example.com
```

[Run a gateway on a server](/docs/gateway/server) explains every option, including Cloudflare Tunnel and running without a domain.

When it finishes, the installer prints a summary:

```
Base URL:  https://gateway.example.com/v1
API key:   antseed_…
           (shown once; store it now)
Wallet:    0x…  (send USDC on Base to fund paid models)
Console:   https://gateway.example.com/console
Setup:     https://gateway.example.com/console/setup#…
```

The installer already created a first API key, labelled `admin`. Save it now: it is not shown again.

The setup link is printed only in an interactive terminal. If you see `Setup: run on this server: antseed gateway console-link` instead, run:

```bash
sudo antseed gateway console-link
```

Without `--domain`, the gateway only listens on the server. Forward its port from your machine and open the link there:

```bash
ssh -N -L 8379:127.0.0.1:8379 <user>@<server>
```

## Claim the console

1. Open the setup link in your browser. The page says **Set up your Antseed console**.
2. Click **Create a passkey** and confirm with your device's screen lock or a security key. You can choose **Sign in with a wallet** instead.

You are now the organization's owner. The link works once and expires after one hour; running `antseed gateway console-link` again gives you a new one. A short tour shows where everything is. Replay it from your account menu with **Take the tour**.

Passkeys work on `localhost` and on `https://` hostnames, not on bare IP addresses. See [Sign-in](/docs/gateway/sign-in) for other sign-in methods and for inviting your team.

## Add funds

Requests to paid providers are paid in USDC from the workspace's wallet. Providers marked **Free** work without funds, so you can skip this step to try a free model first.

1. Open **Wallet & Funding** and click **Add funds**.
2. Choose an amount ($5, $10, $25 or any amount).
3. Pay one of two ways:
   - **Deposit $10 by card** (with the amount you chose): a card checkout by Crossmint opens inside the console. Card payments have per-payment limits and are not available in every region; see [Funding](/docs/gateway/funding#card).
   - **Quick deposit**: send USDC on Base to the workspace's address, shown with a QR code, from an exchange withdrawal or another wallet.

The balance updates by itself once the funds arrive. [Funding](/docs/gateway/funding) covers every option, withdrawals and the authorized wallet.

## Create an API key

1. Open **Keys** and click **Create key**.
2. Enter a **Name**, for example `My laptop`. Budgets and an expiry date are optional; see [Budgets and spend limits](/docs/gateway/budgets).
3. Click **Create key**.
4. Copy the secret (`antseed_…`). It is shown once.

Store it in an environment variable:

```bash
export ANTSEED_API_KEY="antseed_…"
```

## Pick a model

1. Open **Models**. It lists every model on the network with its number of providers and price range.
2. Click a model, for example `deepseek-v4-flash`. A panel opens on the right.
3. Under **Providers**, each provider has a copy button for its pinned model id, `<peerId>@deepseek-v4-flash`.
4. Under **API call**, copy the ready-made request. Keep **Best provider (automatic)** to let the gateway choose, or click **Pin** next to a provider to send every request to it.

[Models and providers](/docs/gateway/models) explains automatic and pinned routing.

## Send your first request

Use the base URL shown in the console's top bar. For a local gateway it is `http://localhost:8379/v1`:

```bash
curl http://localhost:8379/v1/chat/completions \
  -H "Authorization: Bearer $ANTSEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<peerId>@deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'
```

Replace `<peerId>@deepseek-v4-flash` with the id you copied, or use `deepseek-v4-flash` alone for automatic routing.

## See it in Logs

Open **Logs**. Your request is at the top, with its model, provider, status and cost. Click it to see details such as latency and token counts. The cost can show as `pending` for a moment: the buyer reports the amount paid shortly after the response ends.

## Next steps

- [Call the API](/docs/gateway/api) from the OpenAI or Anthropic SDKs and coding tools.
- [Set budgets](/docs/gateway/budgets) on keys, members and workspaces.
- [Choose which providers serve you](/docs/gateway/routing), such as TEE-only providers.
- [Try the console's Chat](/docs/gateway/chat).
- [Invite your team](/docs/gateway/sign-in).
