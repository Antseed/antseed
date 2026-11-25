---
title: Become a verifier
slug: /verify
description: Set up an Antseed verifier from scratch and run your first KBF audit, one of the first of many verification methods on the network, checking that sellers serve the models they advertise.
---

# Become a verifier

A verifier (on-chain: an **auditor**) checks that sellers serve the model they advertise. It buys from sellers like any other buyer, compares their answers with the genuine model's, and gives each seller a `SAME`, `DIFF` or `UNDETERMINED` verdict.

This guide sets up **KBF audits** (Knowledge Boundary Fingerprinting). KBF is one of the first verification methods Antseed is launching, and one of many: more ways to verify sellers and protect model integrity are coming. See [Model verification](/docs/model-verification#one-method-among-many).

## Quick start

Once you're set up (steps 1 and 2 below) and approved, you run two commands and leave them running:

```bash
# Terminal 1: the buyer
antseed-verifier buyer start

# Terminal 2: audit, confirm and submit, every 10 minutes, every epoch
export PINATA_JWT=…
antseed-verifier verifier watch

# Terminal 3 (optional): follow the audit while it runs
antseed-verifier verifier status
```

- Each `watch` tick runs `verifier run` and then `verifier submit --yes`. The run builds each model's question set for the epoch (the same questions for every seller, never used again), audits every seller of your models and retries failures. The submit sends only the results that aren't on-chain yet.
- Keep `watch` running all epoch. Other auditors submit `DIFF`s that need your confirmation at any time, and you have 12 hours to confirm each one before the next auditor is asked. `watch` picks them up within one tick (see [Confirmations](/docs/verify/audits#confirmations-from-other-auditors)). A single `verifier run` and `verifier submit` sends your own audits once and confirms nothing that arrives later.
- `submit` publishes the audit evidence on IPFS, so set `PINATA_JWT` first (`--no-publish-ipfs` submits without it).
- Optional: before you're approved, you can try an audit with `antseed-verifier verifier run --all` (see [step 3](#3-try-an-audit-optional)). It isn't submitted.
- To check every submit yourself, run `verifier watch --no-submit`: it audits and confirms without signing anything, and you send the results with `verifier submit` before each confirmation's 12 hours and the epoch are over. See [Keeping a verifier running](/docs/verify/audits#keeping-a-verifier-running).

The rest of this page explains each step. How an audit works is in [How audits run](/docs/verify/audits).

:::tip You don't need approval to run an audit
Approval is only needed to submit results on-chain (see [Getting approved](/docs/verify/audits#getting-approved)).
:::

## What you need

- **The Antseed CLI**: `npm install -g @antseed/cli` (see [Install](/docs/install)).
- **USDC for buyer deposits.** You pay each seller you audit like a normal buyer. See [Funding](/docs/gateway/funding).
- **API keys for the reference models**, where the genuine answers come from. Building references is billed by that provider.
- **A Base RPC endpoint.**
- **A little ETH on Base** for your auditor key's transactions (see [Your keys](#your-keys)).
- **Foundry's `cast`**, or any other tool that writes an encrypted JSON keystore, to create your auditor key.

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

### Your keys

A verifier uses two keys:

| Key | Where it's kept | What it does |
|---|---|---|
| **Buyer wallet** | `identity.key` in the data dir, created by `buyer status` (step 2) | Pays sellers for the audit requests, from the USDC you deposit for it |
| **Auditor key** | An encrypted JSON keystore you create, named in `verifier.keystore` | Signs `verifier submit` and `verifier rewards --claim`. It's the address that gets approved, it holds a little ETH on Base for gas, and it claims your ANTS rewards |

Without `verifier.keystore`, the buyer wallet signs as the auditor too: then it's the address that gets approved and needs the ETH. A separate auditor key keeps your approval, your gas and your rewards off the key that pays sellers.

Create the auditor key with Foundry's `cast`. It asks for a password and prints the address:

```bash
cast wallet new ~/.foundry/keystores antseed-auditor
# or import a key you already have:
cast wallet import antseed-auditor --interactive
```

Add it to the `verifier` section of your config:

```json
"verifier": {
  "keystore": "~/.foundry/keystores/antseed-auditor",
  "auditor": "<your auditor address>",
  "referenceEndpoint": { … }
}
```

- Set `auditor` too. Foundry's keystores don't record their address, so without it the CLI has to unlock the keystore just to know which auditor you are. It also checks that the keystore signs as this address.
- Send a little ETH on Base to the auditor address. This is the address you send for approval (see [Getting approved](/docs/verify/audits#getting-approved)).
- `submit` asks for the keystore password, and `watch` asks once when it starts. To run `watch` without a terminal, set `ANTSEED_KEYSTORE_PASSWORD` in its environment instead.

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

## 3. Try an audit (optional)

Before you're approved, you have no models to audit. If you like, try one anyway to check your setup; it isn't submitted:

```bash
antseed-verifier verifier run --all     # or name one model: verifier run glm-5.3
```

Follow it from a second terminal with `antseed-verifier verifier status`. The first run of each epoch takes longest: it builds each model's question bank for the epoch from the reference API before it asks any seller (see [Reference banks](/docs/verify/audits#reference-banks)). When it finishes, it prints the epoch overview, `<data-dir>/verifier/evidence/epochs/<epoch>/overview.html`, with every seller's verdict (see [The epoch overview](/docs/verify/audits#the-epoch-overview)).

## 4. Keep it running

Once you're approved (see [Getting approved](/docs/verify/audits#getting-approved)), start `watch` and leave it running, under systemd, pm2 or tmux:

```bash
export PINATA_JWT=…
antseed-verifier verifier watch
```

It asks for your auditor key's password once when it starts; under systemd or pm2, set `ANTSEED_KEYSTORE_PASSWORD` instead. Every 10 minutes it audits your models, confirms the `DIFF`s other auditors need you to confirm, and submits what isn't on-chain yet. A new epoch starts on the next tick. If you stop it, your confirmations go to the next auditor after 12 hours, and results you haven't submitted when the epoch ends are lost. See [Keeping a verifier running](/docs/verify/audits#keeping-a-verifier-running).

## Logs

`verifier run`, `watch`, `submit`, `assignment` and `check` write what they print to `<evidenceDir>/logs/verifier-<date>.log`, one file per UTC day, kept for 14 days. By default that's `~/.antseed/verifier/evidence/logs`. Each line has its time and the command that wrote it, and live progress bars are left out.

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
