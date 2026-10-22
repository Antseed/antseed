# antseed-rewards

Steer your Antseed gateway toward providers that earn you Antseed Points. For each model you run, the agent finds the providers with the highest boost whose price is within 30% of the cheapest, shows them to you with the price premium, and, once you agree, puts them first in the gateway's routing policy. Automatic routing stays as the fallback.

Points are paid spend × the provider's boost, and they turn into ANTS when each weekly epoch ends. The ANTS a point is worth depends on how many points everyone earns that epoch, so the skill never promises an amount.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-rewards
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

A running Antseed gateway (`antseed gateway start`; see the [join-buyer skill](../join-buyer/SKILL.md)) and an `@antseed/cli` release whose `antseed gateway peers --json` includes each provider's `boost`.

## Example prompt

```text
Use antseed-rewards to route my gateway's kimi-k2.6 traffic to providers that earn points, but don't pay more than 20% over the cheapest.
```

The skill changes only per-model routes (`modelRoutes`, never strict) in the policy level you choose, and asks before every change. Run it again weekly, since boosts can change each epoch.
