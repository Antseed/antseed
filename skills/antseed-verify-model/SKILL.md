---
name: antseed-verify-model
description: Check whether an OpenAI- or Anthropic-compatible API endpoint really serves the model it claims, using the latest revealed Antseed verification question bank from IPFS. Use when the user wants to verify a model behind an endpoint (a provider, another network, an Antseed buyer proxy), doubts that an API serves the advertised model, or mentions model verification, KBF, SAME/DIFF verdicts, or antseed-verify. Not for running a verifier, attesting results or claiming verifier rewards.
---

# Verify the Model Behind an Endpoint

Audit an API endpoint against the latest revealed Antseed verification question bank and tell the user whether it serves the claimed model. The audit is a Knowledge Boundary Fingerprinting (KBF) check: about 100 short numeric recall questions taken from a bank the verifiers used in an earlier epoch, followed by a statistical test. How it works: https://antseed.com/docs/model-verification.

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

1. Finds the newest epoch whose question bank includes `<audited-model>` and whose bank key has been revealed on-chain, and reads the bank from IPFS (`ipfs://…`).
2. Checks the bank against the hash recorded on-chain, so the questions cannot have been tampered with, and decrypts it with the revealed key.
3. Sends a fresh random subset of that model's questions to the endpoint, in batches of 10, and runs the statistical test.

Add `--epoch <n>` to use one epoch's bank. If the user already has the address of older published audit evidence, add `--audit ipfs://<cid>` to use it instead of looking one up on-chain.

The check pays the endpoint for about 100–120 short questions, roughly 10–15k tokens (about $0.10 at Opus-class prices), and takes about a minute. Mention this before running.

## 4. Tell the user the result

Exit codes: `0` SAME, `2` DIFF, `3` UNDETERMINED, `1` error. If the endpoint answered nothing at all, the check fails with `the endpoint answered none of the N requests, so no verdict: <reason> (check the API key)` instead of giving a verdict; fix the key, URL or model id and run again.

- **SAME**: no evidence of substitution. The endpoint misses about as often as the genuine model does, so it very likely serves the claimed model.
- **DIFF**: significantly more wrong answers than the genuine model makes. The endpoint very likely serves a different model (or a heavily quantized or altered one).
- **UNDETERMINED**: the answers it got can't settle it either way. Usually too many questions got no usable answer (errors, refusals, timeouts), so the missing ones could still change the outcome. Not evidence either way; suggest trying again later.

Always report the `verdict` and its `reason` from the JSON exactly as the command returns them; never work out a verdict yourself from the numbers. The command already accounts for unanswered questions: a few missing answers can still give SAME or DIFF when they could not change the outcome, while a result that looks significant on the answered questions alone can be UNDETERMINED if too few were answered. The `reason` says which.

Numbers you can quote from the JSON:

- answers that differed: `stats.targetHamming` of `stats.targetTotal` answered (`stats.targetCoverage` is the share of questions answered)
- what the genuine model gets wrong at most: about `stats.p0Cp99 × stats.targetTotal`
- p-value on the answered questions: `stats.pValueBinomial`

Answer in one or two plain sentences, for example: "SAME: 6 of 120 answers differed, while the genuine model gets up to about 11 wrong (p = 0.97), so this looks like the real claude-opus-5.5." Mention the bank or audit it used (`audit` in the JSON).

## Rules

- Never ask for, print, or log the API key.
- Run the check once; repeats cost money. Ask before running again.
- Never call a provider a cheat from an UNDETERMINED result or a failed run. One DIFF is a strong signal, not proof.
- `--out` holds the raw requests and responses. Do not share it unless the user asks.
- Never run `antseed verifier start`, `publish` or `run`. Those are for verifiers and the reference publisher.

## Errors

- `the endpoint answered none of the N requests`: see the reason in the message. `HTTP 401`/`403` means a wrong API key (redo step 2), `HTTP 404`/`400` a wrong base URL, model id or protocol, connection errors a wrong URL or a down endpoint. Nothing was judged and little or nothing was paid.
- `failed to fetch ipfs://... (... HTTP 429 ...)`: every public IPFS gateway the CLI tried is rate-limiting or down (it tries ipfs.io, Pinata and dweb.link in turn). Nothing was paid. Wait a minute or pass another gateway with `--ipfs-gateway <url>`; the evidence is hash-checked, so any gateway is safe.
- `no revealed question bank in the last 8 epochs includes <model>`: that model hasn't been audited in a recent round, or the name differs from the audited one. Ask the user for the audited model name or an `ipfs://` audit address.
- `No verification contract address configured`: the CLI's chain has no verification contract. Ask for an `ipfs://` audit address and pass `--audit`.
- `audit … is for X, not Y`: the audited model name does not match the audit; use the name the audit was made for.
- `antseed: command not found`, or `verifier check` missing: install or update with `npm install -g @antseed/cli@latest`. `verifier check` needs a CLI release that includes model verification.
