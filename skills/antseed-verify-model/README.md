# antseed-verify-model

Check whether an API endpoint really serves the model it claims. You give the agent an endpoint (base URL, model id, protocol) and set the API key yourself in your terminal; the agent runs `antseed verifier check`, which takes the latest published Antseed model audit from IPFS, checks it against its on-chain hash, audits the endpoint, and tells you SAME, DIFF or UNDETERMINED in plain words.

Works with any OpenAI- or Anthropic-compatible endpoint: a provider's own API, another network, or an Antseed buyer proxy. It only checks; it never submits anything on-chain or claims rewards.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-verify-model
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

`@antseed/cli` installed (`npm install -g @antseed/cli`) and an API key for the endpoint. One check sends about 100 short questions to the endpoint, which you pay for.

## Example prompt

```text
Use antseed-verify-model to check whether https://openrouter.ai/api/v1 really serves claude-opus-5.5 (model id anthropic/claude-opus-5.5).
```

See [How model verification works](https://antseed.com/docs/model-verification) for the method and what the verdicts mean.
