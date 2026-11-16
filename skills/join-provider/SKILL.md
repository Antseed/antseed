---
name: join-provider
description: Set the user up as an Antseed provider (seller) with the CLI. Installs the CLI, adds a provider and its services with prices, and checks the config, then stops for the user's go-ahead before anything that spends ETH or announces the seller to the public network. Use when the user wants to sell AI services on Antseed, offer a local model, or become an Antseed provider.
---

# Join Antseed as a Provider

Set the user up to offer AI services on the Antseed network with the `antseed` CLI. Every command here is non-interactive, so you can run it as written. The full guide for humans is https://antseed.com/docs/provide.

## Terms of use: read first

> **Antseed is for providers who add value on top of AI models, not for raw resale of API keys or subscription access.**
>
> Good fits: inference in a Trusted Execution Environment (TEE), domain-specific skills or agent workflows, fine-tuned or self-hosted models, or a managed product.
>
> **The subscription plugins (`claude-code`, `claude-oauth`, `openai-responses`) are for local testing only.** Reselling personal subscription credentials (for example Claude Pro or Team plans) breaks the upstream provider's terms and is not allowed.
>
> The provider is responsible for following their upstream's usage policies.

## What needs money, and when to stop

Steps 1 to 5 cost nothing and don't touch the network beyond npm. Two later steps do, and you must **stop and ask the user before each**:

- **Registration** (`antseed seller register`) is an on-chain transaction on Base. It needs ETH on Base in the seller wallet for gas.
- **Starting the seller** (`antseed seller start`) announces it on the public network. Buyers can then send it requests.

How much ETH: registration itself costs very little (about 0.0000012 ETH in a recent run). If the wallet has too little, `antseed seller register` fails with `insufficient funds ... have <wei> want <wei>`, which gives the exact amount. A running seller also pays gas to settle payments, and it stops advertising while the wallet holds less than 0.00005 ETH (`seller.gasCheck.minBalanceEth`). So ask the user to send more than that, for example 0.0005 ETH, the level at which the seller starts refuelling itself from its USDC earnings on Base mainnet.

Staking ANTS is optional and not needed to sell.

## Step 1: Install the CLI

Needs Node.js 20 or newer.

```bash
npm install -g @antseed/cli
antseed --version
```

## Step 2: Create the identity

The seller's identity is a private key. Its EVM address is both the peer ID on the network and the wallet that receives USDC. Don't use `antseed seller setup`: it is an interactive wizard.

```bash
antseed seller status
```

This creates `~/.antseed/identity.key` if it doesn't exist and prints the **Wallet address**. Tell the user this address. It's where they send ETH later.

To use a key the user already has instead, set it in the environment before any other command. It takes precedence over `identity.key`:

```bash
export ANTSEED_IDENTITY_HEX=<64-hex-char-private-key>
```

Never print, log or commit the private key.

## Step 3: Add a provider

Ask the user what they will serve from, then add a provider. The first argument is a name you choose; `--plugin` picks the plugin, which the command installs.

| Upstream | `--plugin` | Credential (environment variable at start) |
|---|---|---|
| OpenAI-compatible API (OpenAI, Together, OpenRouter, others) | `openai` | `OPENAI_API_KEY` |
| Anthropic API | `anthropic` | `ANTHROPIC_API_KEY` |
| Local model server (Ollama, llama.cpp) | `local-llm` | none |

OpenAI-compatible API. Set `--base-url` without the `/v1` suffix:

```bash
antseed config seller add-provider inference \
  --plugin openai \
  --base-url https://api.example-inference.com
```

Local model server. The default address is Ollama's, `http://localhost:11434`:

```bash
antseed config seller add-provider ollama --plugin local-llm
```

For a server on another address, add `--base-url http://localhost:8080` (for example llama.cpp).

## Step 4: Add services and prices

Add one service per model. Prices are USD per million tokens. `--upstream` is the model id the upstream expects; omit it when it matches the service id.

