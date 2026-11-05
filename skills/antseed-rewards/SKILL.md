---
name: antseed-rewards
description: Steer an Antseed gateway toward providers that earn the user Antseed Points (ANTS rewards), within a price band the user accepts. Use when the user asks to earn more ANTS or points from their Antseed spend, to prefer staked or boosted providers, to "route for rewards", or mentions provider boost. Needs a running Antseed gateway (antseed gateway start); does not change the desktop app's routing.
---

# Route an Antseed Gateway for Rewards

Find, for each model the user runs, the providers that earn the most Antseed Points at a price close to the cheapest. Then, after the user agrees, put them first in the gateway's routing policy. Normal automatic routing stays as the fallback.

## What earns points (say this accurately)

- On every paid request, the buyer earns points equal to the USDC spent × the provider's **boost**. Boost is the provider pool's staking power ÷ (10,000 ANTS locked for 104 epochs). A boost of 1.0 means $1 spent earns 1 point.
- A provider with no staked pool has boost 0, so spend with it earns nothing. Free models earn nothing either.
- Pool power is fixed for each weekly epoch, so boosts change at most once a week.
- Points turn into ANTS when the epoch ends. Every buyer's points share that epoch's buyer pot, so the ANTS a point is worth falls as more buyers earn. Any one claim is capped at 5% of the pot. Verification and wash-trading checks can scale points down.

Never state an ANTS amount, a rate per dollar in ANTS, or a guarantee. Say "earns points", not "earns X ANTS".

## 1. Check the gateway

```bash
antseed gateway peers --json
```

- If this fails because no buyer is running, the user needs a gateway first. Point them to https://antseed.com/skill.md, the join-buyer skill, and stop.
- Each peer must carry a `boost` field. If the field is missing, the CLI is too old: ask the user to update with `npm install -g @antseed/cli@latest`.
- If every `boost` is `null`, Antscan (the explorer that serves pool powers) could not be reached. Say so and stop. Never guess boosts.

## 2. Find the models

Ask which models the user wants this for, or read what they used over the last 30 days:

```bash
antseed gateway usage --group-by model --json
```

## 3. Rank the providers for each model

```bash
antseed gateway peers --model <model> --json
```

From the result, for each peer use its `services` entry for that model:

1. **Price** = `inputUsdPerMillion` + `outputUsdPerMillion`, which is how automatic routing compares prices.
2. **Drop** free offers (price 0), peers with `boost` below 0.01 (they earn effectively nothing), and peers with `washFlagged: true`.
3. **Band.** Find the cheapest paid peer among all sellers for the model (earning or not). Keep earning peers whose price is at most 1.3× that price. The 30% band matches how far automatic routing already spreads traffic from the cheapest choice. If the user names another limit, use theirs.
4. **Order** by boost, highest first. On a tie, the lower price goes first. Keep the top 3.

If no earning peer is inside the band, say so, show the cheapest earning peer and its premium, and change nothing unless the user asks.

## 4. Show the plan and ask

Show one table per model and ask before changing anything:

| Provider | $/M in + out | vs cheapest | Boost | Trust |
|---|---|---|---|---|
| `displayName` (short `peerId`) | 3.20 | +12% | 1.4× | 82 |

Under the table, in one or two sentences: these providers would go first for this model, the price premium is up to N%, each dollar spent with one of them earns points at its boost, and requests fall back to normal routing if these providers are unavailable or excluded by the policy.

## 5. Apply, after the user says yes

Apply at the level the user wants: the gateway default (every key) or one key.

1. **Read the current policy.**
   - Gateway default: `antseed gateway routing show --json` prints the policy itself.
   - One key: `antseed gateway key policy show <key-id> --json` prints `routingPolicy` (the admin layer).
2. **Build the new routes.** Take the existing `modelRoutes` object, or `{}` when there is none (a key's `routingPolicy` can be `null`). A route printed without `strict` is non-strict. Set only this model's entry and keep every other model's entry exactly as it was:
   ```json
   { "modelRoutes": { "<model>": { "peerIds": ["<peerId 1>", "<peerId 2>", "<peerId 3>"], "strict": false } } }
   ```
   Write the whole `modelRoutes` object, every model included, to a temporary file. `--merge` keeps the policy's other fields but replaces `modelRoutes` as a whole, so a file that holds only the new model would delete the user's other routes.
3. **Save it.**
   - Gateway default: `antseed gateway routing set --merge --file <file>`
   - One key: `antseed gateway key policy set <key-id> --merge --file <file>`
4. **Never set `"strict": true`.** Strict routes refuse every other seller, which removes the fallback.

## 6. Verify

```bash
antseed gateway routing preview --model <model>
```

Add `--key <key-id>` for a key. The first eligible candidate should be the first provider in the new route. If it is not, read its reasons. A workspace, key or preset may set its own route for the model, and the lower level's route wins. A chain provider may also be excluded by the policy's trust minimum or price caps. Tell the user what you found.

## 7. Keep it fresh, or undo it

- Boosts can change each weekly epoch. Suggest re-running this skill once a week, and replace the routes it set.
- To undo, repeat step 5 with this model's entry removed from `modelRoutes`. If no routes remain, write `"modelRoutes": {}`.

## Rules

- Change nothing without the user's yes for that model and level.
- Never touch policy fields other than `modelRoutes`. Never remove another model's route.
- Always show the price premium. Earning points can cost more per request.
- Never promise ANTS amounts or say rewards are guaranteed.
- If boosts cannot be read, stop rather than route on old or guessed numbers.
- This skill only changes a gateway's routing policy. It does not change how the desktop app routes.

## Errors

- `--merge` or `--file` unknown: the CLI is too old. Update with `npm install -g @antseed/cli@latest`.
- `That is not a valid routing policy`: check the file is a JSON object and every `peerIds` entry is a peer id string from `gateway peers`.
- An `empty_allow_list` or narrowing warning: another field in the policy leaves no seller. Show the message to the user. Do not pass `--confirm-empty` or `--accept-narrowed` unless they ask.
