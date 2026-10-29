---
title: How audits run
slug: /verify/audits
description: How KBF audits run — which models each auditor audits, which sellers are audited, how verdicts are decided, where the genuine answers come from, and how results go on-chain.
---

# How audits run

This page covers **KBF audits**, one of the first of many verification methods Antseed is launching, with more to come (see [Model verification](/docs/model-verification#one-method-among-many)). For setup, see [Become a verifier](/docs/verify).

## Running an audit

With the buyer running (`antseed buyer start`), each epoch is:

```bash
antseed verifier run                          # audit, recheck and retry, all in one run
antseed verifier status                       # optional, from another terminal
antseed verifier submit --dry-run             # check before sending
antseed verifier submit --yes                # publish the evidence and put the results on-chain
```

The rest of this page explains what these commands do.

## One audit

1. **Reference banks.** For each model, the auditor asks the genuine model short questions with exact answers. It keeps the ones it answers consistently and that cheaper look-alike models get wrong (see [Reference banks](#reference-banks)).
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

### Following a run

`antseed verifier status` shows a running audit from another terminal. When a run finishes it prints its run ID, an HTML report per model and the epoch overview.

### The epoch overview

`verifier run` and `verifier submit` write `<data-dir>/verifier/evidence/epochs/<epoch>/overview.html`. It shows every seller × model from all of the epoch's runs, merged in the order they are submitted, so a later verdict replaces an earlier one, as on-chain. Hover a yellow (`UNDETERMINED`) or grey (tried, not submitted) dot for the reason, in the same words as [AntScan](https://antscan.co), plus the match rate of the first check and the recheck. `antseed verifier overview [--epoch <n>] [--run <ids...>]` rebuilds it, optionally from only some runs.

## Which models you audit

The audited models are built into the CLI, the same for every auditor (`antseed verifier models` lists them). Every model is audited every epoch: the models are split across the approved auditors, round robin, and `verifier run` audits your share. Until you are approved you have no share: `verifier run --all` or `verifier run <model>` tries an audit you can't submit.

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
- a seller has too few questions it hasn't seen for an audit and a DIFF recheck (only with `--no-enroll`; by default the run builds fresh questions, see [Reference banks](#reference-banks)).

To run anyway, add `--ignore-pre-run-checks`: the problems are printed as warnings. Audits that fail because of them can come back `UNDETERMINED`.

### Up-to-date CLI

All auditors must audit the same models in the same way, or the round-robin split and the results don't line up. So `verifier run` and `verifier submit` first compare your CLI version with the CLI version of the latest Antseed release on GitHub. If yours is older, the command stops before sending anything, even if the new release changed nothing about audits:

```
this CLI (0.1.211) is older than the latest release 0.1.214 (GitHub release v0.2.71). Update with `antseed update` …
```

If GitHub can't be reached, `verifier run` warns and continues, and `verifier submit` stops (`submit --dry-run` only warns). `--skip-version-check` skips the check on both.

### Price limit

The auditor doesn't pay a seller more than the most any OpenRouter provider charges for the model. Input and output each take the highest price across OpenRouter's providers for the model, leaving out speed tiers (`fast`, `ultrafast`, `flex`), which are the same model at a different speed and price. If the model's reference upstream or `verifier.models.<model>.pricing` is higher, that is used instead. If OpenRouter lists no providers for the model, the reference upstream, `verifier.models.<model>.pricing` or the OpenRouter catalog price is used. A seller priced above it is skipped:

```
priced $17/$85 per 1M, above the claude-fable-5.1 reference $10/$50 · not audited
```

`verifier.auditPriceRatio` (default 1) lets you audit sellers that charge somewhat more, for example `1.1` for up to 10% more.

## Reference banks

A model's bank holds the questions and the genuine model's answers. Banks live in `<data-dir>/verifier/banks`, and seller audits never call the reference API: sellers are compared with the answers stored in the bank.

`verifier run` builds banks on its own, before it asks any seller:

- **No bank yet, or too small** to tell the genuine model from its look-alikes: it builds one. On a new verifier this is the whole first run's set-up, so the first run takes longest.
- **Worn out:** each seller only gets questions it hasn't been given in an earlier epoch, so a bank wears out as the same sellers are audited again. When any seller about to be audited lacks an unseen audit set plus a recheck set, it builds fresh questions and adds them to the bank, up to 3 builds per model.
- **Ready:** no reference calls.

Each build is billed by the reference API and stops once the bank is ready, or after 2,000 requests per model (`--max-enrollment-requests` changes it, `verifier.referenceMaxRequestsPerBuild` caps it). Building grows a bank and never replaces it. `--no-enroll` turns this off: the run then stops before sending anything when a bank isn't ready. `antseed verifier reference build [<model> | --all]` builds banks ahead of time, for example to spread the cost before the first run.

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
antseed verifier submit --yes
```

`submit` sends the whole current epoch: every run of the epoch, merged, with the latest result per model and seller. `--run-id <id>` sends one run instead. The dry run checks everything, including your approval. `submit` makes the evidence public on IPFS, which needs `PINATA_JWT`; `--no-publish-ipfs` submits without publishing it. Audits can only be submitted in the epoch they ran in, and re-running `submit` is safe.

## Running again in the same epoch

Run the same `antseed verifier run` command again; it continues the epoch. It first prints a plan built from the epoch's earlier runs:

- **Finished:** SAME, or a DIFF the recheck confirmed or overturned. Not asked again.
- **Retry, our side:** our buyer refused the seller, a payment channel timed out, the deposit or a probe bank was missing, or the seller had already seen too much of the bank (`BANK_EXHAUSTED`). Retried on every run.
- **Retry, seller or unclear:** the seller was unreachable, too slow or sent bad answers. Retried once per epoch. A retry keeps the answers the seller already gave.
- **Recheck:** a DIFF whose recheck couldn't run.
- **New:** a seller or model not audited yet, or skipped earlier (for example its price was above the reference).

One run does this in rounds: after the first round it retries what is left (failures, waiting rechecks) with a larger probe-bank budget, up to `--max-rounds` rounds (default 3). It stops early when nothing is left, a round makes no progress, or less than 45 minutes of the epoch remain.

The run ends with a table of the whole epoch and the next command. `--fresh` ignores the earlier runs.

## Running every epoch

A verdict counts for the epoch it was given in and the next one, so run and submit once per epoch, for example from cron:

```bash
antseed verifier run; antseed verifier submit --yes
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
