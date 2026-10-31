---
title: Become a verifier
slug: /verify
description: Set up an Antseed verifier and run it in the weekly KBF verification rounds, one of the first of many verification methods on the network, checking that sellers serve the models they advertise.
---

# Become a verifier

A verifier checks that sellers serve the model they advertise. It buys from sellers like any other buyer, compares their answers with the genuine model's, and together with the other verifiers gives each seller service a `SAME`, `DIFF` or `UNDETERMINED` verdict.

This guide sets up **KBF audits** (Knowledge Boundary Fingerprinting). KBF is one of the first verification methods Antseed is launching, and one of many: more ways to verify sellers and protect model integrity are coming. See [Model verification](/docs/model-verification#one-method-among-many).

## Quick start

Once you're set up and approved (steps below), a verifier is one process left running:

```bash
antseed-verifier verifier start
```

- It starts its own buyer, publishes its encryption key on-chain, and then follows every epoch on its own: it buys its share of the questions, scores the epoch, attests the results, and claims its rewards.
- It keeps its progress on disk, so you can stop and restart it at any time.
- `--no-collect` runs a verifier that only scores and attests, without buying from sellers.

How a round works is in [How verification rounds run](/docs/verify/audits).

## What you need

- **The Antseed CLI**: `npm install -g @antseed/cli` (see [Install](/docs/install)).
- **USDC for buyer deposits.** You pay each seller you buy questions from like a normal buyer. See [Funding](/docs/gateway/funding).
- **A little ETH on Base** for the round transactions.
- **A Pinata API key** (`PINATA_JWT`), to publish the seller responses you collect and your results on IPFS.
- **A Base RPC endpoint.**

You don't need an API key for the reference models: the question bank and its genuine answers come from the round.

## 1. Set up

Keep the verifier in its own data directory, apart from any seller or everyday buyer:

```bash
export ANTSEED_VERIFIER_DIR=~/.antseed-verifier
alias antseed-verifier='antseed --data-dir $ANTSEED_VERIFIER_DIR --config $ANTSEED_VERIFIER_DIR/config.json'

antseed-verifier config init
```

Then open `$ANTSEED_VERIFIER_DIR/config.json` and add the chain:

```json
{
  "payments": {
    "crypto": {
      "chainId": "base-mainnet",
      "rpcUrl": "https://your-base-rpc.example"
    }
  }
}
```

- The CLI already knows the verification contract on Base and the block it was deployed in, so leave `verificationContractAddress` and `verificationDeployBlock` out. Set both only to point at a custom deployment, and then set `verificationDeployBlock` to the block that contract was deployed in: the CLI scans its events from there.
- Leave `buyer.maxPricing` at the `config init` default. If the buyer port 8377 is taken by another Antseed app, set `buyer.proxyPort`.

Set the environment the verifier needs:

```bash
export PINATA_JWT=…                       # publishes your slices and results on IPFS
export ANTSEED_IPFS_GATEWAYS=https://…    # optional: comma-separated gateways to read round files
```

## 2. Choose the verifier address

The verifier signs with the data-dir identity by default (`antseed-verifier buyer status` shows its address). To sign with an encrypted keystore instead, set `verifier.keystore` in the config, or pass `--keystore <path>` to `verifier start`, and give the password in `ANTSEED_KEYSTORE_PASSWORD` (otherwise it is asked in the terminal).

Send that address a little ETH on Base for transactions.

## 3. Fund the buyer

The verifier buys from sellers through its own buyer. Fund it:

```bash
antseed-verifier buyer status     # creates the identity and shows its address
antseed-verifier buyer deposit    # shows where to send USDC
```

`verifier start` starts this buyer itself. To use a buyer you already run, add `--no-buyer` (and `--buyer-port <port>` if it isn't on `buyer.proxyPort`).

## 4. Get approved

Only approved verifiers take part in rounds. Ask in the [Antseed Telegram community](https://t.me/antseed) with your verifier address; the contract owner approves it with `setVerifier`. An approval takes effect from the next epoch that opens.

Until you're approved, `verifier start` stops with "is not an approved verifier". You can still try an audit locally with `antseed-verifier verifier run <model>` (see [Local audits](/docs/verify/audits#local-audits)).

## 5. Start the verifier

```bash
antseed-verifier verifier start
```

On first start it creates an encryption key pair in `<data-dir>/verifier/round/encryption-key.json` and publishes the public key on-chain, so the round can send it its questions. Keep that file: a new key is published if it's lost, and an epoch already planned for the old key is covered by backups.

Before starting, it checks that your CLI is the latest `@antseed/cli` on npm, so every verifier scores the same way. Update with `antseed update`. `--skip-version-check` skips the check.

Run it under a process manager (systemd, a container) so it restarts with the machine. It logs one line per step; each epoch's files are in `<data-dir>/verifier/round/epochs/<epoch>/`.

## Next

- [How verification rounds run](/docs/verify/audits): the weekly schedule, how questions are kept secret, scoring, majority attestation and rewards.
- [Model verification](/docs/model-verification): the method and what goes on-chain.
