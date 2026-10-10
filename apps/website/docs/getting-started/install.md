---
sidebar_position: 2
slug: /install
title: Install
hide_title: true
---

# Install

There are two ways to run Antseed on your machine. Both give you the same
thing: a local endpoint at `http://localhost:8377` that your tools talk to.

- **The AI VPN desktop app**: a model picker, card top-ups, and an Apps
  view that launches your tools through Antseed. Best if you want a UI.
- **The Antseed CLI**: the same endpoint from a terminal, on a laptop or a
  server. Also what you run to become a provider.

## Desktop App (AI VPN)

The AI VPN bundles the CLI, a chat interface, and encrypted identity storage
via the OS keychain. Pick your installer on the
[latest release page](https://github.com/AntSeed/antseed/releases/latest),
or use the OS-aware download button on [antseed.com](https://antseed.com).

- **macOS**: `.dmg` for Apple Silicon (arm64) and Intel (x64). Signed and
  notarized; no Gatekeeper warning.
- **Windows**: `.exe` installer for x64. Currently unsigned; Windows
  SmartScreen will ask you to confirm on first run (click *More info* →
  *Run anyway*).
- **Linux**: `.AppImage` and `.deb` for x64 and arm64.

No account is needed. Free models work right away; paid models need a
top-up by card or USDC from inside the app.

## CLI

Antseed requires Node.js 20+ and works on macOS, Linux, and Windows (WSL).

```bash
npm install -g @antseed/cli
antseed --version
```

Then pick what you want to do:

### Use AI through Antseed

Start your local endpoint:

```bash
antseed buyer start
# Proxy listening on http://localhost:8377
```

Point any OpenAI- or Anthropic-compatible tool at it, or connect a supported
app with `antseed apps connect <app>` (`antseed apps` lists them) and choose
its model with `antseed buyer connection set --model <model>`.
Free models need nothing else; for paid models run `antseed buyer deposit`.
Full walkthrough: [Using the API](/docs/guides/using-the-api).

To serve Antseed to a team or your own users from a Linux server, with an
API key and spend limits per person, one command installs the buyer and the
API-key gateway as services:
[Run a Gateway on a Server](/docs/guides/gateway-server).

### Serve AI on Antseed

Set up a provider node:

```bash
antseed seller setup
antseed seller start
```

Full walkthrough: [Become a Provider](/docs/guides/become-a-provider).

## Identity

Your node identity is a secp256k1 private key. The corresponding EVM address is your PeerId on the network and your on-chain wallet. One key for everything — P2P, payments, wallet.

Set it via environment variable (recommended):

```bash
export ANTSEED_IDENTITY_HEX=<64-char-hex-private-key>
```

If you don't set one, the CLI generates a key at `~/.antseed/identity.key` on first run. For production, use an env var with a secrets manager instead of a plaintext file.

:::tip
Back up your identity key. Losing it means a new identity on the network and loss of access to on-chain funds.
:::

## Next Steps

- [Using the API](/docs/guides/using-the-api) — connect as a buyer and start making requests
- [Become a Provider](/docs/guides/become-a-provider) — register, stake, and start earning
- [Payments](/docs/guides/payments) — deposit USDC, understand pricing and settlement
- [Metrics](/docs/guides/metrics) — expose Prometheus-compatible buyer and seller metrics
