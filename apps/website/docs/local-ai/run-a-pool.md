---
title: Run a colony pool
slug: /local-ai/run-a-pool
sidebar_label: Run a pool
description: Deploy the AntseedColonyPool contract and run the seller that Macs and other workers connect to, with pricing, model pins, worker ranking and optional Apple-verified Macs.
---

# Run a colony pool

A pool operator runs one Antseed seller with the `colony-pool` provider. Workers connect to it over a WebSocket; buyers pay it like any other seller; the `AntseedColonyPool` contract splits each settlement between the workers that answered. This guide assumes a working seller: see [Become a provider](/docs/provide) first.

## 1. Deploy the pool contract

`AntseedColonyPool` fronts your seller on-chain: buyers pay it, and your seller node, as its operator, settles through it. Deploy it from `packages/contracts` in the [Antseed repository](https://github.com/Antseed/antseed) with the chain's `AntseedRegistry` address (see [Contracts](/docs/contracts)) and your seller's address as the first operator:

```bash
cd packages/contracts
forge create staking/AntseedColonyPool.sol:AntseedColonyPool \
  --rpc-url "$BASE_RPC_URL" --private-key "$OWNER_KEY" --broadcast \
  --constructor-args <AntseedRegistry address> <seller address>
```

Then, as the contract's owner:

- `registerAgent(agentURI)` mints the pool its own ERC-8004 agent, and `registerSeller(agentId)` binds it. ANTS staked for that agent makes the pool eligible for channels and emissions.
- While ANTS transfers are still closed, the token lets only addresses its owner whitelists send ANTS, and that includes your pool. Emissions still reach the pool and every worker's share, and your fee's share, is recorded there. Claims of them wait until transfers open (or the pool is whitelisted) and fail with `AntsNotTransferableYet` until then; `antsTransferable()` tells you which. USDC is never affected.
- `setOperatorFee(feeBps, recipient)` sets your fee (10% by default, 20% at most), taken after the 2% protocol fee.
- `setRemainderRecipient(recipient)` names who receives the part of a settlement no worker is attributed (requests no worker answered, and rounding).

Point your seller at the contract with `payments.sellerContract.address` in [Seller configuration](/docs/provide/config#payment-settings), so buyers pay the pool and check that your seller operates it.

## 2. Add the pool provider

```bash
antseed config seller add-provider pool --plugin colony-pool
antseed config seller add-service pool qwen3.5-2b --input 0.05 --output 0.2
```

Every service the pool sells needs a price: workers are paid from what buyers pay, so a pool refuses to start with a free service, and workers refuse to serve one.

Set the pool's settings as environment variables before `antseed seller start`:

```bash
export COLONY_POOL_SELLER_ADDRESS=<pool contract address>
export COLONY_POOL_RPC_URL=https://mainnet.base.org
export COLONY_POOL_MODELS='qwen3.5-2b=mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3'
antseed seller start
```

Workers then join with `--pool wss://<your host>:8790`. Serve `wss://` directly with `COLONY_POOL_TLS_CERT` and `COLONY_POOL_TLS_KEY`, or put a TLS proxy in front of the port.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `COLONY_POOL_SELLER_ADDRESS` | required | The address buyers pay: the pool contract (or your seller's own address). Workers certify their keys for it |
| `COLONY_POOL_PORT` / `COLONY_POOL_HOST` | `8790` / `0.0.0.0` | Where workers connect |
| `COLONY_POOL_TLS_CERT`, `COLONY_POOL_TLS_KEY` | none | PEM files to serve `wss://` directly |
| `COLONY_POOL_ID` | `antseed-pool` | Name workers sign into their join message |
| `COLONY_POOL_RPC_URL` | none | Reads the contract's operator fee (every 10 minutes), so the earnings workers see match what it pays |
| `COLONY_POOL_WORKER_SHARE_BPS` | `9000` | Only when the seller address is your own: the share of each paid request credited to workers |
| `COLONY_POOL_ALLOWED_WORKERS` | anyone | Worker addresses allowed to join |
| `COLONY_POOL_WORKER_PRIORITY` | `1` each | Ranking weights, `0xaddress=weight,…`; `2` doubles a worker's score, `0` never routes to it |
| `COLONY_POOL_MODELS` | none | The model each service must run, `service=repo@revision`, optionally `#<sha256>` of its files |
| `COLONY_POOL_VERIFY_ON_JOIN` | `true` | Test each newly offered model before routing buyers to it |
| `COLONY_POOL_ATTESTED_TEAMS` | any team | Apple Developer teams whose signed apps earn the hardened label |
| `COLONY_POOL_LEDGER_PATH` | `<data dir>/colony-pool.db` | SQLite file for worker earnings and ranks |
| `ANTSEED_MAX_CONCURRENCY` | `64` | Concurrent requests across all workers |

Apple-verified Macs add the `COLONY_POOL_MDM_*` settings below.

## Pin the model

Workers report the model each service runs, and Antseed Colony attests a hash of its model files at every launch. With `COLONY_POOL_MODELS`, the pool routes a service only to workers reporting exactly that `repo@revision`. It also sends these pins to every worker that joins, and Antseed Colony offers them to the Mac's owner to pick from, so list each service you want Macs to run, pinned to a full 40-character commit. Add `#<sha256>` to require the attested files too. The pool logs each digest a worker attests, so you can pin the one a known-good Mac reports, or compute it from the model's snapshot:

```bash
cd ~/.cache/huggingface/hub/models--ORG--REPO/snapshots/REVISION
find -L . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256
```

Both are the worker's own report: they catch a wrong revision or drifting files, not a modified worker.

## Ranking and the Workers panel

The pool sends each buyer its best-ranked workers with a free slot: operator weight × reliability × decode speed relative to the fastest worker on that model, divided by 1 + load. A worker that fails a request is benched for 30 seconds, doubling up to 10 minutes, until it answers again. Ranks survive reconnects and restarts, so a flaky Mac can't reset its record by reconnecting.

The seller dashboard's **Workers** panel lists workers in that order, with status, speed, requests answered over 24 hours and 7 days, median first byte, online time and earnings.

## Apple-verified Macs

Optionally, you run your own MDM server ([NanoMDM](https://github.com/micromdm/nanomdm) is supported) and Mac owners who want the higher level enroll in it. Antseed runs no MDM. The pool then gets Apple's attestation of each enrolled Mac's serial number and SIP state, bound to its worker, and hands it to buyers, who verify it themselves.

You need an Apple MDM push certificate and Macs with Apple silicon on macOS 14 or later. Enrolling gives you MDM powers over a Mac, which its owner should weigh.

| Setting | What it does |
|---|---|
| `COLONY_POOL_MDM_URL`, `COLONY_POOL_MDM_API_KEY` | Your NanoMDM server and its API key |
| `COLONY_POOL_MDM_WEBHOOK_PATH` | Secret webhook path, at least 16 random characters (required) |
| `COLONY_POOL_MDM_WEBHOOK_PORT`, `COLONY_POOL_MDM_WEBHOOK_HOST` | Where the plain-HTTP webhook listens (`8791`, `127.0.0.1`). Put an HTTPS proxy or private tunnel in front of it and point NanoMDM at `https://<proxy>/<path>` |
| `COLONY_POOL_MDM_DEVICES` | Each enrolled Mac bound to the worker that runs on it, `UDID=0xworker,…` (required). Apple attests the Mac, not the worker, so a worker naming a Mac bound to another is never Apple-verified |
| `COLONY_POOL_REQUIRE_DEVICE_ATTESTATION` | Route only to Apple-verified Macs |

See [Privacy and verification](/docs/local-ai/privacy) for what Apple's attestation proves.
