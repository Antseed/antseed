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

It works in zsh and bash, and the key is not echoed. Endpoints without a key, such as a local Antseed buyer proxy at `http://127.0.0.1:8377/v1`, skip this step.

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

If the user already has an audit address, add `--audit ipfs://<cid>` to use it instead of looking one up on-chain. Without the Antseed CLI, `npx antseed-verify --base-url <url> --model <id> --audit ipfs://<cid> --json` does the same.

The check pays the endpoint for roughly 100 short questions (about 20–30k tokens). Mention this before running.

## 4. Tell the user the result

Exit codes: `0` SAME, `2` DIFF, `3` UNDETERMINED, `1` error.

- **SAME**: no evidence of substitution. The endpoint misses about as often as the genuine model does, so it very likely serves the claimed model.
- **DIFF**: significantly more wrong answers than the genuine model makes. The endpoint very likely serves a different model (or a heavily quantized or altered one).
- **UNDETERMINED**: some questions got no usable answer (errors, refusals, timeouts), so there is no verdict. Not evidence either way; suggest trying again later.

Answer in one or two plain sentences with the numbers from the output, for example: "SAME: 4 of 100 answers differed, and the genuine model gets up to 6 wrong, so this looks like the real claude-opus-5.5." Mention the audit it used (`audit` in the JSON).

## Rules

- Never ask for, print, or log the API key.
- Run the check once; repeats cost money. Ask before running again.
- Never call a provider a cheat from an UNDETERMINED result or a failed run. One DIFF is a strong signal, not proof.
- `--out` holds the raw requests and responses. Do not share it unless the user asks.
- Never run `antseed verifier run`, `submit` or `rewards`. Those are for approved auditors.

## Errors

- `no published on-chain audit found for <model>`: nobody has audited that model yet, or the name differs from the audited one. Ask the user for the audited model name or an `ipfs://` audit address.
- `No verification contract address configured`: the CLI's chain has no verification contract. Ask for an `ipfs://` audit address and pass `--audit`.
- `audit … is for X, not Y`: the audited model name does not match the audit; use the name the audit was made for.
- HTTP 401/403 from the endpoint: the API key is missing or wrong; have the user set it again with step 2.
- `antseed: command not found`: install with `npm install -g @antseed/cli`, or use `npx antseed-verify` with `--audit`.
