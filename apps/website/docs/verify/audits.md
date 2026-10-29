---
title: How audits run
slug: /verify/audits
description: How KBF audits run — which models each auditor audits, which sellers are audited, how verdicts are decided, where the genuine answers come from, and how results go on-chain.
---

# How audits run

This page covers **KBF audits**, one of the first of many verification methods Antseed is launching, with more to come (see [Model verification](/docs/model-verification#one-method-among-many)). For setup, see [Become a verifier](/docs/verify).

## One audit

1. **Reference banks.** For each model, `verifier reference build` asks the genuine model short questions with exact answers. It keeps the ones it answers consistently and that cheaper look-alike models get wrong.
2. **Questions.** `verifier run` asks each seller a fresh set of those questions. These are normal paid requests, and the seller must sign every response.
3. **Verdict.** The seller's answers are compared with the genuine ones:

| Verdict | Meaning |
|---|---|
| `SAME` | The seller misses about as often as the genuine model |
| `DIFF` | The seller misses clearly more often: probably a different model |
| `UNDETERMINED` | Too few usable answers to decide, or a `DIFF` the recheck didn't confirm |

   A missing, empty or unreadable answer is left out of the score, not counted as wrong. A `SAME` needs at least half the questions answered and a `DIFF` at least 80%, so a seller can't make a `DIFF` more likely by dropping answers; below that the result is `UNDETERMINED`. A batch with any answer missing is asked again up to two more times, and the try with the most answers is kept. Answers sent as `<number>X</number>` lines without question numbers are read in order when there is exactly one per question.

4. **Recheck.** Every `DIFF` is rechecked on questions the seller hasn't seen. It stays `DIFF` only if the recheck is `DIFF` too; a recheck `SAME` or `UNDETERMINED` makes it `UNDETERMINED`. A `DIFF` whose recheck couldn't run is not submitted.
5. **Submit.** `verifier submit` publishes the evidence and puts the results on-chain.

Running `verifier run` again in the same epoch retries the `UNDETERMINED` sellers and rechecks any earlier `DIFF` whose recheck couldn't run, without repeating its first check.

### The epoch overview

`verifier run` and `verifier submit` write `<data-dir>/verifier/evidence/epochs/<epoch>/overview.html`. It shows every seller × model from all of the epoch's runs, merged in the order they are submitted, so a later verdict replaces an earlier one, as on-chain. Hover a yellow (`UNDETERMINED`) or grey (tried, not submitted) dot for the reason, in the same words as [AntScan](https://antscan.co), plus the match rate of the first check and the recheck. `antseed verifier overview [--epoch <n>] [--run <ids...>]` rebuilds it, optionally from only some runs.

## Which models you audit

The audited models are built into the CLI, the same for every auditor. Every model is audited every epoch: the models are split across the approved auditors, round robin, and `verifier run` audits your share.

- Each model has exactly one auditor per epoch, and auditors get the same number of models, give or take one.
- The split moves every epoch, so with two or more auditors you never audit the same model two epochs in a row, and over as many epochs as there are auditors you audit every model once.
- Auditors and models are sorted (by address and by name), so everyone works out the same split. The approved auditors are the ones approved when the epoch started; anyone approved later joins from the next epoch.

`antseed verifier assignment` shows every auditor's models (`--epochs 4` for the next few). `verifier run <model>` or `--all` still audits any model.

The assignment is not enforced on-chain: the contract records any approved auditor's audit of any model, and keeps only the latest result per seller service, whoever submitted it. Two things follow:

- If an auditor doesn't run in an epoch, its models get no new verdict that epoch. Earlier verdicts still count until they expire.
- Auditing models outside your share can overwrite another auditor's verdict for the same seller.

Auditors on different CLI versions can have different model lists, and so different splits. `verifier run` and `verifier assignment` print a hash of the model list to compare.

## Which sellers are audited

Every seller your buyer has found that offers the model. A seller is skipped when:

| Skip code | Reason |
|---|---|
| `missing_response_auth` | It doesn't sign its responses |
| `reputation_below_minimum` | Its trust score is below `buyer.minPeerReputation` |
| `price_above_reference` | It charges more than the model's upstream price |
| `policy_rejected` | Its pricing couldn't be read |

### Your buyer's price cap

Audit requests go through your running buyer, which refuses sellers above its own `buyer.maxPricing`. Before sending anything, `verifier run` checks that the running buyer's caps are at or above every audited model's reference price. They don't have to match it. If one is lower, the run stops:

```
the running buyer would refuse sellers priced at or below the reference:
  - claude-fable-5.1: the buyer price cap is below its reference price (input $5 < $10, output $30 < $50, cached input $5 < $10 per 1M)
Set buyer.maxPricing.defaults to at least input $10, output $50 (and cachedInputUsdPerMillion, if set, to at least the input value) and restart the buyer.
```

### Checks before the run

Before sending anything, `verifier run` stops with a list of problems and how to fix each when:

- the chain can't be reached, so the run could not be submitted;
- your buyer deposit can't cover a payment channel for every seller you don't have one with yet (each reserves `payments.maxReserveAmountUsdc`, $1 by default);
- a model's probe bank can't be loaded (rebuild it with `verifier reference build <model>`);
- a seller has too few questions it hasn't seen for an audit and a DIFF recheck (add `--enroll-if-needed --max-enrollment-requests <n>`).

To run anyway, add `--ignore-pre-run-checks`: the problems are printed as warnings. Audits that fail because of them can come back `UNDETERMINED`.

### Up-to-date CLI

All auditors must audit the same models in the same way, or the round-robin split and the results don't line up. So `verifier run` and `verifier submit` first compare your CLI with the latest published release. Only the verifier part is compared: a hash of the audited models and the version of the audit rules, kept in the CLI's `package.json` (`antseedVerifier`). The commands read that file at the latest Antseed release on GitHub. A release that changes nothing about audits doesn't ask you to update.

If they differ, the command stops before sending anything:

```
this CLI (0.1.211) audits differently from the latest release 0.1.214: the list of audited models changed. Update with `antseed update` …
```

If GitHub can't be reached, `verifier run` warns and continues, and `verifier submit` stops (`submit --dry-run` only warns). `--skip-version-check` skips the check on both.

### Price limit

The auditor doesn't pay a seller more than the most any OpenRouter provider charges for the model. Input and output each take the highest price across OpenRouter's providers for the model, leaving out speed tiers (`fast`, `ultrafast`, `flex`), which are the same model at a different speed and price. If the model's reference upstream or `verifier.models.<model>.pricing` is higher, that is used instead. If OpenRouter lists no providers for the model, the reference upstream, `verifier.models.<model>.pricing` or the OpenRouter catalog price is used. A seller priced above it is skipped:

```
priced $17/$85 per 1M, above the claude-fable-5.1 reference $10/$50 · not audited
```

`verifier.auditPriceRatio` (default 1) lets you audit sellers that charge somewhat more, for example `1.1` for up to 10% more.

## Reference banks

Banks live in `<data-dir>/verifier/banks`. A build stops once the bank can reliably tell the genuine model from its look-alikes, or after 2,000 requests (`verifier.referenceMaxRequestsPerBuild`). Running it again grows the bank and never replaces it. Seller audits never call the reference API: sellers are compared with the answers stored in the bank.

## Reference upstreams

The genuine answers come from `verifier.referenceEndpoint` (OpenRouter in the setup example), which also supplies the look-alike models and the price catalog. To take one model's genuine answers straight from its maker, add an upstream and point the model at it:

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

`antseed verifier models` shows where each model's answers come from. Use a source you trust to serve the real model: if it doesn't, every audit built on it is wrong. A bank keeps one source, so changing it later needs a new bank.

## Getting approved

Submitting needs an **approved auditor address**. Ask in the [Antseed Telegram community](https://t.me/antseed) with the address you will submit from.

- By default this is the data-dir identity (`antseed buyer status` shows it). To sign with a keystore instead, set `verifier.keystore`.
- It needs a little ETH on Base for the transactions.
- It can't audit sellers it owns.

## Submitting

```bash
antseed verifier submit --dry-run
export PINATA_JWT=…
antseed verifier submit --publish-ipfs --yes
```

`submit` sends the whole current epoch: every run of the epoch, merged, with the latest result per model and seller. `--run-id <id>` sends one run instead. The dry run checks everything, including your approval. `--publish-ipfs` makes the evidence public on IPFS. Audits can only be submitted in the epoch they ran in, and re-running `submit` is safe.

## Running again in the same epoch

Run the same `antseed verifier run` command again; it continues the epoch. It first prints a plan built from the epoch's earlier runs:

- **Finished:** SAME, or a DIFF the recheck confirmed or overturned. Not asked again.
- **Retry, our side:** our buyer refused the seller, a payment channel timed out, the deposit or a probe bank was missing. Retried on every run.
- **Retry, seller or unclear:** the seller was unreachable, too slow or sent bad answers. Retried once per epoch. A retry keeps the answers the seller already gave.
- **Recheck:** a DIFF whose recheck couldn't run.
- **New:** a seller or model not audited yet, or skipped earlier (for example its price was above the reference).

One run does this in rounds: after the first round it retries what is left (failures, waiting rechecks) with a larger probe-bank budget, up to `--max-rounds` rounds (default 3). It stops early when nothing is left, a round makes no progress, or less than 45 minutes of the epoch remain.

The run ends with a table of the whole epoch and the next command. `--fresh` ignores the earlier runs.

## Running every epoch

A verdict counts for the epoch it was given in and the next one, so run and submit once per epoch, for example from cron:

```bash
antseed verifier run; antseed verifier submit --publish-ipfs --yes
```

## Rewards

Auditors share the verification part of ANTS emissions: one credit per model audited per epoch. Once an epoch has ended, claim with `antseed verifier rewards --claim`.

## Configuration

All keys live in the `verifier` block of the config file. The most used:

| Key | Default | Meaning |
|---|---|---|
| `referenceEndpoint` | required | Where the genuine answers come from. See [Reference upstreams](#reference-upstreams) |
| `upstreams`, `models.<model>.upstream` | | Other sources for one model's genuine answers. See [Reference upstreams](#reference-upstreams) |
| `keystore` | | Keystore that signs `submit` and `rewards --claim` |
| `auditor` | data-dir identity | Your approved auditor address |
| `auditPriceRatio` | 1 | Audit sellers priced up to this multiple of the upstream price |
| `models.<model>.pricing` | | The model's upstream price, if not taken from OpenRouter |
