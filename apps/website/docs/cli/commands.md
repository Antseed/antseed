---
sidebar_position: 1
slug: /commands
title: CLI Commands
sidebar_label: Commands
hide_title: true
---

# CLI Commands

### Getting started

```bash title="setup"
antseed seller setup                  Initialize seller onboarding
antseed buyer start                   Start the buyer proxy
```

In normal use, you configure the node once with `antseed seller setup` or `antseed config ...`, then start it later with `antseed seller start` or `antseed buyer start` without repeating flags every time. Secrets such as API keys stay in env vars; provider definitions, services, pricing, capabilities, unit billing, and `baseUrl` live in `~/.antseed/config.json`.

### Providing (selling)

```bash title="provider"
antseed seller start                  Start providing AI services
antseed seller start --base-rpc-url <url>
                                      Use a custom Base RPC URL for this run
antseed seller register               Register peer identity on-chain (ERC-8004)
antseed seller stake <ants> --epochs <n>
                                      Stake ANTS only (optional; requires the upgrade)
antseed seller legacy stake <amount>  Stake USDC as a provider (pre-cutover, min $10)
antseed seller legacy unstake         Withdraw legacy USDC stake
antseed seller legacy claim-starter   Claim the legacy-seller starter ANTS position
antseed seller pool positions         List pool positions
antseed seller pool withdraw <id...>  Withdraw positions (`--accept-slashing` for early exit)
antseed seller rewards [claim]        View or claim all seller rewards
```

### ANTS staking

```bash title="ants"
antseed ants                          Open the local staking dashboard (wallet-signed; --port, --no-open)
antseed ants status                   Phase, epoch countdown, balances, stake, claimable rewards
antseed ants stake <ants> --agent <id> --epochs <n>
                                      Stake ANTS into any registered seller pool
antseed ants positions                Open lANTS positions with state, pending rewards, exit slash
antseed ants move <id...> --to <id>   Move positions to another pool (terms preserved)
antseed ants split <id> <ants>        Split a position; antseed ants merge <id...> merges same-pool positions
antseed ants extend <id> --epochs <n> Extend a lock; antseed ants max-lock <id> [--off] toggles max lock
antseed ants withdraw <id...> [--preview] [--accept-slashing]
                                      Withdraw with a slashing estimate and explicit consent
antseed ants rewards [claim]          View or claim staker, seller, buyer, legacy, and locked rewards
antseed ants rewards compound --epochs <n> [--to <agentId>]
                                      Restake every restakable reward into new positions (optionally moved into one pool)
antseed ants rewards restake --epochs <n>
                                      Restake staker pool rewards only
antseed ants rewards stake-usage --side <seller|buyer> --epochs <n>
                                      Claim usage rewards straight into a position
antseed ants pools | pool <id>        Compare pools: power, share, volume per epoch, ANTS per 1k power, your share
antseed ants usage | emissions | addresses
                                      Usage points per epoch, emission schedule, contract addresses
antseed ants seller [register|claim-starter]
                                      Seller binding, eligibility, starter grant
antseed ants verify [seller]          Wash-trading registry facts and per-seller status
antseed ants verify submit <artifact.json>
                                      Stage, authenticate, and finalize a seller proof (resumable)
antseed ants verify proof <proofId>   Proof submission progress
```

Every dashboard action maps to one of these commands; the dashboard runs on
`127.0.0.1` and signs with the node wallet.

### Buying (consuming)

```bash title="buyer"
antseed buyer start                   Start the buyer proxy
antseed buyer start --router <name>   Start the buyer proxy with a non-default router
antseed buyer deposit                       Show funding address + QR; incoming USDC deposits automatically (gasless)
antseed buyer sweep                   Gaslessly sweep hot-wallet USDC into deposits (fixed relay fee)
antseed buyer deposit --onchain <usdc>  Direct on-chain deposit from the hot wallet (requires ETH for gas)
antseed buyer withdraw <amount>       Withdraw USDC from deposits
antseed buyer set-authorized-wallet   Connect and authorize an external wallet (`--self` for the buyer wallet)
antseed buyer activity                Activity summary: tokens, spend history, savings, channels, claimable ANTS
antseed buyer balance                 Check wallet and deposit balance
antseed network browse                Browse peers, models, and pricing (same catalog as /v1/models)
```

### Network and monitoring

```bash title="network"
antseed seller status                 Show seller status
antseed seller doctor                 Diagnose the announced seller endpoint
antseed buyer status                  Show buyer status
antseed metrics serve                 Serve Prometheus-compatible buyer/seller metrics
antseed config                        Manage config file
antseed peer <peerId>                 View a peer's profile
antseed profile                       Manage your peer profile
antseed buyer channels                List payment channels
antseed network bootstrap             Run a dedicated DHT bootstrap node
antseed buyer connection              Manage connection settings
antseed dev                           Run seller + buyer locally for testing
```

### Service configuration

`antseed config seller add-service <provider> <serviceId>` supports:

| Option | Purpose |
|---|---|
| `--upstream <model>` | Map the public service ID to an upstream model ID |
| `--input`, `--cached`, `--output` | Token prices in USD per million tokens |
| `--categories <csv>` | Discovery tags |
| `--capabilities <json>` | Model hints such as context window, input modalities, reasoning, and tool use |
| `--unit-billing-models <json>` | Per-protocol non-token billing, currently used by `openai-images` |
| `--base-url <url>` | Set the provider-wide upstream base URL |

```bash
antseed config seller add-service openai flux.1-schnell \
  --upstream "black-forest-labs/FLUX.1-schnell" \
  --input 0 --output 0 \
  --capabilities '{"inputs":["text","image"]}' \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.003}]}}'
```

`antseed seller setup` exposes the same capability and unit-billing fields interactively. `antseed seller start` warns if unit billing is configured for a plugin that does not support it. Image services are not health-probed because a meaningful probe would incur an upstream generation charge.

Before deploying this CLI version to sellers, follow the [metadata v12 upgrade order](/docs/guides/metadata-v12-upgrade): upgrade buyers first, then sellers.
