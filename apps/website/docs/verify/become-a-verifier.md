---
title: Become a verifier
slug: /verify
description: Set up an Antseed verifier from scratch and run your first KBF audit, one of the first of many verification methods on the network, checking that sellers serve the models they advertise.
---

# Become a verifier

A verifier (on-chain: an **auditor**) checks that sellers serve the model they advertise. It buys from sellers like any other buyer, compares their answers with the genuine model's, and gives each seller a `SAME`, `DIFF` or `UNDETERMINED` verdict.

This guide sets up **KBF audits** (Knowledge Boundary Fingerprinting). KBF is one of the first verification methods Antseed is launching, and one of many: more ways to verify sellers and protect model integrity are coming. See [Model verification](/docs/model-verification#one-method-among-many).

## Quick start

Once you're set up (steps 1 and 2 below), these are the only commands you run each epoch:

```bash
# Terminal 1: the buyer, left running
antseed-verifier buyer start

# Terminal 2: audit your models, then put the results on-chain
antseed-verifier verifier run
antseed-verifier verifier submit --dry-run
antseed-verifier verifier submit --yes

# Terminal 3 (optional): follow the audit while it runs
antseed-verifier verifier status
```

- `verifier run` builds each model's question set for the epoch (the same questions for every seller, never used again), audits every seller of your models, audits the sellers whose `DIFF` from another auditor waits for your confirmation, and retries failures on its own. Each model is audited once per epoch: running it again in the same epoch only finishes the sellers its first run found, and `submit` sends a model once all of them are done (see [Audit windows](/docs/verify/audits#audit-windows)).
- Until you're approved, use `verifier run --all` to try an audit; you can't submit it yet.
- Once approved, `antseed-verifier verifier watch` keeps doing the run and the submit every 10 minutes, including the `DIFF`s other auditors need you to confirm (see [Keeping a verifier running](/docs/verify/audits#keeping-a-verifier-running)).
- `submit` publishes the audit evidence on IPFS, so set `PINATA_JWT` first (`--no-publish-ipfs` submits without it).

The rest of this page explains each step. How an audit works is in [How audits run](/docs/verify/audits).

:::tip You don't need approval to run an audit
Approval is only needed to submit results on-chain (see [Getting approved](/docs/verify/audits#getting-approved)).
:::

## What you need

- **The Antseed CLI**: `npm install -g @antseed/cli` (see [Install](/docs/install)).
- **USDC for buyer deposits.** You pay each seller you audit like a normal buyer. See [Funding](/docs/gateway/funding).
- **API keys for the reference models**, where the genuine answers come from. Building references is billed by that provider.
- **A Base RPC endpoint.**

## 1. Set up

Keep the verifier in its own data directory, apart from any seller or everyday buyer:

```bash
export ANTSEED_VERIFIER_DIR=~/.antseed-verifier
alias antseed-verifier='antseed --data-dir $ANTSEED_VERIFIER_DIR --config $ANTSEED_VERIFIER_DIR/config.json'

antseed-verifier config init
```

Then open `$ANTSEED_VERIFIER_DIR/config.json` and add the chain and the reference source:

```json
{
  "payments": {
    "crypto": {
      "chainId": "base-mainnet",
      "rpcUrl": "https://your-base-rpc.example"
    }
  },
  "verifier": {
    "referenceEndpoint": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "sourceId": "openrouter",
      "trust": "trusted"
    }
  }
}
```

- You don't set the verification contract: the CLI knows its address and deploy block on Base. Only for your own deployment (for example a local test chain), set `payments.crypto.verificationContractAddress` together with `verificationDeployBlock`, the block it was deployed in. Without the block, the CLI searches the whole chain history for the approved auditors.
- `referenceEndpoint` is where the genuine answers come from. The example uses OpenRouter, which serves every audited model with one key. To use other providers, see [Reference upstreams](/docs/verify/audits#reference-upstreams).
- Leave `buyer.maxPricing` at the `config init` default. If you start from an existing config, such as your desktop app's, check its cap first: a lower one stops the audit.

The audited models are built into the CLI. Set the API key and check the setup:

```bash
export OPENROUTER_API_KEY=…
antseed-verifier verifier models
```

It lists every audited model and where its genuine answers come from.

## 2. Start the buyer

The audit buys from sellers through your own buyer. Fund it, then start it in its own terminal and leave it running:

```bash
antseed-verifier buyer status     # creates the identity and shows its address
antseed-verifier buyer deposit    # shows where to send USDC
antseed-verifier buyer start
```

If another Antseed app already uses port 8377, set `buyer.proxyPort` to a free port in the config first.

If its price cap is too low for an audited model, `verifier run` stops and says what to set (see [Your buyer's price cap](/docs/verify/audits#your-buyers-price-cap)).

:::warning Give every auditor a buyer of its own
`verifier run` finds its buyer through `buyer.state.json` in its data dir, and that buyer pays sellers in real USDC. Keep a data dir and buyer for auditing only:

- **Anything sharing the data dir can spend.** An old auditor, script or cron job that uses the same data dir starts auditing, and paying, as soon as a buyer runs there.
- **A test chain doesn't change this.** `--rpc-url` and a local fork decide where audits are submitted. The buyer pays on the chain in its own config.
- **The cap comes from the running buyer.** If your data dir points at another app's buyer, the audit gets that buyer's cap, not the one in your config.
:::

## 3. Run the audit

```bash
antseed-verifier verifier run
```

Follow it from a second terminal with `antseed-verifier verifier status`. The first run takes longest: it builds each model's question bank from the reference API before it asks any seller (see [Reference banks](/docs/verify/audits#reference-banks)). When it finishes, it prints the epoch overview, `<data-dir>/verifier/evidence/epochs/<epoch>/overview.html`, with every seller's verdict (see [The epoch overview](/docs/verify/audits#the-epoch-overview)).

Until you are approved, the run has no models to audit: add `--all` (or name one model) to try an audit without submitting it.

## Logs

`verifier run`, `watch`, `submit`, `assignment`, `check` and `reference build` write what they print to `<evidenceDir>/logs/verifier-<date>.log`, one file per UTC day, kept for 14 days. By default that's `~/.antseed/verifier/evidence/logs`. Each line has its time and the command that wrote it, and live progress bars are left out.

API keys, passwords and RPC URLs that hold a key are removed before a line is written. Logs stay on your machine and aren't part of the evidence published to IPFS.

To report a problem, pack the last 7 days into one file and send it to us:

```bash
antseed verifier logs            # list the logs
antseed verifier logs --bundle   # write antseed-verifier-logs-<time>.log.gz here
```

Use `--days <n>` for a different range and `--out <path>` to choose the file. The bundle starts with your CLI version and `verifier` settings, with sensitive values removed. Look through it before you share it, because a seller's or provider's error text can appear in a log.

## Next

- [How audits run](/docs/verify/audits): question banks, which models and sellers you audit, verdicts, submitting on-chain and rewards.
- [Getting approved](/docs/verify/audits#getting-approved): needed before you can submit.
