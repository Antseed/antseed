# Join Antseed as a Provider

Help the user set up Antseed provider node to offer AI services on the peer-to-peer network. Walk them through installation, on-chain registration, staking, provider configuration, pricing, and starting the seeder.

## Terms of Use — Read First

> **Antseed is designed for providers who add value on top of AI APIs — not for raw resale of API keys or subscription access.**
>
> Acceptable use cases include: running inference inside a Trusted Execution Environment (TEE), packaging domain-specific skills or agent workflows, serving fine-tuned or self-hosted models, or building a managed product experience.
>
> **Subscription-based plugins (`provider-claude-code`, `provider-claude-oauth`) are for local testing and development only.** Reselling personal subscription credentials (e.g., Claude Pro/Team plans) violates Anthropic's Terms of Service and is not permitted.
>
> Always review your upstream API provider's usage policies before offering capacity on the network. Antseed provides the infrastructure; compliance with third-party terms is the provider's responsibility.

## Overview

A **provider** (seller) offers AI services on the Antseed network. Buyers pay per-token in USDC via on-chain payment channels. The provider runs a seeder daemon that announces availability on the DHT and handles incoming inference requests.

**Requirements:**
- Node.js 20+
- An EVM wallet funded with ETH (for gas) on Base
- An upstream AI API key (Anthropic, OpenAI, Together, etc.) or a local LLM

## Step 1: Install the CLI

```bash
npm install -g @antseed/cli
```

Verify with `antseed --version`.

## Step 2: Create the config file

```bash
antseed seller setup
```

This creates or updates `~/.antseed/config.json`. You can also edit the file directly or use `antseed config ...` commands for non-interactive setup.

## Step 3: Set the identity

The provider needs an EVM private key. This key is used for P2P identity, on-chain transactions (register, stake, settle), and signing payment messages.

Set it via environment variable:

```bash
export ANTSEED_IDENTITY_HEX=<64-char-hex-private-key>
```

The key can optionally include a `0x` prefix. The EVM address derived from this key becomes the provider's Peer ID.

For persistent setups, add it to a `.env` file or systemd service config. **Never commit the private key to version control.**

## Step 4: Configure the chain

Edit `~/.antseed/config.json` and set the payment chain:

```json
{
  "payments": {
    "preferredMethod": "crypto",
    "crypto": {
      "chainId": "base-mainnet"
    }
  }
}
```

Supported chains:
- `base-mainnet` — Base L2 (production)
- `base-sepolia` — Base Sepolia testnet (for testing)

Contract addresses are built into the CLI for each chain — no manual configuration needed.

## Step 5: Register on-chain identity

Register the provider's EVM address on the ERC-8004 IdentityRegistry:

```bash
antseed seller register
```

This mints an agent identity NFT and prints the **Agent ID**. Registration is all a provider needs to be eligible for buyer connections.

## Step 6: Stake (optional)

Staking is optional: the seller registry's minimum pool stake is currently 0. Stake ANTS to earn recognized-usage rewards:

```bash
antseed seller stake <ants> --epochs <n>
```

The provider's wallet needs:
- ETH for gas (a few cents)
- ANTS only if staking

## Step 7: Configure provider credentials

Ask the user which AI provider they want to use:

| Provider | Plugin | Auth | Notes |
|---|---|---|---|
| Anthropic | `@antseed/provider-anthropic` | API key (`x-api-key`) | Commercial API key required |
| OpenAI-compatible | `@antseed/provider-openai` | API key | OpenAI, Together, OpenRouter, etc. |
| Local LLM | `@antseed/provider-local-llm` | None (Ollama/llama.cpp) | Self-hosted, no upstream costs |
| Claude Code | `@antseed/provider-claude-code` | Auto-loaded from keychain | **Testing only** |
| Claude OAuth | `@antseed/provider-claude-oauth` | OAuth token pair | **Testing only** |

