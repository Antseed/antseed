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

- `verifier run` builds any missing question banks, audits every seller of your models, rechecks every `DIFF` and retries failures on its own. Running it again in the same epoch continues where it left off.
- Until you're approved, use `verifier run --all` to try an audit; you can't submit it yet.
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
      "rpcUrl": "https://your-base-rpc.example",
      "verificationContractAddress": "0xVerificationContractAddress",
      "verificationDeployBlock": 0
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

- `verificationContractAddress` and `verificationDeployBlock` are the verification contract on Base and the block it was deployed in. Ask for the current address in the [Antseed Telegram community](https://t.me/antseed).
- `referenceEndpoint` is where the genuine answers come from. The example uses OpenRouter, which serves every audited model with one key. To use other providers, see [Reference upstreams](/docs/verify/audits#reference-upstreams).
- Leave `buyer.maxPricing` at the `config init` default.

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

## 3. Run the audit

```bash
antseed-verifier verifier run
```

Follow it from a second terminal with `antseed-verifier verifier status`. The first run takes longest: it builds each model's question bank from the reference API before it asks any seller (see [Reference banks](/docs/verify/audits#reference-banks)). When it finishes, it prints the epoch overview, `<data-dir>/verifier/evidence/epochs/<epoch>/overview.html`, with every seller's verdict (see [The epoch overview](/docs/verify/audits#the-epoch-overview)).

Until you are approved, the run has no models to audit: add `--all` (or name one model) to try an audit without submitting it.

## Next

- [How audits run](/docs/verify/audits): question banks, which models and sellers you audit, verdicts, submitting on-chain and rewards.
- [Getting approved](/docs/verify/audits#getting-approved): needed before you can submit.
