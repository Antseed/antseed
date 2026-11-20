---
title: Model verification for providers
sidebar_label: For providers
slug: /verify/providers
description: How your services are audited, what SAME and DIFF results do to your reputation and ANTS rewards, and what to do if you get a DIFF.
---

# Model verification for providers

Auditors regularly check that your services serve the models they advertise. You don't need to sign up or install anything. This page covers what gets audited, what a result does to you, and how to fix a DIFF. For the basics, see the [overview](/docs/verify/overview).

## What gets audited

Every epoch, each model on the audit list is tested on every seller that offers it. `antseed verifier models` prints the list. An audit is between 100 and 500 short questions, the same set for every seller of the model in that epoch, sent ten to a request as normal paid requests, so you get paid for them like any other traffic. Only the wording of the prompt around the questions changes from request to request.

Before the questions, the auditor sends [a few short requests](/docs/verify/audits#tokenizer-pre-check) and compares the input tokens you sign for them with the model's own count. So when you list an audited model, pass the buyer's input to that model as it is. A fixed system prompt is fine: it is the same in every request and cancels out. Input that changes with the message, such as retrieved documents, a skill or an agent's notes, makes your counts differ from the model's, and the result can be `DIFF`. If you add retrieval, skills or an agent, offer that as a service under its own name, not under the audited model's name.

The auditor also sends [one request under a small reply limit](/docs/verify/audits#cap-check). Pass the buyer's `max_tokens` to the model, and bill the output tokens it wrote. A service that bills an answer clearly longer than the limit it was given, twice, gets `DIFF`, even when it serves the genuine model. Reasoning you bill outside the limit is fine when your answer reports it as reasoning tokens. The auditor also asks you to [repeat a short and a long text](/docs/verify/audits#echo-check) and compares the output tokens you bill with the model's. A constant you add to every reply is fine, and billing that grows faster than the model's output can give `DIFF`. A large fixed amount added to every reply is recorded for observation only: it never gives or clears a `DIFF`.

A service is not audited when it costs more than the model does upstream, meaning more than the most any OpenRouter provider charges for it. Such a service gets no result, so it gets no bonus either.

## What a result does to you

**SAME** raises your ANTS points by 2% for each verified service, up to +50%.

**DIFF** does two things:

- That service keeps only 10% of its reputation, so buyers' automatic routing stops sending requests to it. Your overall trust score also drops by the same amount as your points (below), so you rank a little lower for your other models too.
- Your ANTS points go down on every settlement, whatever model it was for, because rewards count all your services together. One DIFF service costs 4%, two cost 16%, three 36%, four 64%. From five on you earn no points at all.

The bonus and the penalty add up, so 6 SAME services and 1 DIFF give you 108% of your usual points. Your buyers' points and your pool's staker rewards move by the same amount, so a DIFF also costs the buyers and stakers who chose you.

**UNDETERMINED** changes nothing. It usually means your service returned errors, timed out or sent empty answers during the audit.

A DIFF never affects your USDC: you are still paid for what you served. These are the current Base mainnet settings and the contract owner can change them.

## Check your results

[Antscan](https://antscan.co/view/verifications) shows your SAME and DIFF services and links each result to the audit behind it. The audit evidence on IPFS has every question, your answers and the statistics, so you can see exactly which answers didn't match.

## Check yourself first

You can run the question check against your own endpoint at any time, for example before you switch upstreams or change a model mapping:

```bash
antseed verifier check <model> --base-url <your endpoint> --api-key-env VERIFY_API_KEY
```

It prints `SAME`, `DIFF` or `UNDETERMINED`. It asks the questions of the latest published audit for that model, ten to a request, and you pay for them: 10 to 50 short requests for a set of 100 to 500 questions, plus a few first to find how your endpoint turns off thinking. It does not run the token-count pre-check, so a `SAME` here does not show how your signed input tokens compare with the model's. See the [CLI reference](/docs/commands) for the options.

## If you get a DIFF

A DIFF means two auditors, each with its own audit, found the same problem: your service answers differently from the genuine model, counts input tokens differently, bills beyond the reply limit it was given, or bills more output than the model wrote. The evidence names the check. For the reply limit, check that your gateway passes `max_tokens` on to the model. Otherwise start with the upstream:

- Is the upstream serving the exact model you advertise, and not a smaller, distilled or heavily quantized version?
- Does your model ID map to the right upstream model?
- Does the upstream or an aggregator fall back to another model under load or on errors?

Once it's fixed, run `antseed verifier check` against your endpoint to confirm. The next audit clears the DIFF: a single auditor's SAME is enough. If you can't fix it, stop offering the model under that name. Either way, a result only counts for the epoch it was given in and the next one, so an old DIFF goes away on its own once newer audits stop finding it.

If you think the result is wrong, the evidence is public. Rerun the same audit with `antseed verifier check --audit <ipfs://cid>` and raise it with the team, together with your output.