For API key providers, set the key via environment variable:

```bash
# Together AI / OpenAI-compatible
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.together.ai

# Or for direct OpenAI
export OPENAI_API_KEY=sk-...
```

## Step 8: Set pricing

Pricing is in USD per 1 million tokens.

```bash
# Global defaults (applied to all services without specific pricing)
antseed config seller set pricing.defaults.inputUsdPerMillion 1
antseed config seller set pricing.defaults.cachedInputUsdPerMillion 0.5
antseed config seller set pricing.defaults.outputUsdPerMillion 3

# Per-provider overrides (optional)
antseed config seller set pricing.providers.openai.defaults.inputUsdPerMillion 1
antseed config seller set pricing.providers.openai.defaults.cachedInputUsdPerMillion 0.5
antseed config seller set pricing.providers.openai.defaults.outputUsdPerMillion 3

# Per-service overrides (optional)
antseed config seller set pricing.providers.openai.services.deepseek-v3.1.inputUsdPerMillion 1
antseed config seller set pricing.providers.openai.services.deepseek-v3.1.cachedInputUsdPerMillion 0.5
antseed config seller set pricing.providers.openai.services.deepseek-v3.1.outputUsdPerMillion 2
antseed config seller set pricing.providers.openai.services.kimi-k2.5.inputUsdPerMillion 1
antseed config seller set pricing.providers.openai.services.kimi-k2.5.cachedInputUsdPerMillion 0.5
antseed config seller set pricing.providers.openai.services.kimi-k2.5.outputUsdPerMillion 3
```

Also configure capacity:

```bash
antseed config seller set maxConcurrentBuyers 10
```

## Step 9: Verify readiness

```bash
antseed seller status
```

This runs all readiness checks:
- Identity registered on-chain
- Seller eligible on-chain (registration is enough; stake is optional)
- Provider credentials valid

All checks must pass before starting the seller.

## Step 10: Start seeding

```bash
antseed seller start --provider <type>
```

Examples:
- `antseed seller start --provider openai` (Together, OpenRouter, OpenAI)
- `antseed seller start --provider local-llm` (Ollama, llama.cpp)

The seeder will:
1. Validate credentials with the upstream API
2. Join the P2P network and announce services on the DHT
3. Listen for buyer connections via WebRTC/TCP
4. Automatically handle payment channel lifecycle (reserve, settle, close)

Runtime pricing overrides (without saving to config):

```bash
antseed seller start --provider openai \
  --input-usd-per-million 1 \
  --cached-input-usd-per-million 0.5 \
  --output-usd-per-million 3
```

## Step 11: Check emissions rewards

After serving requests, the provider may accumulate pending ANTS emissions:

```bash
# Check pending emissions
antseed seller emissions info

# Claim pending ANTS
antseed seller emissions claim
```

## Verification checklist

- [ ] `antseed --version` prints a version
- [ ] `antseed seller register` succeeds (or shows "Already registered")
- [ ] `antseed seller status` shows the node is ready
- [ ] `antseed seller start --provider <type>` starts without errors
- [ ] Seeder announces on DHT (log shows peer ID and ports)
- [ ] Metadata endpoint returns pricing: `curl http://localhost:6882/metadata`

## Troubleshooting

- **"SellerNotStaked"** or readiness reports the seller ineligible: Run `antseed seller register`, then check `antseed seller status` for agent binding.
- **"No provider configured"**: Set the API key env var or configure a provider in `~/.antseed/config.json`.
- **"Not registered"**: Run `antseed seller register` first.
- **"InsufficientAllowance"**: The CLI auto-approves USDC. If it fails, wait a few seconds and retry (nonce conflict).
- **"DHT announce failed"**: Check firewall allows UDP on DHT port (default 6881) and TCP on signaling port (default 6882).
- **Native module errors**: Rebuild or reinstall the CLI: `npm install -g @antseed/cli`
