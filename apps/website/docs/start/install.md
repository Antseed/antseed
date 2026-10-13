---
slug: /install
title: Install
description: Install the Antseed gateway, the desktop app or the CLI.
hide_title: true
---

# Install

Every way of using Antseed runs a local buyer that discovers sellers and pays them. Pick how you want to reach it:

- [Gateway](#gateway): API keys, budgets and a web console. Recommended.
- [Desktop app](#desktop-app): one person, a UI, and one-click setup for local coding tools.
- [CLI](#cli): the bare buyer proxy for scripts and headless machines.

## Gateway

The gateway ships in the Antseed CLI. You can run it on your own computer or install it on a Linux server.

### On your computer

On macOS or Linux (including WSL), install the CLI, start the gateway in the background and get a console setup link with one command:

```bash
curl -fsSL https://antseed.com/install.sh | bash
```

It needs Node.js 20 or later (on macOS with Homebrew it installs Node.js for you), installs `@antseed/cli` with npm without sudo, logs to `~/.antseed/gateway.log` and prints how to stop the gateway. Set `ANTSEED_CLI_VERSION` to install a specific CLI version. [Read the script](https://antseed.com/install.sh) before running it.

Or install the CLI (Node.js 20 or later) yourself, then start the gateway:

```bash
npm install -g @antseed/cli
antseed gateway start
```

This starts a buyer on port 8377 and the gateway on `http://localhost:8379`, with its API at `http://localhost:8379/v1` and the console at `http://localhost:8379/console`. Pass `--no-buyer` if you already run a buyer yourself.

The console has no owner yet. Get a one-time setup link, open it, and register a passkey or connect a wallet to become the owner:

```bash
antseed gateway console-link
```

A gateway on your computer only works while the computer is on and is not reachable from other machines. To share it, publish it with a [tunnel endpoint](/docs/tunnels) or move it to a server.

### On a server

One command installs the buyer and the gateway as systemd services on a Linux server and can publish them over HTTPS:

```bash
curl -fsSL https://antseed.com/install.sh | bash -s -- --domain gateway.example.com
```

On Linux with systemd, `install.sh` runs the server installer as root. See [Run a gateway on a server](/docs/gateway/server).

Next: [Quickstart](/docs/quickstart).

## Desktop app

The desktop app (AI VPN) bundles the buyer, a chat, and identity storage in the operating system keychain. Download it from [antseed.com](https://antseed.com) or the [latest release page](https://github.com/AntSeed/antseed/releases/latest).

- **macOS**: `.dmg` for Apple Silicon and Intel, signed and notarized.
- **Windows**: `.exe` installer for x64, code-signed.
- **Linux**: `.AppImage` and `.deb`.

No account is needed. Free models work right away; for paid models, add credits by card or USDC from **Profile → Add Credits**.

Next: [Desktop app](/docs/desktop).

## CLI

The CLI needs Node.js 20 or later and runs on macOS, Linux and Windows.

```bash
npm install -g @antseed/cli
antseed --version
```

Start the local buyer proxy:

```bash
antseed buyer start
```

It listens on `http://localhost:8377`. Free models need nothing else. For paid models, run `antseed buyer deposit` to get a funding address and QR code for USDC on Base.

Next: [Use the local buyer proxy](/docs/api). To serve AI instead, see [Become a provider](/docs/provide).

## Identity

Your node identity is one secp256k1 private key. Its EVM address is your peer id on the network and the wallet your payments come from.

On first run the CLI creates the key at `~/.antseed/identity.key`. On servers, pass it from a secrets manager with `ANTSEED_IDENTITY_HEX`, or encrypt the key file with a passphrase; see [Protecting wallet keys](/docs/gateway/wallet-keys). To keep several buyers apart, give each its own data directory; see [Buyer configuration](/docs/buyer-config#data-directory).

:::tip
Back up your identity key. Losing it means losing the funds and history tied to that address.
:::