```bash
antseed config seller add-service inference kimi-k2.6 \
  --upstream "<upstream-model-id>" \
  --input 0.6 --cached 0.06 --output 2.5 \
  --categories coding
```

A free local model:

```bash
antseed config seller add-service ollama <model-id> --input 0 --output 0
```

To change a price later, use `seller settings set --price`. It handles service ids with dots, such as `kimi-k2.6`, correctly:

```bash
antseed seller settings set --price kimi-k2.6=0.7/2.2/0.07
```

The format is `[provider/]model=input/output[/cached]`. Name the provider when two providers offer the same model. On `@antseed/cli` 0.1.234 and earlier, don't set prices with `antseed config seller set ...` on a service id that contains a dot. Those versions read the dot as a path separator: the command can report success while writing a stray entry (`kimi-k2` with a key `6`) and leaving the real price unchanged. Later versions keep an existing service id whole and refuse a key that doesn't resolve.

## Step 5: Set how many buyers to serve at once

The seller accepts up to 50 concurrent buyers by default. Lower it to what the upstream can handle. For a local model on one machine, start with 1:

```bash
antseed seller settings set --max-buyers 1
```

Then check the config:

```bash
antseed config seller show
```

Every provider should have at least one service, with the prices you set.

**Stop here and confirm with the user** before Step 6.

## Step 6: Fund and register (needs ETH)

Ask the user to send ETH on Base to the wallet address from Step 2 (see "What needs money" above). When they confirm, register:

```bash
antseed seller register
antseed seller status
```

`seller status` should show `Seller eligible` as `true`. Registration is all a seller needs; staking is optional (`antseed seller stake <ants> --epochs <n>`, which needs ANTS).

## Step 7: Make the seller reachable

Buyers connect on UDP 6881 (DHT) and TCP 6882. The user must open both on their firewall or router. Then set the public address buyers dial:

```bash
antseed config seller set publicAddress "<public-host-or-ip>:6882"
```

Don't run `antseed seller doctor` yet. It opens a TCP connection to this address, and nothing listens on port 6882 until the seller starts, so before Step 8 it always fails, even when the firewall and port forwarding are right.

**Stop and confirm with the user** before Step 8: starting the seller announces it to the public network.

## Step 8: Start the seller (announces publicly)

Credentials come from the environment, everything else from `~/.antseed/config.json`:

```bash
export OPENAI_API_KEY=<upstream-key>    # or ANTHROPIC_API_KEY; none for local-llm
antseed seller start
```

`seller start` runs pre-flight checks first: a service on every provider, ETH for gas, and registration. If one fails, it prints what is missing and the command that fixes it. Once running it prints `Seeding active` and the peer ID, and serves a local dashboard at `http://127.0.0.1:3120`.

To check what the seller announces, from the same machine:

```bash
curl -s http://localhost:6882/metadata
```

The response lists each provider's `services`, `servicePricing` and `maxConcurrency`.

Then check reachability. Keep `seller start` running, and from a second terminal on the same machine:

```bash
antseed seller doctor
```

It checks that the announced address is public and opens a TCP connection to it, and exits 1 if either fails. A successful local probe doesn't prove the port is open from outside, so confirm from another network with `antseed network peer <peer-id>`.

## After it's running

```bash
antseed seller logs        # request log
antseed seller usage       # requests, tokens and revenue per day
antseed seller rewards     # pending ANTS rewards
antseed seller rewards claim
```

## Troubleshooting

- **`Invalid seller config key`**: the key doesn't exist. Use `add-service` and `seller settings set` from Steps 4 and 5 instead of `config seller set`.
- **`insufficient funds for intrinsic transaction cost`** on register: the wallet needs ETH on Base. The `want` value in the error is the amount in wei.
- **`seller.publicAddress is empty`**: do Step 7.
- **Buyers can't reach the seller**: `seller doctor` passing locally doesn't prove the ports are open from outside. Check from another network with `antseed network peer <peer-id>`.
