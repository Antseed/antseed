---
title: Earn with your Mac
slug: /local-ai/mac
sidebar_label: Earn with your Mac
description: Run the Antseed Mac app to serve a colony pool's encrypted requests on a local model, link your wallet and claim your USDC and ANTS.
---

# Earn with your Mac

The Antseed Mac app is a menu bar app that joins a [colony pool](/docs/local-ai) and answers its buyers' requests on a model running on your Mac. It shows today's estimated earnings, and you claim what you earn to your own wallet.

## Requirements

- A Mac with Apple silicon on macOS 14 or later.
- System Integrity Protection on (the default). A signed build stops serving when it is off.
- The address of a pool to join (`wss://…`), from its operator.
- A wallet on Base for your earnings.

## Build the app

The app builds from the [Antseed repository](https://github.com/Antseed/antseed) with Xcode's command-line tools:

```bash
git clone https://github.com/Antseed/antseed.git
cd antseed/apps/mac-worker
scripts/build-app.sh
```

This writes `build/Antseed Worker.app`, with the [TensorFold](https://github.com/ashhart/TensorFold) inference engine bundled and checked by its hash. Without a Developer ID the app is signed ad hoc, which is enough to run it on your own Mac.

## Join a pool

Start the app with the pool's address:

```bash
open "build/Antseed Worker.app" --args --pool wss://pool.example.com:8790
```

On first launch the app creates its keys, downloads its model and joins. It serves `qwen3.5-2b` on Qwen3.5-2B (4-bit MLX), pinned to one Hugging Face revision, by default. The menu bar shows its status, the requests it served and today's estimate.

| Option | What it does |
|---|---|
| `--pool <url>` | The pool to join (default `ws://127.0.0.1:8790`) |
| `--service <id>` | The service name the pool sells (default `qwen3.5-2b`) |
| `--model <repo@commit>` | The model that serves it, pinned to a full 40-character commit. The app refuses an unpinned model, since it could change under the service name |
| `--name <text>` | The name the pool's operator sees (default: your Mac's name) |
| `--rpc <url>` | The Base RPC the app checks channels and your payout wallet on (default: Base's public RPC and its fallbacks) |
| `--channels <address>` | The Channels contract to check requests against, for a chain other than Base mainnet or Base Sepolia |
| `--data-dir <path>` | Where the app keeps its keys and accounts (default `~/Library/Application Support/AntseedMacWorker`) |
| `--link-payout <address>` | Sign a payout link for this wallet once joined, for a Mac with no one at the screen (the code is also written to the log) |
| `--log <path>` | Append activity lines to this file |

## Link your wallet

The app's key lives on your Mac; your earnings go to a wallet you choose.

1. Once the app has joined, enter your wallet address under **Link the wallet your earnings go to**, choose **Link**, then **Copy code**. The code (`antseed-link:…`) is signed by your Mac's key.
2. Open **Rewards** in the Antseed desktop app, or the ANTS dashboard with `antseed ants` (see [ANTS staking](/docs/provide/staking)), with the same wallet, and choose **Link a Mac**.
3. Paste the code. The dashboard checks it, submits it to the pool contract and remembers the pool.

Linking also moves what the Mac already earned to that wallet. The app keeps the code, with **Copy code**, until the contract records the wallet, and then shows **Pays to** with that address. **Change wallet** signs a new link.

## Claim

The **Mac earnings** card on **Rewards** shows the USDC and ANTS each linked pool owes your wallet. **Claim to wallet** first pulls the pool's unclaimed ANTS for finished epochs, then pays both to your wallet. The pool's operator can pause new settlements, but never these claims.

## What the app does with requests

- It answers only requests encrypted for it, and checks on-chain that each request's channel belongs to that buyer and that pool before it decrypts the request.
- It serves OpenAI chat completions with tool calls. It refuses input it can't read (images, audio, files) and options it can't honor with a `400` before inference, so a buyer is never billed for a different answer than the one asked for.
- It keeps its decryption and attestation keys in the Secure Enclave, refuses debuggers, and proves its model files by hash to the pool at every launch. See [Privacy and verification](/docs/local-ai/privacy) for what that does and doesn't protect.
- It keeps each channel's account in `payments.json` in its data directory, readable only by you, so a restart never lets an old payment pay for new answers.
