---
name: antseed-verify-model
description: Check whether an OpenAI- or Anthropic-compatible API endpoint really serves the model it claims, using the latest published Antseed model audit from IPFS. Use when the user wants to verify a model behind an endpoint (a provider, another network, an Antseed buyer proxy), doubts that an API serves the advertised model, or mentions model verification, KBF, SAME/DIFF verdicts, or antseed-verify. Not for submitting audits on-chain or claiming auditor rewards.
---

# Verify the Model Behind an Endpoint

Audit an API endpoint against the latest published Antseed model audit and tell the user whether it serves the claimed model. The audit is a Knowledge Boundary Fingerprinting (KBF) check: about 100 short numeric recall questions taken from the published audit on IPFS, followed by a statistical test. How it works: https://antseed.com/docs/model-verification.

This skill only checks. It never submits anything on-chain, never claims rewards, and never changes the user's config.

## 1. Ask for the endpoint

Ask the user for:

- **Base URL** including the version, for example `https://openrouter.ai/api/v1`.
- **Model id** the endpoint expects, for example `anthropic/claude-opus-5.5`.
- **Audited model** as Antseed audits it, for example `claude-opus-5.5`, if it differs from the model id.
- **Protocol**: `openai` (Chat Completions, the default) or `anthropic` (Messages API).

Do not ask for the API key in chat.

## 2. Give the user a command to set the API key

The key must never appear in the conversation or in shell history. Give the user this to run in the terminal where the check will run:

```bash
printf 'API key: '; read -rs VERIFY_API_KEY; echo; export VERIFY_API_KEY
```

It works in zsh and bash, and the key is not echoed. If the key is already in an environment variable (for example `OPENROUTER_API_KEY` from a `.env` file), skip the prompt and pass `--api-key-env OPENROUTER_API_KEY` instead, without printing it. Endpoints without a key, such as a local Antseed buyer proxy at `http://127.0.0.1:8377/v1`, skip this step.

If your commands run in a different shell from the user's terminal, the variable is not visible to you. Then give the user the full command from step 3 to run themselves and ask them to paste the output.

## 3. Run the check

```bash
antseed verifier check <audited-model> \
  --base-url <base-url> \
  --target-model <model-id> \
  --protocol <openai|anthropic> \
  --json --out ./verify-<audited-model>.json
```

What it does:

1. Finds the latest on-chain audit for `<audited-model>` and reads its evidence from IPFS (`ipfs://…`).
2. Checks the evidence against the hash recorded on-chain, so the questions cannot have been tampered with.
3. Sends a fresh random subset of that audit's questions to the endpoint, in batches of 10, and runs the statistical test.

If the user already has an audit address, add `--audit ipfs://<cid>` to use it instead of looking one up on-chain.

The check pays the endpoint for about 100–120 short questions, roughly 10–15k tokens (about $0.10 at Opus-class prices), and takes about a minute. Mention this before running.

## 4. Tell the user the result

Exit codes: `0` SAME, `2` DIFF, `3` UNDETERMINED, `1` error.

- **SAME**: no evidence of substitution. The endpoint misses about as often as the genuine model does, so it very likely serves the claimed model.
- **DIFF**: significantly more wrong answers than the genuine model makes. The endpoint very likely serves a different model (or a heavily quantized or altered one).
- **UNDETERMINED**: some questions got no usable answer (errors, refusals, timeouts), so there is no verdict. Not evidence either way; suggest trying again later.

Read the numbers from the JSON:

- answers that differed: `stats.targetHamming` of `stats.targetTotal`
- what the genuine model gets wrong at most: about `stats.p0Cp99 × stats.targetTotal`
- p-value: `stats.pValueBinomial` (DIFF when it is below 0.05)

UNDETERMINED with `stats.targetCoverage` 0 means no question got an answer at all. That is a setup problem, not a result: look at `batches[].failureReason` in the `--out` file (`HTTP 401`/`403` means a wrong key, connection errors mean a wrong base URL), fix it, and run again. A single unanswered question is enough to make the result UNDETERMINED.

Answer in one or two plain sentences, for example: "SAME: 6 of 120 answers differed, while the genuine model gets up to about 11 wrong (p = 0.97), so this looks like the real claude-opus-5.5." Mention the audit it used (`audit` in the JSON).

## Rules

- Never ask for, print, or log the API key.
- Run the check once; repeats cost money. Ask before running again.
- Never call a provider a cheat from an UNDETERMINED result or a failed run. One DIFF is a strong signal, not proof.
- `--out` holds the raw requests and responses. Do not share it unless the user asks.
- Never run `antseed verifier run`, `submit` or `rewards`. Those are for approved auditors.

## Errors

- `failed to fetch https://ipfs.io/ipfs/... HTTP 429` (or 5xx, timeouts): the public IPFS gateway is rate-limiting. Nothing was paid. Retry with `--ipfs-gateway https://gateway.pinata.cloud/ipfs` (or another gateway); the evidence is hash-checked, so any gateway is safe.
- `no published on-chain audit found for <model>`: nobody has audited that model yet, or the name differs from the audited one. Ask the user for the audited model name or an `ipfs://` audit address.
- `No verification contract address configured`: the CLI's chain has no verification contract. Ask for an `ipfs://` audit address and pass `--audit`.
- `audit … is for X, not Y`: the audited model name does not match the audit; use the name the audit was made for.
- `antseed: command not found`, or `verifier check` missing: install or update with `npm install -g @antseed/cli@latest`. `verifier check` needs a CLI release that includes model verification.
