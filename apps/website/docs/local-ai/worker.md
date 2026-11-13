---
title: Serve a pool from other machines
slug: /local-ai/worker
sidebar_label: Other machines
description: Join a colony pool from any machine with antseed-pool-worker, in front of Ollama, llama.cpp, mlx_lm.server or another OpenAI-compatible local server.
---

# Serve a pool from other machines

`antseed-pool-worker` joins a [colony pool](/docs/local-ai) and serves its requests from a local OpenAI-compatible model server, such as `mlx_lm.server`, Ollama or llama.cpp. It ships in the `@antseed/provider-colony-pool` package and runs anywhere Node.js does.

## Run it

Start your local model server, then point the worker at it and at the pool:

```bash
npm install -g @antseed/provider-colony-pool

antseed-pool-worker \
  --pool wss://pool.example.com:8790 \
  --services qwen3.5-2b=qwen3.5:2b \
  --base-url http://127.0.0.1:11434
```

`--services` lists the services the pool sells that you serve, each optionally mapped to the model name your local server uses (`service=localModel`). The pool sends each new service a short test ("Reply with the single word: ready") and routes buyers to it only once the answer is right.

On first run the worker creates its key in `~/.antseed-worker/key`. That key's address is your worker address: it receives your share of each settlement, or links it to a wallet of your choice.

## Options

| Option | What it does |
|---|---|
| `--pool <url>` | The pool's WebSocket address |
| `--services <list>` | Services to serve, each optionally mapped to a local model name |
| `--models <list>` | The model each service runs, as `service=repo@revision` with a pinned revision. Pools that pin a model route a service only to workers that report it |
| `--base-url <url>` | Your local model server (default `http://127.0.0.1:8080`) |
| `--concurrency <n>` | Requests to run at once (default 1) |
| `--key-file <path>` | Worker key (default `~/.antseed-worker/key`). The encryption key is kept next to it as `<path>.p256`, and each channel's account as `<path>.payments.json` |
| `--rpc-url <url>` | RPC the worker checks each request's channel on (default: the chain's public RPC). Requests whose channel can't be checked are refused |
| `--chain-id <id>` | `base-mainnet` (default), `base-sepolia` or `base-local` |
| `--channels-address <address>` | Channels contract to read instead of the chain's default |
| `--stats` | Print this worker's earnings, as the pool estimated them, and exit |
| `--link-payout <wallet>` | Sign a link of this worker's earnings to your wallet and print its code (needs `--pool-contract`; sends nothing) |
| `--pool-contract <address>` | The pool's contract address, from its operator |

## Getting paid

The worker serves a channel only while the buyer's signed payment covers its earlier answers there, at most one answer behind, and counts that payment only up to what the pool contract can still pay it.

The pool contract credits what the worker earns to the worker's own address until you link a wallet. To link one, sign a link with the worker's key:

```bash
antseed-pool-worker --link-payout 0xYourWallet --pool-contract 0xPoolContract
```

It prints an `antseed-link:…` code, valid for 7 days. In the ANTS dashboard (`antseed ants`), connect that wallet, open **Rewards**, choose **Link a Mac** and paste the code. The wallet submits the link, which also moves the worker's unclaimed USDC and its recent ANTS. From then on the worker's earnings go to that wallet, and you claim them from the dashboard's colony pool card.

ANTS the worker earned more than 32 epochs before you linked stay with the worker's address. Anyone can send them to your wallet with the pool contract's `claimAntsFor(worker, epochs)`, and the pool never pays them anywhere else.

The Node.js worker attests no hardening, so buyers that require Apple-verified Macs never route to it. See [Privacy and verification](/docs/local-ai/privacy).
