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
antseed verifier run                          # audit, confirm and retry, all in one run
antseed verifier status                       # optional, from another terminal
antseed verifier submit --dry-run             # check before sending
antseed verifier submit --yes                # publish the evidence and put the results on-chain
```

The rest of this page explains what these commands do.

## One audit

1. **Reference banks.** For each model, the auditor asks the genuine model short questions with exact answers. It keeps the ones it answers consistently and that cheaper look-alike models get wrong (see [Reference banks](#reference-banks)).
2. **Questions.** `verifier run` asks each seller a fresh set of those questions. These are normal paid requests, and the seller must sign every response.

   Before the questions, the auditor works out how to turn off the seller's hidden reasoning ("thinking"), the way the KBF reference code does for every endpoint it checks. It sends a fixed batch of ten easy questions with each setting in turn: `reasoning: {effort: "none"}`, `reasoning: {effort: "minimal"}`, `thinking: {type: "disabled"}`, `enable_thinking: false`, a `<think></think>` prefill, then nothing. It uses the first setting that gets at least 5 answers with no reasoning tokens. If the seller keeps thinking whatever it is sent, its questions go out with 50 times the token budget (40,000 tokens per request), so it has room to think and still answer. This is worked out once per seller and model in each run; the requests and their cost are part of the audit's evidence (`sellerThinking`). Text inside `<think>…</think>` is not read as an answer.
3. **Verdict.** The seller's answers are compared with the genuine ones:

| Verdict | Meaning |
|---|---|
| `SAME` | The seller misses about as often as the genuine model |
| `DIFF` | The seller misses clearly more often: probably a different model |
| `UNDETERMINED` | Too few usable answers to decide |

   A missing, empty or unreadable answer is left out of the score, not counted as wrong. A `SAME` needs at least half the questions answered and a `DIFF` at least 80%, so a seller can't make a `DIFF` more likely by dropping answers; below that the result is `UNDETERMINED`. A batch with any answer missing is asked again up to two more times, and the try with the most answers is kept. Answers sent as `<number>X</number>` lines without question numbers are read in order when there is exactly one per question.

4. **Submit.** `verifier submit` publishes the evidence and puts the results on-chain. A `DIFF` is submitted as found: it is one auditor's report, and it counts only once another auditor confirms it with its own audit (see [Confirmations](#confirmations-from-other-auditors)). Auditors don't recheck their own `DIFF`s.

A close call (a first look that is neither clearly `SAME` nor clearly `DIFF`) gets one extra set of questions the seller hasn't seen, and is decided on both sets together; that is how the auditor reaches any verdict at all, not a second opinion.

Running `verifier run` again in the same epoch retries the `UNDETERMINED` sellers and asks any close call its extra questions if they couldn't be asked, without repeating its first check.

### Following a run

`antseed verifier status` shows a running audit from another terminal. When a run finishes it prints its run ID, an HTML report per model and the epoch overview.

### The epoch overview

`verifier run` and `verifier submit` write `<data-dir>/verifier/evidence/epochs/<epoch>/overview.html`. It shows every seller × model from all of the epoch's runs, merged in the order they are submitted, so a later verdict replaces an earlier one, as on-chain. Hover a yellow (`UNDETERMINED`) or grey (tried, not submitted) dot for the reason, in the same words as [AntScan](https://antscan.co), plus the match rate of the check (and of a close call's extra questions). `antseed verifier overview [--epoch <n>] [--run <ids...>]` rebuilds it, optionally from only some runs.

## Which models you audit

The audited models are built into the CLI, the same for every auditor (`antseed verifier models` lists them). Every model is audited every epoch: the models are split across the approved auditors, round robin, and `verifier run` audits your share. Until you are approved you have no share: `verifier run --all` or `verifier run <model>` tries an audit you can't submit.

- Each model has exactly one auditor per epoch, and auditors get the same number of models, give or take one.
- The split moves every epoch, so with two or more auditors you never audit the same model two epochs in a row, and over as many epochs as there are auditors you audit every model once.
- Auditors and models are sorted (by address and by name), so everyone works out the same split. The approved auditors are the ones approved when the epoch started; anyone approved later joins from the next epoch.

`antseed verifier assignment` shows every auditor's models (`--epochs 4` for the next few). `verifier run <model>` or `--all` still audits any model.

Each model also has a **confirmer** each epoch: the next auditor in the same rotation. A `DIFF` needs a second auditor (see [Confirmations](#confirmations-from-other-auditors)), and the confirmer audits the sellers whose `DIFF` waits for it. With two auditors, each one confirms the other's `DIFF`s, and the roles swap every epoch. `antseed verifier assignment` shows both: the models each auditor audits, and the models it confirms `DIFF`s on. This confirmation replaces a recheck by the same auditor: nobody rechecks their own `DIFF`.

The assignment is not enforced on-chain: the contract records any approved auditor's audit of any model. Two things follow:

- If an auditor doesn't run in an epoch, its models get no new verdict that epoch. Earlier verdicts still count until they expire.
- Auditing models outside your share adds your report to the other auditors' for the same seller.

Auditors on different CLI versions can have different model lists, and so different splits. `verifier run` and `verifier assignment` print a hash of the model list to compare.

## Which sellers are audited

Every seller your buyer has found that offers the model. A seller is skipped when:

| Skip code | Reason |
|---|---|
| `missing_response_auth` | It doesn't sign its responses |
| `reputation_below_minimum` | Its trust score is below `buyer.minPeerReputation` |
| `price_above_reference` | It charges more than the model's upstream price |
| `policy_rejected` | Its price for the model couldn't be read, or your buyer would refuse it (for example cached input priced above input) |

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
- a seller has too few questions it hasn't seen for an audit (only with `--no-enroll`; by default the run builds fresh questions, see [Reference banks](#reference-banks)).

To run anyway, add `--ignore-pre-run-checks`: the problems are printed as warnings. Audits that fail because of them can come back `UNDETERMINED`.

### Up-to-date CLI

All auditors must audit the same models in the same way, or the round-robin split and the results don't line up. So `verifier run` and `verifier submit` first compare your CLI version with the latest `@antseed/cli` on npm, the version `antseed update` installs. If yours is older, the command stops before sending anything, even if the new release changed nothing about audits:

```
this CLI (0.1.211) is older than the latest @antseed/cli 0.1.214. Update with `antseed update` …
```

If the npm registry can't be reached, `verifier run` warns and continues, and `verifier submit` stops (`submit --dry-run` only warns). `--skip-version-check` skips the check on both.

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

Each build is billed by the reference API and stops once the bank is ready, or after 2,000 requests in a round (`--max-enrollment-requests` changes it). A build that runs out continues from where it stopped in the next round or run, up to `verifier.referenceMaxRequestsPerBuild` requests in total (default: 3 times the per-round limit). The limit is per build, not per model: one model can need a build to make its bank usable, up to 3 more when it's worn out and up to 3 more for close-call extra questions. Building grows a bank and never replaces it. `--no-enroll` turns this off: the run then stops before sending anything when a bank isn't ready. `antseed verifier reference build [<model> | --all]` builds banks ahead of time, for example to spread the cost before the first run.

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

`submit` only sends what changes your position on-chain: your first result for a seller service this epoch (including a confirmation of another auditor's report) and a result whose verdict changed. A result you already reported this epoch is left out, and the evidence lists only the results that are sent, so its result count matches the transaction. A model with nothing new is skipped (`claude-opus-5.5: nothing new to submit (23 already on-chain)`), and the preview's **On-chain** column counts what was left out. Two cases are sent again: a report that stopped counting because an auditor was revoked, and a fresh audit after the seller's verdict moved into or out of `DIFF`. A result audited before that change is not, because the contract only counts support given after it (see below). A retry after a failed transaction sends the same evidence again.

## Confirmations from other auditors

Each result is a report. The contract records it as the seller service's verdict once enough different approved auditors report the same result for the same seller service and model in the same epoch:

| Result | Auditors needed |
|---|---|
| `SAME` | 1 |
| `DIFF` | 2 |
| `UNDETERMINED` | 1 |
| `SAME` or `UNDETERMINED` replacing a `DIFF` that still counts | `diffReplacementReports`: 1 by default |

So one auditor's `SAME` verifies a seller right away, and one auditor alone cannot mark a seller `DIFF`. Clearing a recorded `DIFF` takes at least `diffReplacementReports` reports of the new result, which is 1 by default (and on Base mainnet): one auditor's `SAME` or `UNDETERMINED` clears it. The owner can raise it, e.g. to 2, so one auditor alone cannot clear a `DIFF` two auditors agreed on. Only reports made after a `DIFF` was confirmed count toward clearing it, and only reports made after it was cleared count toward giving it again. While a `DIFF` waits for its second auditor, the seller keeps its current verdict. Reports count only in the epoch they were made in; a recorded verdict counts for that epoch and the next, like every verdict. Your own report never confirms itself: submitting the same result again adds nothing. When an auditor is revoked, every report still waiting for a second auditor starts over, so a revoked auditor's report never counts; verdicts already recorded stay. The contract owner can change the numbers.

`verifier run` confirms automatically. Before it plans the run, it reads this epoch's reports that still need another auditor, and audits the sellers it is responsible for: those where it is the model's confirmer, or the next auditor in the rotation who hasn't reported yet. From halfway through the epoch, any auditor who hasn't reported on a waiting result picks it up. This includes models outside your share: a model you have no bank for gets one built first, the same way as for your own models. Your audit is a normal audit on your own questions. It can confirm the report or disagree with it, and either way it earns credit like any other audit. `--no-confirm` skips these sellers, and `verifier run <model>` confirms only that model's reports. If your audit of a `DIFF` waiting for you ends `UNDETERMINED` because the seller failed (unreachable, too slow, bad answers), it isn't submitted yet, since it would replace the waiting `DIFF`: the seller is audited again at least 10 minutes later, up to 3 attempts in the epoch, and only the last attempt's `UNDETERMINED` is submitted. `submit` lists such a seller as held. A close call that stays undecided after its extra questions is submitted at once. Confirmations you can't audit now (the seller no longer advertises the service, or is skipped) stay waiting, and `verifier run` says why. With fewer approved auditors than a `DIFF` needs, no `DIFF` can be recorded; `verifier run` warns about it.

After a submission, `submit` lists for each model how many of your results are recorded and which still wait for another auditor (for example `agent 1234: DIFF 1/2`).

## Keeping a verifier running

`antseed verifier watch` does the run and the submit for you, on a timer:

```bash
antseed verifier watch                  # a tick every 10 minutes; --interval <minutes> changes it
antseed verifier watch --once           # one tick, e.g. from cron
```

Every tick runs `verifier run` (your models, plus the confirmations you're responsible for, in up to 3 rounds like a run of your own; what is still left is retried on the next tick) and then `verifier submit --yes`, which sends only the results that aren't on-chain yet. A `DIFF` another auditor submits is picked up by its confirmer within one tick. Each tick continues the epoch, so sellers already finished aren't asked again, and a new epoch starts its own assignment on the next tick. A failed step is logged and retried on the next tick. With `--once` there is no next tick, so `watch` exits non-zero when its `run` or `submit` failed, and cron or your supervisor sees it.

- Signing runs without a terminal. With a keystore (`--keystore` or `verifier.keystore`), set `ANTSEED_KEYSTORE_PASSWORD` or type the password once when `watch` starts. `--keystore` also decides which auditor's models and confirmations are run, unless `--auditor` is given.
- Set `PINATA_JWT` for the evidence, or pass `--no-publish-ipfs`.
- `watch` takes `run`'s tuning options and passes them to every tick's run: `--max-rounds <n>`, `--max-enrollment-requests <n>`, `--no-enroll`, `--ignore-pre-run-checks`, `--allow-probe-reuse` and `--no-confirm`. Without them, each tick uses `run`'s defaults (3 rounds, 2,000 requests per build and round). A build that keeps failing continues on the next tick until its total (`verifier.referenceMaxRequestsPerBuild`, default 3 times the per-round limit), so watch the reference spend.
- Only one `watch` runs per data dir. Run it under systemd, pm2 or tmux to keep it up.

## Running again in the same epoch

Run the same `antseed verifier run` command again; it continues the epoch. It first prints a plan built from the epoch's earlier runs:

- **Finished:** SAME or DIFF. Not asked again.
- **Retry, our side:** a payment channel timed out, the deposit or a probe bank was missing, or the seller had already seen too much of the bank (`BANK_EXHAUSTED`). Retried up to 3 times per epoch. A seller our buyer refuses is not retried, since every attempt would fail the same way. An UNDETERMINED caused on our side is never submitted: it says nothing about the seller's model.
- **Retry, seller or unclear:** the seller was unreachable, sent no answer for 10 minutes or sent bad answers. Retried once per epoch, at least 3 hours after the audit that failed, since a seller's outage (an upstream usage limit, a failing health check) usually lasts hours; audits closer together than that count as one. A retry keeps the answers the seller already gave. An audit that failed on our side doesn't use up the seller's retry.
- **Close call:** a close call whose extra questions couldn't be asked yet.
- **New:** a seller or model not audited yet, or skipped earlier (for example its price was above the reference).

A seller audit runs as long as the seller keeps answering: it stops when no batch is answered for `verifier.auditPeerTimeoutMs` (default 10 minutes), or after `verifier.auditPeerMaxTimeoutMs` in total (default 60 minutes). Slow reasoning models need 30 to 90 seconds per batch, so an audit of 20 batches can take half an hour. Reaching the total limit is our limit, not the seller's fault, so it doesn't use up the seller's retry.

One run does this in rounds: after the first round it retries what is left (failures, close calls waiting for their extra questions) with another probe-bank budget, up to `--max-rounds` rounds (default 3). It stops early when nothing is left, a round makes no progress, or less than 45 minutes of the epoch remain.

The run ends with a table of the whole epoch and the next command. `--fresh` ignores the earlier runs, including close calls waiting for extra questions and an interrupted run, and audits every eligible seller again from the start.

## Running every epoch

A verdict counts for the epoch it was given in and the next one, so run and submit once per epoch, for example from cron:

```bash
antseed verifier run; antseed verifier submit --yes
```

## Rewards

Auditors share the verification part of ANTS emissions by credits: one credit per model audited per epoch by default, or the amount the KBF owner set for that model. Once an epoch has ended, claim with `antseed verifier rewards --claim`; each epoch is claimed in its own transaction.

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
