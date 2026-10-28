---
title: Become a verifier
slug: /verify
description: Set up an Antseed verifier from scratch and run your first audit, checking that sellers serve the models they advertise.
---

# Become a verifier

A verifier (on-chain: an **auditor**) checks that sellers serve the model they advertise. It buys from sellers like any other buyer, compares their answers with the genuine model's, and gives each seller a `SAME`, `DIFF` or `UNDETERMINED` verdict.

Four steps: set up, start the buyer, build references, run the audit.

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
      "verificationContractAddress": "0x27F93f9C110595e148f127732BAFe20722572f66",
      "verificationDeployBlock": 52861128
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

- `verificationContractAddress` is the verification contract on Base.
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

The buyer's `buyer.maxPricing.defaults` must be at or above the reference price of every audited model, or `verifier run` stops and tells you what to set it to.

## 3. Build references

```bash
antseed-verifier verifier reference build --all
```

This builds the question bank for every audited model from the reference API. Run it again later to finish or grow the banks.

## 4. Run the audit

```bash
antseed-verifier verifier run
```

This audits every seller your buyer has found, for every audited model. Follow it from a second terminal with `antseed-verifier verifier status`. When it finishes it prints the run ID and an HTML report per model.

## Next

- [How audits run](/docs/verify/audits): verdicts, which sellers are skipped, submitting on-chain and rewards.
- [Getting approved](/docs/verify/audits#getting-approved): needed before you can submit.
