---
title: How audits run
slug: /verify/audits
description: What antseed verifier run, submit and rewards do — which sellers are audited, how verdicts are decided, and how results go on-chain.
---

# How audits run

For setup, see [Become a verifier](/docs/verify). For the idea behind it, see [Model verification](/docs/model-verification).

## One audit

1. **Reference banks.** For each model, `verifier reference build` asks the genuine model short questions with exact answers. It keeps the ones it answers consistently and that cheaper look-alike models get wrong.
2. **Questions.** `verifier run` asks each seller a fresh set of those questions. These are normal paid requests, and the seller must sign every response.
3. **Verdict.** The seller's answers are compared with the genuine ones:

| Verdict | Meaning |
|---|---|
| `SAME` | The seller misses about as often as the genuine model |
| `DIFF` | The seller misses clearly more often: probably a different model |
| `UNDETERMINED` | Some questions got no usable answer |

4. **Recheck.** Every `DIFF` is rechecked on new questions. It only counts if the recheck isn't `SAME`.
5. **Submit.** `verifier submit` publishes the evidence and puts the results on-chain.

Running `verifier run` again in the same epoch retries only the `UNDETERMINED` sellers.

## Which models you audit

The audited models are built into the CLI, the same for every auditor. You can turn one off with `verifier.models.<model>.enabled: false`. `verifier run <model>` audits one model.

## Which sellers are audited

Every seller your buyer has found that offers the model. A seller is skipped when:

| Skip code | Reason |
|---|---|
| `missing_response_auth` | It doesn't sign its responses |
| `reputation_below_minimum` | Its trust score is below `buyer.minPeerReputation` |
| `price_above_reference` | It charges more than the model's upstream price |
| `policy_rejected` | Its pricing couldn't be read |

### Price limit

The auditor doesn't pay a seller more than the model costs upstream. The upstream price comes from the model's reference upstream or its `verifier.models.<model>.pricing`, otherwise from the OpenRouter catalog. A seller priced above it is skipped:

```
priced $17/$85 per 1M, above the claude-fable-5.1 reference $10/$50 · not audited
```

`verifier.auditPriceRatio` (default 1) lets you audit sellers that charge somewhat more, for example `1.1` for up to 10% more.

## Reference banks

Banks live in `<data-dir>/verifier/banks`. A build stops once the bank can reliably tell the genuine model from its look-alikes, or after 2,000 requests (`verifier.referenceMaxRequestsPerBuild`). Running it again grows the bank and never replaces it. Where the genuine answers come from is set in [Reference upstreams](/docs/verify/upstreams).

## Getting approved

Submitting needs an **approved auditor address**. Ask in the [Antseed Telegram community](https://t.me/antseed) or [open an issue on GitHub](https://github.com/AntSeed/antseed/issues) with the address you will submit from.

- By default this is the data-dir identity (`antseed buyer status` shows it). To sign with a keystore instead, set `verifier.keystore`.
- It needs a little ETH on Base for the transactions.
- It can't audit sellers it owns.

## Submitting

```bash
antseed verifier submit --run-id <run-id> --dry-run
export PINATA_JWT=…
antseed verifier submit --run-id <run-id> --publish-ipfs --yes
```

The dry run checks everything, including your approval. `--publish-ipfs` makes the evidence public on IPFS. A run can only be submitted in the epoch it ran in, and re-running `submit` is safe.

## Running every epoch

A verdict counts for the epoch it was given in and the next one, so run and submit once per epoch, for example from cron:

```bash
antseed verifier run \
  && antseed verifier submit --run-id "$(antseed verifier status --json | jq -r .runId)" --publish-ipfs --yes
```

## Rewards

Auditors share the verification part of ANTS emissions: one credit per model audited per epoch. Once an epoch has ended, claim with `antseed verifier rewards --claim`.

## Configuration

All keys live in the `verifier` block of the config file. The most used:

| Key | Default | Meaning |
|---|---|---|
| `referenceEndpoint` | required | Where the genuine answers come from. See [Reference upstreams](/docs/verify/upstreams) |
| `keystore` | | Keystore that signs `submit` and `rewards --claim` |
| `auditor` | data-dir identity | Your approved auditor address |
| `auditPriceRatio` | 1 | Audit sellers priced up to this multiple of the upstream price |
| `models.<model>.enabled` | `true` | `false` stops auditing that model |
| `models.<model>.pricing` | | The model's upstream price, if not taken from OpenRouter |
