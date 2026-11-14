---
title: Earn with your Mac
slug: /local-ai/mac
sidebar_label: Earn with your Mac
description: Run Antseed Colony to serve a colony pool's encrypted requests on a local model, link your wallet and claim your USDC and ANTS.
---

# Earn with your Mac

Antseed Colony is a menu bar app that joins a [colony pool](/docs/local-ai) and answers its buyers' requests on a model running on your Mac. It shows today's estimated earnings, and you claim what you earn to your own wallet.

## Requirements

- A Mac with Apple silicon on macOS 14 or later.
- System Integrity Protection on (the default). A signed build stops serving when it is off.
- The address of a pool to join (`wss://…`), from its operator.
- A wallet on Base for your earnings.

## Install

1. [Download Antseed Colony](https://github.com/Antseed/antseed/releases/download/colony-latest/Antseed-Colony.dmg) (`Antseed-Colony.dmg`, always the latest version). It is signed with Antseed's Developer ID and notarized by Apple.
2. Open the DMG and drag **Antseed Colony** to **Applications**.
3. Open **Antseed Colony**. It runs in the menu bar (the ant icon), not the Dock.

On first launch the app creates its keys. Models run on the bundled [TensorFold](https://github.com/ashhart/TensorFold) engine.

## Join a pool

Click the ant icon, enter the pool's address from its operator (`wss://…`) under **Pool address**, and choose **Join**. The app keeps the address for later launches; **Change pool** switches to another one.

## Choose a model

Once joined, the app lists the models the pool runs: each service it sells, the exact model pinned for it, and its download size. Pick one. The app downloads that pinned model, checks its files and starts serving it. Models whose weights take more than half your Mac's memory are marked **needs more memory** and can't be picked.

The app keeps your choice for later launches. **Change model** switches to another of the pool's models; the app stops serving while the new one downloads. A pool that pins no models gets the built-in one, `qwen3.5-2b` on Qwen3.5-2B (4-bit MLX).

The panel shows the app's status, today's estimated earnings, the model and what protects the prompts it serves. The switch at the top pauses sharing without leaving the pool.

## Keep it earning

Under **This Mac** in the panel:

- **Open at login** (on from the first launch): the app starts again after a restart, so the Mac keeps earning.
- **Keep awake while sharing** (on): the Mac doesn't go to sleep while it shares with its pool; the display still can. **Only when plugged in** (on) lets a laptop sleep as usual on battery.
- **Check for updates**: the app also checks for new versions once a day and installs them, signed by Antseed, when you agree.

## Command-line options

You don't need these to earn. They are for pool operators and for running a Mac with no one at the screen:

```bash
open -a "Antseed Colony" --args --pool wss://pool.example.com:8790 --name studio-mac
```

| Option | What it does |
|---|---|
| `--pool <url>` | The pool to join, instead of the one saved in the app |
| `--service <id>` | The service to serve, instead of the one chosen in the app (default `qwen3.5-2b`) |
| `--model <repo@commit>` | The model that serves it, pinned to a full 40-character commit, instead of the one chosen in the app. The app refuses an unpinned model, since it could change under the service name |
| `--name <text>` | The name the pool's operator sees (default: your Mac's name) |
| `--rpc <url>` | The Base RPC the app checks channels and your payout wallet on (default: Base's public RPC and its fallbacks) |
| `--channels <address>` | The Channels contract to check requests against, for a chain other than Base mainnet or Base Sepolia |
| `--data-dir <path>` | Where the app keeps its keys and accounts (default `~/Library/Application Support/AntseedMacWorker`) |
| `--link-payout <address>` | Sign a payout link for this wallet once joined, for a Mac with no one at the screen (the code is also written to the log) |
| `--log <path>` | Append activity lines to this file |

## Link your wallet

The app's key lives on your Mac; your earnings go to a wallet you choose. Everything happens from the app: the only step outside it is your wallet approving a transaction, on the Antseed payments page the app opens in your browser.

1. Once the app has joined a pool, choose **Link wallet** under **Rewards** in the panel. Your browser opens the payments page, served by the app on your Mac.
2. Connect your wallet (a browser extension such as MetaMask, or a mobile wallet through WalletConnect) and choose **Link this wallet**. The app signs the link for that wallet with the Mac's key, and you confirm one transaction that records it in the pool contract.

Linking also moves what the Mac already earned to that wallet. The panel then shows the wallet under **Payout wallet**; **Change** links another one.

## Claim

The **Rewards** card in the panel shows what the pool owes your wallet: USDC, and ANTS for finished epochs. Choose **Claim**, connect the same wallet on the payments page, and confirm the transactions: USDC first, then ANTS. When the pool hasn't pulled its ANTS for some finished epochs yet, the claim pulls them first, as the panel notes. The pool's operator can pause new settlements, but never these claims. While ANTS transfers are still closed, the card says so and **Claim** takes only the USDC: the pool keeps the ANTS it owes you until transfers open.

The Antseed desktop app's **Rewards** and the ANTS dashboard (`antseed ants`) also show and claim a linked Mac's earnings.

## What the app does with requests

- It answers only requests encrypted for it, and checks on-chain that each request's channel belongs to that buyer and that pool before it decrypts the request.
- It serves OpenAI chat completions with tool calls. It refuses input it can't read (images, audio, files) and options it can't honor with a `400` before inference, so a buyer is never billed for a different answer than the one asked for.
- It keeps its decryption and attestation keys in the Secure Enclave, refuses debuggers, and proves its model files by hash to the pool at every launch. See [Privacy and verification](/docs/local-ai/privacy) for what that does and doesn't protect.
- It keeps each channel's account in `payments.json` in its data directory, readable only by you, so a restart never lets an old payment pay for new answers.

## Build from source

Developers can build the app from the [Antseed repository](https://github.com/Antseed/antseed) with Xcode's command-line tools, Node.js 24 and pnpm. The app bundles the payments page that **Link wallet** and **Claim** open, so build that first:

```bash
git clone https://github.com/Antseed/antseed.git
cd antseed
pnpm install
pnpm --filter @antseed/payments run build:web
cd apps/mac-worker
REQUIRE_PAY_PAGE=1 scripts/build-app.sh
open "build/Antseed Colony.app"
```

`REQUIRE_PAY_PAGE=1` stops the build when the payments page is missing, instead of packaging an app whose wallet steps can't open.

Without a Developer ID the build is signed ad hoc, which is enough to run it on your own Mac.
