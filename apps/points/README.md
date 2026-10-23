# Antseed Points

A one-page site that shows the Antseed Points people already earn on-chain, and what they turn into each Thursday. Nothing about the contracts changes: the site only reads what's there.

## What's on the page

From top to bottom:

- **Hero.** A tabbed card: look up any account's points (no wallet needed), or copy a prompt that sets an agent up with Antseed. Next to it, a calculator: spend $X with a provider → points → estimated ANTS this Thursday.
- **This week in numbers.** Pot, ANTS per point (projected to Thursday), time left, points, buyers, spend.
- **Your points.** Shows once an address is known (lookup, `?address=` link, or connected wallet). Points, rank, estimated ANTS, rewards ready to claim, claim and stake buttons, recent weeks.
- **Leaderboard.** Buyers, providers or stakers, this week or all time. Top 10, expandable to 50. A ticker of recent payments runs along the top.
- **Providers.** Every provider with its boost. Click one to see its models, prices and discount against the official list price.
- **Start earning.** Three steps: download the AI VPN, add funds, use a boosted provider.
- **Stake.** Stake your unclaimed rewards behind a provider (wallet staking opens Nov 4). Shows the estimated weekly reward, the provider's new boost, and the steps.
- **lANTS.** Every stake is an NFT; links to the two lANTS marketplaces.
- **Week by week.** ANTS per point for every week since rewards began.
- **How points work.** Boost, the staker pot, and questions.

Public X profiles live at `/u/<handle>` with a share card. Old paths (`/me`, `/stake`, `/leaderboard`…) redirect to their section.

## How it works

- Static React app. Every number is read in the visitor's browser from **Antscan** (REST + GraphQL) and **Base** (a few contract reads). No server is needed for any of that.
- Estimates for "by Thursday" use the same maths everywhere (`src/lib/points.ts`, tested): this week's pace projected to the end of the week, capped at 5% per account like the contract.
- Model discounts come from OpenRouter's public model list, matched the same way as the website's pricing card.
- **Only X sign-in needs a backend.** The code in `functions/` is a local stand-in and stores wallet ↔ X links, which the foundation can't do in production. See `BACKEND.md` for the endpoints and the store-nothing alternative. Without a backend, the X parts hide themselves and everything else works.

## Run it

```bash
pnpm --filter @antseed/points dev          # http://localhost:5192, no X features
pnpm --filter @antseed/points dev:pages    # http://localhost:8788, with a fake X sign-in
pnpm --filter @antseed/points test
pnpm --filter @antseed/points build        # → dist/
```

## Deploy

- Serve `dist/` as a static site, with **every unknown path falling back to `index.html`** (so `/u/<handle>` and old links work).
- Copy the security headers from `public/_headers` (Cloudflare format) into whatever server is used. The CSP allows Antscan, the Base RPCs, WalletConnect, OpenRouter and the font hosts.
- The domain is **antseedpoints.com** (already in `index.html`'s share tags). If X sign-in ships: the X app's callback URL is `https://antseedpoints.com/api/auth/x/callback`, and `PUBLIC_URL=https://antseedpoints.com`.
- Optional: `VITE_ANTSCAN_URL` points the site at another Antscan.

## Before launch

- Test **claim** and **stake rewards** with a team wallet that has real unclaimed rewards. Neither has been sent for real yet.
- Decide on X: ship without it, or build the stateless backend in `BACKEND.md`.
- The AI VPN and console link here as `https://antseedpoints.com/me?address=…` (which lands on Your points). `VITE_POINTS_URL` overrides it in both.
