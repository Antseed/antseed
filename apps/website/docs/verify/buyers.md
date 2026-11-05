---
title: Model verification for buyers
sidebar_label: For buyers
slug: /verify/buyers
description: What model verification does for buyers, how it affects routing and the ANTS you earn, and how to check a seller yourself.
---

# Model verification for buyers

You don't need to set anything up. Your buyer reads every seller's verification results from the chain and uses them on its own. This page explains what it does with them, and how to run a check yourself when you want to be sure. For the basics, see the [overview](/docs/verify/overview).

## Routing skips sellers with a DIFF

When a seller's service has a DIFF, its reputation for that service drops to 10%. With the default minimum trust score of 60, automatic routing no longer picks it. The seller's overall trust score also drops by the same amount its ANTS points do (4% for one DIFF service, up to zero at five), so it ranks lower for every model. A DIFF that is still waiting for a second auditor changes nothing.

You can still reach a DIFF service on purpose by pinning it. If you lower your buyer's minimum trust score far enough, automatic routing can pick it again. [Routing](/docs/api/routing) has the details.

Your buyer checks results at most every two minutes per seller. If it can't reach the chain, it keeps using the last result for up to 15 minutes, then stops applying the cut. So a problem on the network side never blocks your requests.

## Verified sellers earn you more ANTS

Buyers earn ANTS for paid usage. How much depends on the points each settlement earns, and those points follow the seller's results:

- On a seller with SAME results and no DIFF, you get 2% more points for each verified service, up to 50% more.
- On a seller with DIFF results, you get fewer: 4% fewer with one DIFF service, 16% with two, 36% with three, 64% with four, and none from five on.

So the same spend earns more on sellers with a clean record. The rates are the current Base mainnet settings and can change. See [Recognized usage](/docs/recognized-usage) for how points turn into ANTS.

## Check a seller yourself

You can rerun the latest published audit of a model yourself, against a seller through your buyer or against any OpenAI- or Anthropic-compatible endpoint. You pay for the questions, about 100 short requests.

```bash
antseed verifier check <model>
```

The command finds the latest on-chain audit for the model, asks the same kind of questions and prints `SAME`, `DIFF` or `UNDETERMINED` (exit code 0, 2 or 3). Use `--base-url` and `--api-key-env` to point it at another endpoint. The full list of options is in the [CLI reference](/docs/commands).

Outside Antseed, the [`@antseed/model-verifier`](https://github.com/AntSeed/antseed/tree/main/packages/model-verifier) package does the same check. The [`antseed-verify-model`](https://github.com/AntSeed/antseed/tree/main/skills/antseed-verify-model) agent skill walks you through it and explains the result.

## See every seller's results

[Antscan](https://antscan.co/view/verifications) lists every audited seller with its SAME and DIFF services and the audits behind them. In the desktop app, a service with a DIFF shows a warning in Discover.
