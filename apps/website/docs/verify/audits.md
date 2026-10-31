---
title: How verification rounds run
slug: /verify/audits
description: How KBF verification rounds run — the weekly schedule, how the questions stay secret until collection is over, how sellers are scored, how verifiers agree on results on-chain, and how rewards are split.
---

# How verification rounds run

This page covers **KBF audits**, one of the first of many verification methods Antseed is launching, with more to come (see [Model verification](/docs/model-verification#one-method-among-many)). For setup, see [Become a verifier](/docs/verify).

KBF audits run as one round per epoch (one week), shared by every approved verifier. No single verifier decides a verdict: every verifier scores the same public data, and a result only counts once a majority of verifiers attest the same results.

## Roles

| Role | Who | Does |
|---|---|---|
| Owner | The contract owner | Approves verifiers and the publisher, sets the list of audited models and the schedule |
| Publisher | Antseed's reference publisher, `antseed verifier publish` | Builds and seals each epoch's question bank, publishes the plan, reveals the bank key. It decides no verdicts, and verifiers can finish a round without it (see [If the publisher goes missing](#if-the-publisher-goes-missing)) |
| Verifiers | Approved addresses, `antseed verifier start` | Buy questions from sellers, score the epoch, attest the results, and earn rewards |

## The schedule

Each epoch follows the same timeline, as offsets from the epoch start. The defaults:

| Phase | Default | What happens |
|---|---|---|
| Bank | during the previous epoch | The publisher builds a fresh question bank for every audited model, encrypts it and commits its hash on-chain |
| Open | start of the epoch | A verifier opens the epoch. This fixes the epoch's verifiers, models and schedule; anyone approved later joins from the next epoch |
| Seed | 4 blocks later | A verifier fixes the epoch's random seed from that block's hash. The seed decides which questions each seller gets and who buys them |
| Collect | 3 days | The publisher publishes the plan. Each verifier buys its slices from the sellers and commits the signed responses |
| Backup | 1 day | Each slice's backup verifier buys it if its owner didn't deliver it |
| Attest | 1 day | The publisher reveals the bank key. Every verifier scores the epoch and attests the results root |

The owner can change the schedule (`setSchedule`) for epochs opened later. `verifier start` takes each step on its own as soon as it is due.

## Keeping the questions secret

A seller that knew the questions in advance could answer them with the genuine model and serve something else the rest of the time. So:

- **The bank is sealed.** Only its hash and the hash of its key are on-chain while sellers are being asked. The bank itself sits on IPFS, encrypted.
- **Each verifier only sees its own questions.** The plan lists the sellers to audit and holds, per verifier, one envelope with the questions of its own slices and one with the slices it backs up, each encrypted to the key that verifier published on-chain. Envelopes have none of the answers.
- **Questions are fresh.** Each bank is built for its epoch and leaves out the questions of the last 8 banks.
- **The key is revealed when buying is over.** After the backup deadline the publisher reveals the bank key on-chain. The contract checks it against the committed hash, and from then on anyone can decrypt the bank and check the round.
- **The key is escrowed with the verifiers.** Once the epoch is open, the publisher splits the bank key into Shamir shares, one sealed to each of the epoch's verifiers, and commits the share file's hash on-chain. Any majority of the shares rebuilds the key; fewer reveal nothing. A majority of verifiers can already decide the results, so this adds no new trust.

## If the publisher goes missing

The publisher is a convenience, not a requirement:

- **No plan in time.** If no plan is committed 6 hours into the epoch (`publisherGraceSeconds`), any of the epoch's verifiers can take the epoch over: it builds its own bank, commits it with `takeOverBank` and runs the rest of the round as the epoch's publisher (key escrow, plan, key reveal). `verifier start` does this on its own. Verifiers take turns 10 minutes apart, in an order drawn from the epoch, so they don't all build a bank at once, and a further takeover waits another grace period. Taking over needs the verifier's buyer and a working [reference upstream](#reference-upstreams), the same setup the publisher uses to build a bank. An epoch that was already opened gets a new seed.
- **No key reveal.** If the bank key is still hidden 10 minutes after the backup deadline, each verifier posts its share on-chain (`revealKeyShare`), up to the attest deadline. As soon as a majority of shares are on-chain, any verifier rebuilds the key and reveals it. A forged share is ignored, because every share is checked against the hash in the share file.

## Which sellers are audited

The publisher's buyer finds the sellers. A seller service is audited when the seller:

- is staked and has an on-chain agent id;
- advertises a model on the contract's list of audited models;
- charges at or below that model's [price limit](#price-limit);
- meets the buyer's `buyer.minPeerReputation`;
- is bound to its agent: on the seller registry, the seller's peer points to the agent and the agent to the peer.

Verifiers check that last binding themselves, at the block the epoch's seed was fixed from, so they all read the same state. A target that fails it is never bought or scored, so a publisher can't pin one seller's answers on another agent. This needs an RPC that serves state at past blocks.

## Slices and backups

Each audited seller service gets 100 questions (`probesPerService`), in batches of 10 on one topic, with varied wording. The batches are split into 4 slices (`slicesPerService`), and each slice has an owner and a backup verifier, both picked at random from the seed. A seller never buys its own slices.

- Each verifier buys its slices from the seller through its own buyer, as normal paid requests pinned to that seller, and keeps the seller's signature on every response. A batch is retried only when there is no signed answer.
- Before the collection deadline it publishes its slices on IPFS and commits their hash on-chain.
- After the deadline, each backup verifier checks the committed slices against the questions in its backup envelope. Every slice it backs up whose owner didn't deliver a complete, validly signed copy, it buys and commits before the backup deadline. It decides this exactly as scoring later does, and it needs nothing from the publisher, so backups still happen if the publisher is gone after the plan. A slice file it can't fetch yet is waited for during the first quarter of the backup window.

A verifier that is offline loses its share of the slices, and its backups cover for it.

Before buying anything, a verifier checks its envelope against the public plan: only slices the seed assigns to it, of sellers on the plan, at most the schedule's questions per seller, questions of bounded length and request settings limited to the reference's token and thinking fields. An envelope that asks for anything else is refused, so a dishonest publisher can't make a verifier pay for work that will never count. `verifier start --max-epoch-requests` (default 1,000) also caps how many seller requests a verifier sends per epoch, retries included, whatever the envelopes say. A verifier whose encryption key can't receive envelopes gets none, like an offline verifier: its slices go to backups and it holds no key share.

## Scoring

After the key reveal, every verifier rebuilds the epoch from public data only: the revealed bank, the plan derived from the seed, and the committed slices. A batch only counts with the seller's valid signature over exactly the planned request: the planned system and user messages (plus the reference's assistant prefill, if it has one), temperature 0, the reference's token limit and thinking settings, and nothing else. A request with an extra instruction, tool or setting doesn't count, so a collector can't steer a seller into wrong answers. A slice file that isn't a valid slice file is ignored; one that can't be fetched yet is retried until halfway through the attest window before it counts as missing. Each seller service gets a verdict:

| Verdict | Meaning |
|---|---|
| `SAME` | The seller misses about as often as the genuine model |
| `DIFF` | The seller misses clearly more often: probably a different model |
| `UNDETERMINED` | Not enough to decide |

- A service with any slice missing or invalid is `UNDETERMINED`.
- A missing or unreadable answer is left out of the score, not counted as wrong. `SAME` and `DIFF` each need at least 80% of the questions answered, so a seller can't earn `SAME` by leaving out the answers it would get wrong.
- The test compares the seller's misses with the genuine model's own error rate, measured when the bank was built.

Scoring is deterministic, so honest verifiers get the same results and the same root.

## Attesting and applying results

Each verifier publishes its results on IPFS and attests their Merkle root on-chain, once per epoch. The first root that a majority of the epoch's verifiers attest becomes the epoch's final root.

After that, anyone can apply the results to the contract, each with a proof against the final root. `verifier start` does it: one verifier, picked at random from the seed, applies right away, and the others step in two hours after the attest deadline if it is still undone. A verdict counts for the epoch it was given in and the next one; a newer epoch's verdict for the same service replaces it.

## Rewards

Each epoch's verification budget of ANTS emissions is split in two:

- **Attester pool** (`attestRewardBps`, 20% by default): shared equally by the verifiers that attested the final root.
- **Collector pool** (the rest): shared by the slices each verifier delivered that went into the results.

One verifier's claim is capped at `maxVerifierShareBps` (20% by default) of the epoch's budget. Both settings are fixed for an epoch when it opens, so changing them only affects later epochs. Rewards can be claimed once an epoch is over; `verifier start` claims them for up to 4 finished epochs.

## Price limit

A seller is only audited at or below the most any OpenRouter provider charges for the model. Input and output each take the highest price across OpenRouter's providers for the model, leaving out speed tiers (`fast`, `ultrafast`, `flex`), which are the same model at a different speed and price. If the model's reference upstream or `verifier.models.<model>.pricing` is higher, that is used instead. If OpenRouter lists no providers for the model, the reference upstream, `verifier.models.<model>.pricing` or the OpenRouter catalog price is used. `verifier.auditPriceRatio` (default 1) allows sellers that charge somewhat more, for example `1.1` for up to 10% more.

A verifier's buyer must accept those prices: set `buyer.maxPricing.defaults` at least as high as the most expensive audited model's price.

## Reference upstreams

The genuine answers in a bank come from the publisher's `verifier.referenceEndpoint` (OpenRouter by default), which also supplies the look-alike models and the price catalog. To take one model's genuine answers straight from its maker, add an upstream and point the model at it:

```json
{
  "verifier": {
    "upstreams": {
      "anthropic": { "type": "anthropic", "baseUrl": "https://api.anthropic.com/v1", "apiKeyEnv": "ANTHROPIC_API_KEY" }
    },
    "models": {
      "claude-opus-5.5": { "upstream": { "name": "anthropic", "model": "claude-opus-5-5" } }
    }
  }
}
```

| `type` | Use for |
|---|---|
| `openai` | Any OpenAI-compatible API (OpenAI, Together, a vLLM server) |
| `anthropic` | Anthropic's own API |
| `openrouter` | OpenRouter, optionally pinned to one provider with `referenceProvider: { "order": ["…"] }` |
| `antseed` | One Antseed seller you trust (`peerId`), through your running buyer. Needs `upstream.pricing` |

`antseed verifier models` shows where each model's answers come from. Use a source you trust to serve the real model: if it doesn't, every audit built on it is wrong. The same settings apply to [local audits](#local-audits).

## Local audits

`antseed verifier run <model>` (or `--all`) audits the sellers your buyer has found, on your own machine, with your own question banks. Nothing goes on-chain: it is for testing a setup and investigating a seller. It needs a reference source (`verifier.referenceEndpoint`) to build its banks, and each DIFF is rechecked on questions the seller hasn't seen. `antseed verifier status` follows a run, and `antseed verifier overview` writes a page with every seller × model of an epoch's local runs.

## Check a model yourself

`antseed verifier check <model> --base-url <url>` audits any OpenAI- or Anthropic-compatible endpoint against the newest revealed bank that includes the model, or `--epoch <n>`'s bank. Exit code 0 is `SAME`, 2 `DIFF`, 3 `UNDETERMINED`.

## Configuration

All keys live in the `verifier` block of the config file. The most used:

| Key | Default | Meaning |
|---|---|---|
| `keystore` | | Keystore that signs round transactions (password from `ANTSEED_KEYSTORE_PASSWORD`) |
| `referenceEndpoint` | | Where the genuine answers come from, for the publisher and local audits. See [Reference upstreams](#reference-upstreams) |
| `upstreams`, `models.<model>.upstream` | | Other sources for one model's genuine answers |
| `auditPriceRatio` | 1 | Audit sellers priced up to this multiple of the upstream price |
| `models.<model>.pricing` | | The model's upstream price, if not taken from OpenRouter |

Environment:

| Variable | Meaning |
|---|---|
| `PINATA_JWT` | Publishes round files (slices, results, banks, plans) on IPFS |
| `ANTSEED_IPFS_GATEWAYS` | Comma-separated IPFS gateways to read round files (public gateways by default) |
| `ANTSEED_ROUND_STORAGE_DIR` | Keep round files in a local directory instead of IPFS (testing) |
| `ANTSEED_KEYSTORE_PASSWORD` | Password of the signing keystore |
