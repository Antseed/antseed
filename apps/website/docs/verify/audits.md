---
title: How audits run
slug: /verify/audits
description: How KBF audits run — which models each auditor audits, which sellers are audited, how verdicts are decided, where the genuine answers come from, and how results go on-chain.
---

# How audits run

This page covers **KBF audits**, one of the first of many verification methods Antseed is launching, with more to come (see [Model verification](/docs/model-verification#one-method-among-many)). For setup, see [Become a verifier](/docs/verify).

## Running an audit

With the buyer running (`antseed buyer start`), an approved auditor leaves one command running:

```bash
antseed verifier watch                        # every 10 minutes: run, then submit
antseed verifier status                       # optional, from another terminal
```

Each tick of `watch` is a `verifier run` (audit, confirm and retry) followed by `verifier submit --yes` (publish the evidence and put the results on-chain). Keep it running all epoch: other auditors' `DIFF`s reach you at any time and wait 12 hours for your confirmation (see [Keeping a verifier running](#keeping-a-verifier-running)). You can also run the two steps yourself, for example to check a submit first:

```bash
antseed verifier run                          # audit, confirm and retry, all in one run
antseed verifier submit --dry-run             # check before sending
antseed verifier submit --yes                 # publish the evidence and put the results on-chain
```

A manual run confirms only the `DIFF`s already waiting when it starts, so run both again during the epoch, or use `watch --no-submit` and send the results with `submit`. The rest of this page explains what these commands do.

## One audit

1. **Reference banks.** For each model, the auditor asks the genuine model short questions with exact answers. It keeps the ones it answers consistently and that cheaper look-alike models get wrong (see [Reference banks](#reference-banks)).
2. **Questions.** `verifier run` asks every seller of the model the same question set: this epoch's, built fresh for it and never used again (see [Questions for each epoch](#questions-for-each-epoch)). These are normal paid requests, and the seller must sign every response.

   Each model runs in its own lane. Its audits start as soon as its questions are ready, so a model that takes hours to build doesn't hold up the others. Up to `verifier.auditMaxConcurrentModels` models (6 by default) audit at once, and a model that is still building doesn't use up one of those places. When its questions are ready, the model re-reads which sellers your buyer can see. All of this is one `verifier run`, so `verifier submit` gets the results when every model has finished.

   Every test runs on every first audit, in this order: the tokenizer pre-check, thinking discovery, the questions, the cap check and the echo check. A flag never skips a later test: the audit is `DIFF` when any test flags, and its evidence holds every test's result.

   Before anything else, each seller gets the [tokenizer pre-check](#tokenizer-pre-check): two short requests that show whether it counts input tokens like the model. A seller that clearly doesn't is `DIFF`, and is still asked the questions and the other checks.

   Next, before the questions, the auditor works out how to turn off the seller's hidden reasoning ("thinking"), the way the KBF reference code does for every endpoint it checks. It sends a fixed batch of ten easy questions with each setting in turn: `reasoning: {effort: "none"}`, `reasoning: {effort: "minimal"}`, `thinking: {type: "disabled"}`, `enable_thinking: false`, a `<think></think>` prefill, then nothing. It uses the first setting that gets at least 5 answers with no reasoning tokens. If the seller keeps thinking whatever it is sent, its questions go out with 50 times the token budget (40,000 tokens per request), so it has room to think and still answer. This is worked out once per seller and model in each run; the requests and their cost are part of the audit's evidence (`sellerThinking`). Text inside `<think>…</think>` is not read as an answer.

   After the questions comes the [cap check](#cap-check): one request under a small reply limit, with the seller's own thinking setting, shows whether the seller bills beyond the limit it was given. Then the [echo check](#echo-check): the seller repeats a short and a long text, and the output tokens it bills are compared with the model's. A seller that clearly bills more than the model wrote is `DIFF`.
3. **Verdict.** The seller's answers are compared with the genuine ones:

| Verdict | Meaning |
|---|---|
| `SAME` | The seller misses about as often as the genuine model |
| `DIFF` | The seller misses clearly more often: probably a different model. Or it failed the [tokenizer pre-check](#tokenizer-pre-check), or it billed beyond the reply limit it was given ([cap check](#cap-check)), or it billed more output than the model wrote ([echo check](#echo-check)) |
| `UNDETERMINED` | Too few usable answers to decide |

   A missing, empty or unreadable answer is left out of the score, not counted as wrong. A `SAME` needs at least half the questions answered and a `DIFF` at least 80%, so a seller can't make a `DIFF` more likely by dropping answers. There is one exception (rule `kbf-coverage-v1`): a set with at least half but under 80% of its questions answered is `DIFF` when the answers it does give are decisive on their own, with a binomial p-value of at most 1e-6 over at least 50 scored answers. It applies to a close call's sets taken together too. Otherwise, below these bars the result is `UNDETERMINED`. A batch with any answer missing is asked again up to two more times, and the try with the most answers is kept. Answers sent as `<number>X</number>` lines without question numbers are read in order when there is exactly one per question. A seller that refuses `temperature` is asked again without it and judged on those answers; the evidence records the dropped field (`omittedSamplingFields`). A seller that only accepts another `temperature` value is skipped.

4. **Submit.** `verifier submit` publishes the evidence and puts the results on-chain. A `DIFF` is submitted as found: it is one auditor's report, and it counts only once another auditor confirms it with its own audit (see [Confirmations](#confirmations-from-other-auditors)). Auditors don't recheck their own `DIFF`s.

A close call (a first look that is neither clearly `SAME` nor clearly `DIFF`) gets the epoch set's extra questions, the same for every close call, and is decided on the sets together; that is how the auditor reaches any verdict at all, not a second opinion.

Each model is audited once per epoch, in its [audit window](#audit-windows): running `verifier run` again in the same epoch retries the window's failed sellers and asks any close call its extra questions if they couldn't be asked, without repeating its first check, but audits no new seller.

### Tokenizer pre-check

Every model splits text into tokens its own way, and sellers sign the input tokens they bill. So the first thing a seller is asked is not a question but a count.

- **A round is two requests.** The auditor sends a short message A, then A followed by a few sentences B. The difference between the two signed input-token counts is B's length in the tokenizer the seller ran. The chat template and any hidden system prompt are in both requests, so they cancel out.
- **The reference is the genuine model.** The same two requests go to your reference endpoint, on the route and provider your question bank was built on. Its count is read exactly as a seller's is. Each pair is asked twice and must give the same difference both times, from one provider and without cached input that does not cancel (see below). A text the reference refuses or can't count is replaced by a fresh one. A reference that reports cached input on every answer gets no fresh text, since the cache is the endpoint's: a model whose reference always reports cached input that does not cancel gets no pre-check, and its sellers are judged on the other tests. The reference gets ten minutes. Your sellers' audits wait for it, and none of their clocks run meanwhile: a seller's audit starts timing with its first request.
- **The count must be exact.** A seller whose difference is exactly the genuine model's counts like the model. A match costs two requests, and the seller goes on to the questions as usual: the pre-check never gives a `SAME`.
- **A round that is off is asked again.** Only a count the seller repeats is held against it. If its second answer matches the genuine model, it matches. If its two answers differ from each other at all, its hidden input varies from request to request and the pre-check decides nothing.
- **A mismatch is a `DIFF`.** A seller off the genuine model's count in each of three rounds, by any amount, the same way both times (twelve requests), is not counting with the model's tokenizer. It serves another model, or it signs input tokens that are not the model's. Either way the audit is `DIFF` once another seller of the model backs the reference (see below). Its questions and the other tests still run, and its evidence holds the three rounds with the exact responses the seller signed, and the pair each backing seller signed.
- **Cached input cancels only when it is the same.** A pair whose two answers report the same cached amount is kept: the cache is in both counts and cancels out of the difference. A pair whose answers report different cached amounts, or cached input on one answer only, is never held against a seller, and gives the reference no difference.
- **Input that changes with the message is a mismatch too.** A seller that adds retrieved text, a skill or an agent's notes to some messages signs counts that are not the model's, even when the model behind it is genuine. A service listed under an audited model's name passes the buyer's input to that model as it is; anything more is offered under its own name.
- **A mismatch needs another seller of the model on the reference's count.** A reference can agree with itself and still not be the model the sellers serve (a silent update behind the same name, for example). So when a seller is off in every round, the first round's two requests go to the model's other sellers your buyer would audit, whether or not this run audits them. Sellers your buyer would refuse (priced above the reference, under its reputation floor, or without signed responses) are not asked. The mismatch stands only if at least one of them signs the reference's exact count, without cached input that does not cancel. A model with a single seller therefore never gets a pre-check `DIFF`.
- **The model's sellers can outvote the reference.** If two or more sellers sign one same count that is not the reference's, the checked seller included, and they are more than the sellers that sign the reference's, then the reference is not the model they serve, and the pre-check decides nothing for the seller being checked. Each check reads the model's sellers for itself.
- **A seller that can't be measured takes no side.** One that fails, is refused, signs no count or reports cached input that does not cancel neither backs the reference nor votes against it.
- **The model's other sellers get five minutes in all.** If one of them has not answered when the five minutes are up, it could still outvote the reference, so the pre-check decides nothing. The requests to the other sellers are paid and counted with the audit that sent them, also when nothing is decided, and the checked seller's idle clock (the time it may take to answer) doesn't run while they are asked. The audit's total time limit does.
- **Anything unclear decides nothing.** A failed request, a response without usage or with a count of zero, a count for A and B together that is not above the count for A, a count that is off while the response reports cached input that does not cancel (an upstream cache moves with every request), a reference that could not be asked, did not agree with itself, reported cached input that does not cancel or answered from two providers: the pre-check gives no finding, and the seller is judged on the other tests.

The probes are written fresh for every run, on your machine, so they cost nothing and no seller has seen them. A is a short everyday message with details of its own. B is plain prose with numbers, identifiers, names, a rare long word and a sentence in Korean or Japanese. It leaves out what honest inference engines for one model count differently, such as control-token text, accented capitals and newer emoji, so honest sellers of one model count it alike.

What it does not do:

- **Models of one family share a tokenizer.** A seller serving a cheaper sibling of the model matches. Only the questions can catch it.
- **A seller can compute the model's count itself** and sign that. Then the input it bills is at least the model's.

`verifier submit` checks the stored values against each other before it sends a pre-check `DIFF`: the counts against the bytes each seller signed, that each signed request asked the round's own text (the first round's, for a backing seller), the differences, the order the requests were asked in, the backing sellers' pairs and the outcome. It does not verify the signatures again.

A pre-check `DIFF` is submitted, confirmed and held like any other `DIFF`: it counts once another auditor's own pre-check confirms it (see [Confirmations](#confirmations-from-other-auditors)). `verifier.tokenizerPrecheck: false` turns the pre-check off, but every auditor must use the same setting, so `verifier run` then stops unless you pass `--skip-version-check`.

### Cap check

The cap check asks whether a seller bills the output tokens the model wrote under the reply limit it was given. It runs once per first audit, after the questions, with the thinking setting worked out before them, whatever the pre-check found.

- **One request, under a small limit.** The seller is asked to count upward in English words from a random number, on one line, with a reply limit drawn between 16 and 48 tokens and the seller's own thinking setting. An honest answer is long, so an engine that honours the limit stops at it.
- **Billed within the limit is the end of it.** A seller that bills at most the limit plus 2 tokens passes with one request.
- **Billed over the limit, the answer is measured.** The visible answer the seller signed is sent to your reference endpoint, after a short message and without it, twice, exactly as the pre-check measures its text. The difference is the answer's length in the model's tokenizer, measured this epoch.
- **A `DIFF` rests on the answer, not on the usage fields.** Only an answer that measures more than twice the limit counts against the seller, and only if it does so again when the seller is asked a second time. Reasoning a host bills outside the limit and itemises (as some hosts do honestly), billed tokens nobody itemises, and an answer between the limit and twice the limit are shown in the evidence and never decide. Moving the excess into the reasoning count does not hide an answer that is longer than the limit allowed.
- **Anything unclear decides nothing.** A failed request, a response that is not one JSON object, an answer without usage (the buyer then bills its own estimate), several answers, stop sequences, a limit the request no longer carries after translation, or an answer the reference cannot measure: the cap check gives no finding.
- **It applies to a model only when the model's own host keeps the limit.** Once per run and model, your reference endpoint gets the same capped request at the lowest limit a seller can be given. The check applies only when it bills within the limit (or its answer measures at most twice the limit) and its answer, measured the same way, is what it billed for it. A model whose reference cannot be measured (it reports cached input every time, or no usage, or its route may serve several providers and names none), or whose own host does not keep the limit, is not cap-checked that run, and its sellers are not asked.
- **For a dry pass.** With `ANTSEED_VERIFIER_CAP_MEASURE_WITHIN=1`, `verifier run` also measures answers that kept to the limit, so billed and measured lengths can be compared for honest sellers. It costs reference requests, changes no result, and the run log says when it is on. Leave it off for audits that are submitted.

A cap check `DIFF` means the seller ignored the limit the buyer set and billed what it delivered beyond it. It says nothing about which model the seller serves. It is submitted, confirmed and held like any other `DIFF`, and counts once another auditor's own cap check flags the seller too. `verifier submit` recomputes every reading and class from the bytes the seller signed before it sends one. `verifier.outputChecks: false` turns the check off, but every auditor must use the same setting.

### Echo check

The echo check asks whether a seller bills the output tokens the model wrote. It runs after the cap check, once per first audit, and only for models whose reference repeats text cleanly this run.

- **Three rounds of a short and a long text.** The texts are written fresh for every run on your machine, like the pre-check's. The seller is asked to repeat each one exactly, with its own thinking setting. Your reference endpoint repeats the same texts twice each and must agree with itself, from one provider; the long text must measure at least 150 tokens more than the short one, and the largest of the three rounds' gaps must be at least 4/3 of the smallest, or the check does not apply this run.
- **What is compared is the growth.** For each round: how much more the seller bills than the model on the long text, minus how much more on the short text. A host that adds the same few tokens to every reply cancels out, so it is never held against the seller. A round whose growth is above 2 tokens is asked again, and counts only when the seller repeats it.
- **Only an exact echo counts.** A reply must be the text byte for byte, finished on its own, with usage the seller signed. In a model whose reference shows no reasoning, a reply that shows any reasoning is not used. For a model whose reference itemises reasoning on every reply, the count is billed minus itemised reasoning, the seller must itemise too and repeat its own count within 2 tokens, and each round's margin grows by the largest reasoning it shows: the check then covers the visible answer only.
- **A `DIFF` needs a wide margin and the model's other sellers.** The seller's growth must be above 20 tokens and above 10% of the gap between the two texts, in every round, twice. The first round's two texts then go to the model's other sellers your buyer would audit: at least three must answer, at least two must sign the model's own count, none may sign the same growth (that would be a shared relay, not this seller), and the seller's growth must stand more than three times their spread above their median and above any reasoning seen on these texts. The growth must also be steady as a share of each round's gap; the three long texts are written at different lengths, so a few tokens added to long replies only are not taken for over-billing by a factor. The seller's own pre-check must have matched. The 20 tokens, the 10% and the three times are margins chosen above every honest value seen, not measured bounds.
- **A fixed amount per reply** is judged the same way: the same amount, within 2 tokens, on every text asked twice, more than 20 tokens above what the other sellers add, standing out by the same margins, and shared by none of them.
- **Not counted yet.** A fixed amount per reply, and any finding on a model counted on its visible answer, are computed, stored and shown in the evidence, but give no `DIFF` and clear none: no data on live sellers is behind them yet. The growth on a model whose reference shows no reasoning counts.
- **Anything unclear decides nothing.** A failed request, a changed or cut echo, reasoning where none is expected, a round that does not repeat, a repeat that cannot be read, too few other sellers, or one that has not answered within five minutes. When the audit's time runs out, a finding already decided before the extra requests and the other sellers' replies stands; anything still open is stored as stopped. Work for a fixed amount alone runs off the seller's clock and is set aside when it would cut into the time the questions need.

An echo check `DIFF` means the seller bills more output than the model wrote. Like the cap check, it says nothing about which model the seller serves, and counts once another auditor's own echo check flags the seller the same way. `verifier submit` recomputes every count from the bytes the seller and the other sellers signed; the reference's own counts are your endpoint's measurement and are taken as stored, as for the pre-check. `verifier.outputChecks: false` turns the cap check and the echo check off together.

### Following a run

`antseed verifier status` shows a running audit from another terminal. When a run finishes it prints its run ID, an HTML report per model and the epoch overview.

### The epoch overview

`verifier run` and `verifier submit` write `<data-dir>/verifier/evidence/epochs/<epoch>/overview.html`. It shows every seller × model from all of the epoch's runs, merged in the order they are submitted, so a later verdict replaces an earlier one, as on-chain. Hover a yellow (`UNDETERMINED`) or grey (tried, not submitted) dot for the reason, in the same words as [AntScan](https://antscan.co), plus the match rate of the check (and of a close call's extra questions). `antseed verifier overview [--epoch <n>] [--run <ids...>]` rebuilds it, optionally from only some runs.

## Which models you audit

The audited models are built into the CLI, the same for every auditor (`antseed verifier models` lists them). Every model is audited every epoch: the models are split across the approved auditors, round robin, and `verifier run` audits your share. Until you are approved you have no share: `verifier run --all` or `verifier run <model>` tries an audit you can't submit.

- Each model has exactly one auditor per epoch, and auditors get the same number of models, give or take one.
- The split moves every epoch, so with two or more auditors you never audit the same model two epochs in a row, and over as many epochs as there are auditors you audit every model once.
- Auditors and models are sorted (by address and by name), so everyone works out the same split. The approved auditors are the ones approved when the epoch started; anyone approved later joins from the next epoch.

`antseed verifier assignment` shows every auditor's models (`--epochs 4` for the next few, previewed with the auditors approved so far). `verifier run <model>` or `--all` still audits any model.

Each model also has a **confirmer** each epoch: the next auditor in the same rotation. A `DIFF` needs a second auditor (see [Confirmations](#confirmations-from-other-auditors)), and the confirmer audits the sellers whose `DIFF` waits for it. With two auditors, each one confirms the other's `DIFF`s, and the roles swap every epoch. `antseed verifier assignment` shows both: the models each auditor audits, and the models it confirms `DIFF`s on. This confirmation replaces a recheck by the same auditor: nobody rechecks their own `DIFF`.

The assignment is not enforced on-chain: the contract records any approved auditor's audit of any model. Two things follow:

- If an auditor doesn't run, its models are handed to another auditor halfway through the epoch (see [If an auditor goes missing](#if-an-auditor-goes-missing)). Until then, earlier verdicts still count: a verdict lasts the epoch it was given in and the next one.
- Each seller gets one audit per model and epoch and, when that audit is a `DIFF`, one confirmation. `verifier run` does not audit a seller another auditor has already judged this epoch, and `verifier submit` leaves such a result out (it says why), unless it confirms a `DIFF` whose confirmer you are right now: a confirmation the run made while it was your turn is left out once your 12 hours are over and the next auditor is asked. `submit` checks this again right before each transaction, on the chain as it is then, so a report another auditor sent in the meantime also holds the model back; the next `submit` prepares it again without that seller. A revoked auditor's reports no longer count, so they are no opinion: after a revocation, a `DIFF` that waits gets exactly one more confirmer. So a manual `verifier run <model>` on a model outside your share audits nothing that is already judged, a returning auditor whose model a stand-in already audited sends nothing for it, and no third opinion ever reaches the contract (the contract itself would accept one, and a single later `SAME` would clear a confirmed `DIFF`).

### If an auditor goes missing

Every model is audited every epoch only if every auditor runs. So `verifier run` also stands in for auditors that don't. Halfway through the epoch, a model with no audit that counts yet goes to the next auditor in the model's rotation, the same order the confirmer comes from; from three quarters on, to the one after that, in case the first stand-in is gone too. An audit counts when at least 20% of its sellers got a `SAME` or `DIFF`, so an audit that learned nothing, for example because every seller throttled a new buyer, doesn't stop the model from being handed over. Only auditors with an audit that counts this epoch are stand-ins, so a model is never handed to another absent auditor. A revoked auditor is never a stand-in or a confirmer, and its models are handed over straight away instead of waiting for halfway. The stand-in audits the model like one of its own, on its own questions and every seller that advertises it, and the contract credits it like any other audit. The absent auditor's run, if it comes late, sends nothing for the sellers the stand-in already judged: a seller gets no second opinion on a `SAME` (see below).

If the owner removes your address mid-epoch, the contract refuses everything you submit from then on. `verifier run` notices: it reads your approval at the start of every tick and again before each question build and each seller audit, starts nothing new once you are removed, and says so. Results you had not submitted yet cannot be sent. `verifier watch` can stay up; it audits nothing while your address is not approved. If the approval cannot be read (an RPC problem), the run goes on.

Nothing is coordinated: each auditor works the stand-ins out from what is on-chain (the approved auditors, this epoch's `ModelAudited` and `ServiceAudited` events, and the chain's clock), so every auditor reaches the same answer. `antseed verifier assignment` shows them in a **Stands in for** column for the current epoch, and `verifier run` prints `Stand-in: <model>: standing in for <auditor>` before it starts. Stand-ins are off-chain only; nothing changes for the contract.

Auditors on different CLI versions can have different model lists, and so different splits. `verifier run` and `verifier assignment` print a hash of the model list to compare.

## Which sellers are audited

Every seller your buyer has found that offers the model. A seller is skipped when:

| Skip code | Reason |
|---|---|
| `missing_response_auth` | It doesn't sign its responses |
| `reputation_below_minimum` | Its trust score is below `buyer.minPeerReputation` |
| `price_above_reference` | It charges more than the model's upstream price |
| `policy_rejected` | Its price for the model couldn't be read, or your buyer would refuse it (for example cached input priced above input) |

### After a DIFF

A seller whose service got a recorded `DIFF` isn't audited in the next epoch, except to confirm another auditor's repeat `DIFF` (`verifier.diffHoldEpochs`, default 1). A `DIFF` recorded in epoch N stands through N+1, and the seller is audited again in N+2. The contract lets a single `SAME` replace a recorded `DIFF`, so without this hold a seller could switch back to the genuine model for one audit and lose its `DIFF` straight away.

`verifier run` lists each held seller and the epoch it's audited again:

```
glm-5.3: agent 12 (glm-5.3, peer <peerId>…) held: its DIFF from epoch 30 stands until epoch 32, so the seller is not audited or cleared before then
```

`verifier submit` leaves out any `SAME` or `UNDETERMINED` it still has for a held service, with the same reason. A repeat `DIFF` clears nothing, so it's sent. The hold reads the service's recorded verdict, whatever model it was recorded under, so a seller can't lift it by offering another model under the same service name. It ends early only when the owner clears the result.

### Your buyer's price cap

Audit requests go through your running buyer, which refuses sellers above its own `buyer.maxPricing`. Before sending anything, `verifier run` checks that the running buyer's caps are at or above every audited model's reference price. They don't have to match it. If one is lower, the run stops:

```
the running buyer would refuse sellers priced at or below the reference:
  - claude-fable-5.1: the buyer price cap is below its reference price (input $5 < $10, output $30 < $50, cached input $5 < $10 per 1M)
Set buyer.maxPricing.defaults to at least input $10, output $50 (and cachedInputUsdPerMillion, if set, to at least the input value) and restart the buyer.
```

The check reads the cap the running buyer reports, so a config change only counts after you restart it. A buyer set up for another app, such as a desktop buyer, may have a much lower cap than an audit needs.

:::warning A high cap applies to everything sent through that buyer
Raising the cap doesn't raise what an audit pays, because a seller above the model's reference price is skipped before any request. Other traffic through the same buyer can pay up to the cap, so keep a high-cap buyer for audits only.
:::

### Checks before the run

Before sending anything, `verifier run` stops with a list of problems and how to fix each when:

- the chain can't be reached, so the run could not be submitted;
- your buyer deposit can't cover a payment channel for every seller you don't have one with yet (each reserves `payments.maxReserveAmountUsdc`, $1 by default).

Each model is then checked on its own, once its questions are ready. A model isn't audited when:

- its bank for the epoch can't be loaded (move `<banks>/<model>/epochs/<epoch>` aside and run again to build a new one);
- it has no usable question set for this epoch. With `--no-enroll` this means the set is missing; by default the run builds it, see [Questions for each epoch](#questions-for-each-epoch).

The other models carry on. The run lists the models it didn't audit, with the reason, and exits with an error.

To run anyway, add `--ignore-pre-run-checks`: the problems are printed as warnings. Audits that fail because of them can come back `UNDETERMINED`.

### Up-to-date CLI

All auditors must audit the same models in the same way, or the round-robin split and the results don't line up. Each CLI release carries a **verifier compat** number (`antseedVerifier.compat` in its `package.json`), which goes up only when a release changes how audits work: which models are audited, how they are split between auditors, who confirms a DIFF or stands in for an absent auditor, how questions are chosen and which sellers get a result, how sellers are scored and judged, or how reference banks are built and sized. `verifier run` and `verifier submit` first read the compat of the latest `@antseed/cli` on npm, the version `antseed update` installs:

- **Higher than yours:** the command stops before sending anything.

  ```
  the latest @antseed/cli 0.1.240 changed how audits work (verifier compat 2; this CLI 0.1.231 has 1). Update with `antseed update` …
  ```

- **The same:** a newer release only prints that an update is available, and the command, or `verifier watch`, carries on. Releases from before verifier compat have none and count as 0, so they never stop a CLI that has one.

If the npm registry can't be reached, `verifier run` warns and continues, and `verifier submit` stops (`submit --dry-run` only warns). `--skip-version-check` skips the check on both.

A CI test pins a hash of the audit rules for each compat number: the model list, the split, the thresholds, the domain table, the prompt variants, the calibration and layout filter settings, and sample verdicts, parsed replies and scored answers. A change to those without a bump fails the build. A change to the audit code that none of the samples reaches still needs a manual bump.

Eight local settings change the rules, so `verifier run` stops when they differ from their defaults: `verifier.closeCallExtensions` (2), `verifier.diffHoldEpochs` (1), `verifier.referenceSelfTestRuns` (3), `verifier.referenceLayoutFilterPasses` (2), and the question set sizing `verifier.referenceMinimumProbeCount` (100), `verifier.referenceMaximumProbeCount` (500), `verifier.referenceProbeStep` (10) and `verifier.referenceMinimumStatisticalPower` (0.9). Remove them from your config, or pass `--skip-version-check` for a test.

### Price limit

The auditor doesn't pay a seller more than the most any OpenRouter provider charges for the model. Input and output each take the highest price across OpenRouter's providers for the model, leaving out speed tiers (`fast`, `ultrafast`, `flex`), which are the same model at a different speed and price. If the model's reference upstream or `verifier.models.<model>.pricing` is higher, that is used instead. If OpenRouter lists no providers for the model, the reference upstream, `verifier.models.<model>.pricing` or the OpenRouter catalog price is used. A seller priced above it is skipped:

```
priced $17/$85 per 1M, above the claude-fable-5.1 reference $10/$50 · not audited
```

`verifier.auditPriceRatio` (default 1) lets you audit sellers that charge somewhat more, for example `1.1` for up to 10% more.

## Reference banks

A model's bank holds the questions and the genuine model's answers. Each epoch has its own bank per model (`<data-dir>/verifier/banks/<model>/epochs/<epoch>/bank.json`), and seller audits never call the reference API: sellers are compared with the answers stored in the bank.

`verifier run` builds banks on its own, before it asks any seller:

- **No question set for this epoch yet:** it builds new questions and adds them to the epoch's bank until they make the epoch's set (see below), up to 4 builds per model and run. The epoch's first build makes its bank.
- **This epoch's set is ready and calibrated:** no reference calls. A set that isn't calibrated yet is calibrated first (see below).

### Questions for each epoch

Each auditor uses one question set per model and epoch (`<banks>/<model>/epochs/<epoch>/set.json`, selection method `epoch-shared-set-v1`):

- **The same for every seller:** every seller of the model gets the same questions in the same order, and every close call the same extra sets. A confirming auditor uses its own set, so two auditors' audits stay independent.
- **Built for the epoch:** the first run of a model in an epoch builds the set, then audits. Only questions built into that epoch's bank can be in it. Earlier epochs' questions are not checked for repeats: new questions rarely repeat an old one.
- **Settings of the epoch:** the epoch's first build takes its settings from your config and the CLI's built-ins as they are then: provider pin, contrast models, thinking suppression, layout filter and request timeout. Later builds, the calibration, close calls and confirmations of that epoch keep them, so the whole epoch is measured one way. A setting changed during an epoch applies from the next one.
- **Used once:** after its epoch, a set's questions, including extra questions nobody needed, are never asked again. Its evidence is published when its results are submitted.
- **Retired when published:** `verifier submit` publishes a model's evidence with every question the bank holds for the epoch, so right before the upload it retires the model's set and its unused questions (`set.published-<n>.json`, `pool.published-<n>.json`). A later confirmation or audit of that model in the same epoch gets a new set, built from new questions. A retry of an audit made on the retired set starts again on the new set. A close call made on it gets no extra questions. If it confirms another auditor's `DIFF`, it counts as an undecided confirmation attempt: it is not submitted, and the seller is audited again from the start on the new set, up to the usual 3 attempts. Any other such close call is finished undecided and submitted as `UNDETERMINED`, and no new set is built for it. While a `verifier run` of the same data dir is going on, `verifier submit` publishes nothing of any model and says so; the next submit sends it. Once the chain has moved to the next epoch, `verifier submit` publishes nothing more of the epoch before.
- **Sized like any reference:** the audit set is the smallest that has the statistical power and detects every testable contrast model. Each of the two extra sets is as large as the audit set, so a set needs about three times the audit set's questions.

- **Calibrated before use:** before any seller is asked, the auditor asks the genuine model the audit set and both extra sets once, in the same batches sellers get: one domain per request, up to ten questions, temperature 0, under the same rules for cut-off and incomplete replies. How often it misses its own stored answers here is the limit sellers are judged against, so the limit is measured on what is audited, minutes before the audit. The trials and the batches are stored on each reference (`calibration`), and the raw requests and replies are published with the bank's evidence. The questions' earlier self-test stays in the bank and is used for sizing.

If the genuine model answers under 80% of any set, **the model isn't audited that epoch**. If it misses more than the 99% limit of the sets' self-test, the run prints a warning and goes on: the seller's limit comes from these trials anyway. Sets are sized to reach the required power on a calibration with the self-test's miss rate, and the power is then checked on the calibration as measured. When the genuine model missed more there and the audit set falls short, the set grows to the size that miss rate needs: the audit set keeps its questions, both extra sets grow to match it, and more questions are built if the epoch's aren't enough. It is then calibrated again in its new batches, and no seller is asked it until it passes. A run calibrates a model's set at most three times; a set still short goes on in the next run. When no set of up to 500 questions would reach the power, **the model isn't audited that epoch**.

Every epoch therefore needs a new build per model, thinking discovery included. The cost is in the epoch bank's `referenceCosts` and in each build's log line.

Before the self-test, a bank's new questions go through a **layout filter**: the unchecked pool is asked again in shuffled single-domain batches of up to ten, with audit prompt variants at temperature 0, twice by default, and any question whose answer moves in either pass is dropped. A question that only holds up next to the questions it was generated with would just add noise to the limit without telling models apart.

An epoch's bank built by an earlier reference builder can't be used or extended: move its epoch folder aside and let `verifier run` build a new one.

Shared banks from earlier releases (one `<banks>/<model>/bank.json` for every epoch) and the question sets built on them are no longer read: such an epoch is not audited, resumed or submitted, and the files can be moved aside.

A bank is built to tell the genuine model from a few **contrast models**: cheaper look-alikes a seller might serve instead. Each audited model has its own list built into the CLI, so every verifier's new banks are built against the same reviewed set. Every contrast is cheaper than the model it is listed for, as a substituting seller's model would be, and is one the audits' banks already use, never a `:free` model. `antseed verifier models` shows each model's contrasts and where they come from:

- **config:** `verifier.models.<model>.contrastModels`, up to `contrastSelection.maxModels` (3) OpenRouter ids. It replaces the built-in list.
- **built-in:** the CLI's list.
- **automatic:** only when neither is set, or with a manual `referenceEndpoint.contrastModelBank`: the highest-ranked catalog models priced at most 30% of the target (`contrastSelection.maxPriceRatio`), up to 3, never `:free`.

A bank keeps the contrasts it was built with, so a changed list applies from the next epoch's bank.

Each build is billed by the reference API and stops once the bank is ready, or after 2,000 requests in a round (`--max-enrollment-requests` changes it). A build that runs out continues from where it stopped in the next round or run, up to `verifier.referenceMaxRequestsPerBuild` requests in total (default: 3 times the per-round limit). The limit is per build, not per model: one model can need several builds for its epoch set. Building grows the epoch's bank and never replaces it. `--no-enroll` turns this off: a model with no set for the epoch is then not audited, and the run audits the others and exits with an error.

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

`antseed verifier models` shows where each model's answers come from. Use a source you trust to serve the real model: if it doesn't, every audit built on it is wrong. A bank keeps one source, so a changed source applies from the next epoch's bank.

On OpenRouter, each model is pinned to one provider (`referenceProvider`, or the CLI's built-in pin). Before an epoch's first build, the auditor reads which providers OpenRouter lists for the model and leaves out the pinned ones it no longer lists. When none is left, it pins one listed provider instead, the same one on every auditor: the first by tag of those with the pin's quantization (an `fp8` one for an `fp8` pin), else the first of all, never a speed tier. The run log names the pin it dropped and the one it used, and the epoch's references record the pin they were built with. If the list can't be read, the pin stays as it is.

## Getting approved

Submitting needs an **approved auditor address**. Ask in the [Antseed Telegram community](https://t.me/antseed) with the address you will submit from.

- By default this is the data-dir identity (`antseed buyer status` shows it). To sign with a keystore instead, set `verifier.keystore`.
- It needs a little ETH on Base for the transactions.
- It can't audit sellers it owns.

### Adding and removing auditors

For the contract owner, and for anyone running several auditors:

- **Approve a new auditor at least 72 hours before the epoch it should start in.** An auditor approved during an epoch joins the split from the next one. Sellers may limit buyers that are new to them, by default for 72 hours after their first payment channel (the seller's `buyerLimits.newBuyers`, see [Buyer limits](/docs/provide/config#buyer-limits)), so a brand-new buyer's first audits can end `UNDETERMINED` for sellers that throttle it. Have the new auditor start its buyer, fund it and try an audit (`verifier run --all`) before its first epoch.
- **Give every auditor its own data dir, buyer and reference key.** Each auditor pays sellers through the buyer in its own data dir (see [Become a verifier](/docs/verify/)), and its question sets are built with the API key its `verifier.referenceEndpoint` names (`apiKeyEnv`). Two auditors sharing a buyer look like one buyer to sellers and share its limits; two sharing a key share its rate limits and spend.
- **Give every auditor a keyed RPC of its own.** `verifier run` and `submit` read the contract's events every tick; public Base RPCs rate-limit and refuse wide log queries. Set `payments.crypto.rpcUrl` to a keyed endpoint and add `fallbackRpcUrls`.
- **Remove an auditor at an epoch boundary, not mid-epoch.** A revocation restarts every report still waiting for a second auditor, from every auditor, so the `DIFF`s waiting at that moment have to be audited and confirmed again. Right after an epoch starts, few reports are waiting. A removal mid-epoch still works: the removed auditor's `verifier run` stops paying (see [If an auditor goes missing](#if-an-auditor-goes-missing)), and its models are handed over at once.
- **Run the same CLI release on every auditor.** Auditors on different releases can split the models differently or disagree on who confirms. When a release raises the verifier compat (see [Up-to-date CLI](#up-to-date-cli)), run `antseed verifier submit` on every auditor before it is published and `antseed update` on every auditor right after, and don't rebuild or update one auditor on its own in the middle of an epoch.

## Submitting

```bash
antseed verifier submit --dry-run
export PINATA_JWT=…
antseed verifier submit --yes
```

`submit` sends the whole current epoch: every run of the epoch, merged, with the latest result per model and seller. `--run-id <id>` sends one run instead. The dry run checks everything, including your approval, and leaves what it would send in `submission/dry-run-prepared.json` in the epoch's evidence folder: each row with its decision and, for a row it leaves out, a reason code. A real `submit` never writes that file. `--dry-run --auditor <address>` previews for that auditor without a keystore or signer, as nothing is signed. `submit` makes the evidence public on IPFS, which needs `PINATA_JWT`; `--no-publish-ipfs` submits without publishing it. Audits can only be submitted in the epoch they ran in, and re-running `submit` is safe.

`submit` only sends what changes your position on-chain: your first result for a seller service this epoch (including a confirmation of another auditor's report) and a result whose verdict changed. A result you already reported this epoch is left out, and the evidence lists only the results that are sent, so its result count matches the transaction. A model with nothing new is skipped (`claude-opus-5.5: nothing new to submit (23 already on-chain)`), and the preview's **On-chain** column counts what was left out. Two cases are sent again: a report that stopped counting because an auditor was revoked, and a fresh audit after the seller's verdict moved into or out of `DIFF`. A result audited before that change is not, because the contract only counts support given after it (see below). A retry after a failed transaction sends the same evidence again.

`submit` waits up to 10 minutes for each transaction to be mined. A transaction still pending after that is left to mine; `submit` says so and leaves the remaining models for the next `submit` or `watch` tick. While any transaction from your address is still pending, `submit` sends nothing: it can't yet see whether that transaction carried the same audit, so sending again could send it twice. The next `submit` or `watch` tick checks again and records the audit once it is mined. If the RPC can't say whether a transaction is pending, or whether an audit is already on-chain, `submit` also sends nothing that time. A transaction that stays stuck (sent by `submit` or any other tool using the same address) blocks every `submit` until it is mined or dropped: replace it by sending 0 ETH to your own address on the same nonce (`cast nonce --block latest <address>`) with a higher fee. Only one `submit` runs per data dir at a time; a second one sends nothing and says so.

Results not submitted before the epoch ends are lost: the contract only takes them in the epoch they were audited in. The first `submit` of the next epoch says so once (`Epoch 41 ended with results that may never have reached the chain …`), naming what the epoch's last `submit` did not send (a failed or held model, an audit window still open, a close call still waiting for its extra questions) and the runs no complete `submit` covered. Keep `verifier watch` running through the end of an epoch, or run `verifier submit` before it ends.

## Confirmations from other auditors

Each result is a report. The contract records it as the seller service's verdict once enough different approved auditors report the same result for the same seller service and model in the same epoch:

| Result | Auditors needed |
|---|---|
| `SAME` | 1 |
| `DIFF` | 2 |
| `UNDETERMINED` | 1 |
| `SAME` or `UNDETERMINED` replacing a `DIFF` that still counts | `diffReplacementReports`: 1 by default |

So one auditor's `SAME` verifies a seller right away, and one auditor alone cannot mark a seller `DIFF`. Clearing a recorded `DIFF` takes at least `diffReplacementReports` reports of the new result, which is 1 by default (and on Base mainnet): one auditor's `SAME` or `UNDETERMINED` clears it. The owner can raise it, e.g. to 2, so one auditor alone cannot clear a `DIFF` two auditors agreed on. Only reports made after a `DIFF` was confirmed count toward clearing it, and only reports made after it was cleared count toward giving it again. While a `DIFF` waits for its second auditor, the seller keeps its current verdict. Reports count only in the epoch they were made in; a recorded verdict counts for that epoch and the next, like every verdict. Your own report never confirms itself: submitting the same result again adds nothing. When an auditor is revoked, every report still waiting for a second auditor starts over, so a revoked auditor's report never counts; verdicts already recorded stay. The contract owner can change the numbers.

A `DIFF` is recorded only when two auditors flag the seller with the same check: the token-count pre-check, the cap check, the echo check (its growth, or its fixed amount) or the questions.

- **The confirmer knows the check before it audits.** `verifier run` reads which check flagged in the first auditor's published evidence, checked against the hash that auditor submitted, and runs that check to its end: a flag by another check does not stop the confirmation early. A confirmation whose first evidence cannot be read waits for the next run.
- **Fresh material.** A confirmation is an audit whose first request came at least an hour after the report it answers, by your clock against the chain's: the first question batch it sent, or for a check before the questions the first answer your buyer received. An audit that started too early, or reused questions asked before then, is audited again later. The seller's own signed times are never used, so a seller can't make its audits look stale.
- **What is sent.** A `DIFF` by the same check is sent, and the contract records it. When only another check flags, nothing is sent: the seller keeps its record, and the new finding is a first flag the next time the seller is audited. A `SAME` is sent only when the check that flagged first passed; when it was inconclusive or did not run, nothing is sent either. `verifier submit` decides this again right before each transaction, on the chain as it is then.
- **A `DIFF` needs published evidence.** A confirmer can only read a `DIFF` whose evidence is on IPFS, so `verifier submit --no-publish-ipfs` sends no `DIFF` and says why.

`verifier run` confirms automatically. Before it plans the run, it reads this epoch's reports that still need another auditor, and audits the sellers whose turn is its own. A seller gets at most two opinions per model and epoch, and one auditor is asked at a time: the model's confirmer has 12 hours from the first report to answer, and if it doesn't, the next auditor in the rotation who hasn't reported is asked instead, then the next, so a `DIFF` whose confirmer is absent is still confirmed or cleared by someone. If two auditors disagree, nobody else is asked this epoch and the seller keeps the `SAME`; `verifier run` lists it as disputed, and so does [the epoch overview](#the-epoch-overview) written by `verifier run` and `verifier submit`. A confirmer never sends `UNDETERMINED`: if it cannot decide, the next auditor in the rotation is asked once its 12 hours are over. The time is read from the chain, not the auditor's clock, so every auditor works out the same turn. This includes models outside your share: a model you have no bank for gets one built first, the same way as for your own models. Your audit is a normal audit on your own questions. It can confirm the report or disagree with it, and either way it earns credit like any other audit. `--no-confirm` skips these sellers, and `verifier run <model>` confirms only that model's reports. If your audit of a `DIFF` waiting for you ends `UNDETERMINED`, because the seller failed (unreachable, too slow, bad answers) or the check to repeat did not decide, it isn't submitted: an `UNDETERMINED` would replace the seller's record on one unconfirmed finding. The seller is audited again at least 10 minutes later, up to 3 attempts in the epoch; if none decides, nothing is sent and the waiting `DIFF` lapses with the epoch. `submit` lists such a seller as held. A close call that stays undecided after its extra questions is not sent either. Confirmations you can't audit now (the seller no longer advertises the service, or is skipped) stay waiting, and `verifier run` says why. With fewer approved auditors than a `DIFF` needs, no `DIFF` can be recorded; `verifier run` warns about it.

After a submission, `submit` lists for each model how many of your results are recorded and which still wait for another auditor (for example `agent 1234: DIFF 1/2`).

## Keeping a verifier running

`antseed verifier watch` does the run and the submit for you, on a timer:

```bash
antseed verifier watch                  # a tick every 10 minutes; --interval <minutes> changes it
antseed verifier watch --once           # one tick, e.g. from cron
antseed verifier watch --no-submit      # audit only; send the results yourself with verifier submit
```

Every tick runs `verifier run` (your models, plus the confirmations you're responsible for, in up to 3 rounds like a run of your own; what is still left is retried on the next tick) and then `verifier submit --yes`, which sends only the results that aren't on-chain yet. A `DIFF` another auditor submits is picked up by its confirmer within one tick. Each tick continues the epoch, so sellers already finished aren't asked again, and a new epoch starts its own assignment on the next tick. A failed step is logged and retried on the next tick. When the epoch ends before the next tick, `watch` waits only until just after it ends, so the new epoch's audits start right away. With less than 45 minutes left in an epoch, a tick opens no new [audit window](#audit-windows). With `--once` there is no next tick, so `watch` exits non-zero when its `run` or `submit` failed, and cron or your supervisor sees it.

- Signing runs without a terminal. With a keystore (`--keystore` or `verifier.keystore`), set `ANTSEED_KEYSTORE_PASSWORD` or type the password once when `watch` starts. `watch` unlocks the keystore right away, so a wrong password, or a keystore that signs as another address than `--auditor` or `verifier.auditor`, stops it before the first run instead of at the first submit. `--keystore` also decides which auditor's models and confirmations are run, unless `--auditor` is given.
- `--no-submit` keeps the auditing, retries and confirmations going without signing anything: every tick runs only `verifier run`, nothing is signed, published or sent, and no keystore is unlocked or password asked. The results wait in the evidence folder until you run `antseed verifier submit`, in the same epoch: results not submitted before the epoch ends are lost. The auditor comes from `--auditor` or `verifier.auditor`, or the address a `verifier.keystore` records; `watch` stops at once if the only way to learn it is unlocking a keystore (`--keystore` without `--auditor`, or a `verifier.keystore` that doesn't record its address and no `verifier.auditor`). With `--once --no-submit`, `watch` runs one `run` and exits with its result.
- Set `PINATA_JWT` for the evidence, or pass `--no-publish-ipfs`.
- `watch` takes `run`'s tuning options and passes them to every tick's run: `--max-rounds <n>`, `--max-enrollment-requests <n>`, `--no-enroll`, `--ignore-pre-run-checks` and `--no-confirm`. Without them, each tick uses `run`'s defaults (3 rounds, 2,000 requests per build and round). A build that keeps failing continues on the next tick until its total (`verifier.referenceMaxRequestsPerBuild`, default 3 times the per-round limit), so watch the reference spend.
- Only one `watch` runs per data dir. Run it under systemd, pm2 or tmux to keep it up.
- If the chain can't be read when a tick starts (a short RPC outage), the tick audits nothing, says so, and the next tick tries again. Nothing is lost. If it keeps happening, check `payments.crypto.rpcUrl` and add `payments.crypto.fallbackRpcUrls`.

## Running again in the same epoch

Every `watch` tick does this. By hand, run the same `antseed verifier run` command again; it continues the epoch. It first prints a plan built from the epoch's earlier runs:

- **Finished:** SAME or DIFF. Not asked again.
- **Retry, our side:** a payment channel timed out, or the deposit or the epoch's question set was missing. Retried up to 3 times per epoch. A seller our buyer refuses is not retried, since every attempt would fail the same way. An UNDETERMINED caused on our side is never submitted: it says nothing about the seller's model.
- **Retry, seller or unclear:** the seller was unreachable, sent no answer for 10 minutes or sent bad answers. Retried once per epoch, at least 30 minutes after the audit that failed, so a short outage doesn't use up the retry; audits closer together than that count as one. A longer outage (an upstream usage limit, a failing health check) can still fail the retry, and the seller then stays `UNDETERMINED` for the epoch. A retry keeps the answers the seller already gave. An audit that failed on our side doesn't use up the seller's retry.
- **Close call:** a close call whose extra questions couldn't be asked yet.
- **New:** a model not audited yet this epoch. Its first run opens its audit window.

A seller audit runs as long as the seller keeps answering: it stops when no batch is answered for `verifier.auditPeerTimeoutMs` (default 10 minutes), or after `verifier.auditPeerMaxTimeoutMs` in total (default 60 minutes). Slow reasoning models need 30 to 90 seconds per batch, so an audit of 20 batches can take half an hour. Reaching the total limit is our limit, not the seller's fault, so it doesn't use up the seller's retry.

One run does this in rounds: after the first round it retries what is left (failures, close calls waiting for their extra questions) with another probe-bank budget, up to `--max-rounds` rounds (default 3). It stops early when nothing is left, a round makes no progress, or less than 45 minutes of the epoch remain.

The run ends with a table of the whole epoch and the next command. `--fresh` ignores the earlier runs, including close calls waiting for extra questions and an interrupted run, and audits an open window's sellers again from the start. A closed window stays closed, and `verifier run` says so: its results were submitted with the epoch's questions for the model, so a seller could look up the answers. The model is audited again next epoch.

### Audit windows

Each auditor audits each of its models once per epoch:

1. **Opens:** the model's first run of the epoch builds its question set, then audits every eligible seller it finds. Those sellers are the window's; the list is in `<evidence>/epochs/<epoch>/windows/<model>.json`. No window opens with less than 45 minutes left in the epoch, also when a build or a wait for an audit slot runs into that time: the model stops, without an error, and waits for the next epoch. Its confirmations are still audited.
2. **Retries:** later runs (or `watch` ticks) only finish the window's sellers: the retries above, at their spacing, and close calls' extra questions. Nothing of the model is submitted while the window is open, so the epoch's questions aren't published while sellers are still being asked them.

   A seller that stops listing the model doesn't hold the window. Once its retry is due and a run's peer list from the buyer shows it no longer offers the model, the retry is given up: the seller keeps the result it has, and the decision is logged, written to `<evidence>/epochs/<epoch>/retry-give-ups.json` and to the epoch's events (`retry-given-up`), and named in the window file (`givenUpSellers`). If the seller is listed again before the window closes, it's audited as normal. A run that can't read the peer list, or whose list is out of date, gives nothing up. A close call waiting for its extra questions and a retry on our side are treated the same way, once the same spacing has passed.
3. **Closes:** once none of its sellers has anything left, or with less than 45 minutes left in the epoch. `submit` then sends the model's results in one audit. A seller that was tried but couldn't be decided is submitted as `UNDETERMINED`, as is a close call whose extra questions couldn't be asked.
4. **Late sellers:** a seller that came online after the window opened gets no result this epoch, not even `UNDETERMINED`. Its earlier verdict runs out as usual, and it is audited in the next epoch with new questions.

Confirmations of other auditors' `DIFF`s and the models you stand in for are audited as before: a stand-in model opens its own window when it is handed to you, and confirmations are submitted as soon as they are done. The exception is a confirmation on a model whose own window you still have open, for example as its stand-in: it waits for the window to close, since its evidence would publish the questions that window's sellers are still being asked. If your confirmation turn ends first, the next auditor is asked and your result is not sent. A seller that stops listing the model during a confirmation is given up the same way, and its `UNDETERMINED` is submitted, as after the last failed attempt.

## Running every epoch

Keep `antseed verifier watch` running (see [Keeping a verifier running](#keeping-a-verifier-running)). It starts each new epoch on its own. Running `run` and `submit` once per epoch is not enough: your own models get audited, but the `DIFF`s other auditors submit later wait for your confirmation, and after 12 hours they go to the next auditor. To drive it from cron instead, call `antseed verifier watch --once` every 10 minutes.

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
| `logQueryChunkBlocks` | 1000 | Most blocks one `eth_getLogs` request spans. The contract's events are kept in `<data dir>/verifier/chain-cache/`, so only the first read of a data dir scans the whole history (about 2,200 requests of 1,000 blocks in November 2026); later ones read only new blocks. A keyed RPC that accepts wider ranges makes that first read cheaper. A cache read from another chain (a fork of the same contract, or a restarted fork) is noticed by its block hash and read again; deleting `verifier/chain-cache/` and `verifier/auditor-set.json` is always safe and costs one first read |
| `auditPriceRatio` | 1 | Audit sellers priced up to this multiple of the upstream price |
| `diffHoldEpochs` | 1 | Epochs after a recorded `DIFF` in which the seller isn't audited. See [After a DIFF](#after-a-diff). Every auditor uses the same value |
| `tokenizerPrecheck` | true | Check how a seller counts input tokens before its questions. See [Tokenizer pre-check](#tokenizer-pre-check). Every auditor uses the same value |
| `models.<model>.pricing` | | The model's upstream price, if not taken from OpenRouter |
