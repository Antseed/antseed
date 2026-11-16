# antseed-decisions

Ask a System One decision model (TypeSafe Jev) typed questions through Antseed's network-wide decision model routing. Returns classifications, rubric scores, and yes/no probabilities your code can branch on, not generated text.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-decisions
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

Antseed Desktop or `antseed buyer start` (CLI 0.1.161 or later) must be running, and the buyer must have sufficient deposited USDC. The skill uses the local buyer proxy, normally at `http://127.0.0.1:8377`.

## Parameters

Provide the skill with:

- `model` — decision model id or alias; optional when you want the skill to inspect the current catalog first
- `state` — the text or structured data to evaluate
- `questions` — one or more `choice`, `score`, or `noul` questions

The skill first queries `/v1/models?type=decisions`, resolves the requested model against the returned ids and aliases, and sends the bare model id to `/v1/systemone`. The buyer proxy applies the shared Price + Trust preferences and handles fallback between eligible sellers.

The official TypeSafe SDKs also work unchanged with `TYPESAFE_BASE_URL` pointed at the buyer proxy.

## Example prompt

```text
Use the antseed-decisions skill with:
model: jev-latest
state: "Hi, I've been trying to connect my Stripe account for 3 days and it keeps failing. I'm losing sales. Please help ASAP."
questions: which team should handle this (billing, technical, sales), how frustrated the customer is, and whether it is urgent
```

See [SKILL.md](SKILL.md) for the request contract, when to prefer a decision model over a chat model, safety rules, and error handling. The upstream request and answer formats are documented at https://docs.typesafe.ai/.
