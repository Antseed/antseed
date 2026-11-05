---
title: Model verification
sidebar_label: Overview
slug: /verify/overview
description: How Antseed checks that sellers serve the models they advertise, what the results mean, and how they affect routing and ANTS rewards.
---

# Model verification

When you pay a seller for Claude Opus or GLM, you should get Claude Opus or GLM, not a cheaper model sold under the same name. Model verification is how the network checks this. Independent auditors buy from sellers like any other buyer, test the answers, and record the result on-chain, where anyone can look it up.

The first method running on the network is the **KBF audit**. More methods will follow. They all record their results in the same place, so everything on this page applies to them too.

## How a KBF audit works

Every model remembers obscure facts in its own way, including the ones it gets slightly wrong. Ask two different models for the melting point of tantalum carbide and you will often get two different numbers. Taken over many such questions, that pattern is a fingerprint of the model. KBF stands for Knowledge Boundary Fingerprinting.

For each model, the auditor first asks the genuine model a large bank of these questions, through the model maker's API or OpenRouter. It keeps the questions that tell the real model apart from its look-alikes, and measures how often the real model itself gets them wrong. Then it asks each seller about 100 of them, picked at random and reworded each time, and compares how often the seller misses with how often the genuine model does.

Audit requests are ordinary paid requests with no special label, and the seller is paid for them like any other traffic.

## What the results mean

| Result | Meaning |
|---|---|
| **SAME** | The seller answered the way the genuine model does. This is strong evidence, not proof. |
| **DIFF** | The seller missed far more often than the genuine model. It is very likely serving a different model. |
| **UNDETERMINED** | There weren't enough usable answers to decide, usually because the seller returned errors, timed out or sent empty answers. |

A few rules keep this fair:

- One auditor can't mark a seller DIFF on its own. A DIFF is recorded only after a second auditor tests the same seller with its own questions and gets the same result.
- Results expire. A result counts for the epoch it was given in and the next one, so one to two weeks. Sellers are audited again every epoch, and a seller that fixes its setup recovers at its next audit.
- Each result covers one service: one seller's offer of one model.
- The evidence is public. The questions, the seller's answers and the statistics go to IPFS, and anyone can run the same check again.

## What a result changes

**Routing.** A service with a DIFF keeps only 10% of its reputation, so automatic routing stops sending requests to it. The seller's overall trust score drops by the same amount as its points (below), so it ranks lower for its other models too; verified services never raise it.

**ANTS rewards.** Every settlement with a seller earns points for the seller and the buyer, and those points decide how much ANTS each of them gets. A seller's results scale those points, counting all of its services together:

- Each service with a SAME adds 2%, up to +50% in total.
- Services with a DIFF take away 4% times the number of DIFF services squared.

| DIFF services | Effect on points |
|---|---|
| 0 | +2% for each SAME service, up to +50% |
| 1 | −4% |
| 2 | −16% |
| 3 | −36% |
| 4 | −64% |
| 5 or more | No points at all |

A seller with 6 SAME services and no DIFF earns 112% of its usual points. Its buyers earn 112% too. With 6 SAME and 1 DIFF, both get 108%. Because staker rewards follow the points of the seller's pool, people staking in that pool see the same effect.

These are the current settings on Base mainnet. The contract owner can change them, and a change applies from the next settlement.

Results never touch USDC payments. A seller with a DIFF is still paid for what it served.

## Where to see results

[Antscan](https://antscan.co/view/verifications) lists every audited seller with its SAME and DIFF services, and links each result to its audit and evidence. In the desktop app, a service with a DIFF shows a warning in Discover.

## Read next

- [For buyers](/docs/verify/buyers): what verification does for you, and how to check a seller yourself.
- [For providers](/docs/verify/providers): how you are audited, what a DIFF costs, and how to fix one.
- [Become a verifier](/docs/verify): run audits and earn ANTS for them.
- [How audits run](/docs/verify/audits): every step of an audit in detail.
- [Protocol: Model verification](/docs/model-verification): the contracts and the exact rules.
