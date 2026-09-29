# Antseed CLI + Dashboard

Command-line interface and web dashboard for the AntSeed Network — a P2P network for AI services.

> **Important:** AntSeed is designed for providers who build differentiated services on top of AI APIs — such as TEE-secured inference, domain-specific skills and agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service. Subscription-based plugins (`provider-claude-code`, `provider-claude-oauth`) are for testing and development only.

## Commands

| Command | Description |
|---------|-------------|
| **Setup** | |
| `antseed seller setup` | Interactive seller onboarding |
| **Providing** | |
| `antseed seller start` | Start providing AI services on the P2P network |
| `antseed seller register` | Register peer identity on-chain (ERC-8004) |
| `antseed seller stake <ants> --epochs <n>` | Optional: stake ANTS into your seller pool; never stakes USDC |
| `antseed seller legacy stake <amount>` | Stake USDC as a provider before cutover (min $10) |
| `antseed seller legacy unstake` | Withdraw legacy USDC stake |
| `antseed seller legacy claim-starter` | Claim the legacy-seller starter ANTS position after the recognized-usage upgrade |
| `antseed seller pool positions` | List seller-pool positions and lifecycle state |
| `antseed seller pool withdraw <id...> [--accept-slashing]` | Withdraw positions, with a slashing estimate and confirmation for early exits |
| `antseed seller rewards [claim]` | View or claim all seller rewards |
| **ANTS staking** | |
| `antseed ants` | Open the local ANTS staking dashboard; the connected browser wallet is the acting account (`--port`, `--no-open`) |
| `antseed ants --address 0x...` | Pin the dashboard to one account. Transactions require that account's browser wallet, or its authorized operator for buyer actions. Does not use the local wallet. |
| `antseed ants status` | Protocol phase, epoch countdown, balances, stake, claimable rewards |
| `antseed ants stake <ants> --agent <id> --epochs <n>` | Stake ANTS into any registered seller pool |
| `antseed ants positions` | List open lANTS positions with state, pending rewards, and exit slash |
| `antseed ants move <id...> --to <agent>` | Move positions to another pool (terms preserved, effective next epoch) |
| `antseed ants split <id> <ants>` / `merge <id...>` | Split a position or merge same-pool positions |
| `antseed ants extend <id> --epochs <n>` / `max-lock <id> [--off]` | Extend a lock or toggle max lock |
| `antseed ants withdraw <id...> [--preview] [--accept-slashing]` | Withdraw with a slashing estimate and explicit consent for early exits |
| `antseed ants rewards [claim\|compound\|restake\|stake-usage]` | View, claim, or restake rewards; `compound` restakes every restakable bucket in one go |
| `antseed ants pools` / `pool <agent>` | Compare pools: power and share of network, settled volume per epoch, staker ANTS per 1k power (last and projected), your power and share; explorer names via Antscan |
| `antseed ants usage` / `emissions` / `addresses` | Usage points per epoch, emission schedule and buckets, contract addresses |
| `antseed ants seller [register\|claim-starter]` | Seller binding, eligibility, and starter grant |
| `antseed ants verify [seller]` / `verify submit <artifact.json>` / `verify proof <id>` | Wash-trading status, resumable proof submission, proof progress |
| **Buying** | |
| `antseed buyer start` | Start the buyer proxy and connect to sellers |
| `antseed buyer start --router <name>` | Start the buyer proxy with a non-default router |
| `antseed buyer deposit` | Show your funding address + QR; incoming USDC deposits automatically (gasless) |
| `antseed buyer sweep` | Manually sweep hot-wallet USDC into deposits (gasless) |
| `antseed buyer activity` | Activity summary: tokens, spend history, savings, channels, claimable ANTS |
| `antseed buyer deposit --onchain <usdc>` | Direct on-chain deposit from the hot wallet (requires ETH for gas) |
| `antseed buyer withdraw <amount>` | Withdraw USDC from deposits |
| `antseed buyer set-authorized-wallet [--self]` | Authorize an external wallet in the browser, or authorize the buyer wallet itself |
| `antseed buyer balance` | Check wallet and deposit balance |
| `antseed network browse` | Browse peers, models, and pricing (same catalog as `/v1/models`) |
| **Session** | |
| `antseed buyer connection get` | Show current session state (pinned service, peer) |
| `antseed buyer connection set` | Update service/peer overrides on a running proxy |
| `antseed buyer connection clear` | Clear service/peer overrides |
| **Management** | |
| `antseed seller status` | Show seller status |
| `antseed buyer status` | Show buyer status |
| `antseed config` | Manage configuration |
| `antseed profile` | Manage your peer profile |
| `antseed peer <peerId>` | Show a peer's profile (lightweight) |
| `antseed network peer <peerId>` | Show full peer details (providers, services, on-chain stats) |
| `antseed dashboard` | Start the web dashboard |
| `antseed metrics serve` | Serve Prometheus metrics for buyers and sellers |
| `antseed buyer channels` | List payment channels |
| `antseed dev` | Run seller + buyer locally for testing |
| `antseed network bootstrap` | Run a dedicated DHT bootstrap node |

## Configuration Workflow

The normal workflow is:

1. Create or update `~/.antseed/config.json` with `antseed seller setup` or `antseed config ...`
2. Keep non-secret settings there: providers, services, pricing, categories, `baseUrl`, ports
3. Keep secrets in environment variables: API keys and `ANTSEED_IDENTITY_HEX`
4. Start later with `antseed seller start` or `antseed buyer start`

Once your config file exists, the usual seller flow is just:

```bash
export OPENAI_API_KEY=sk-...
export ANTSEED_IDENTITY_HEX=<your-identity-key>
# Recommended for production sellers: use a dedicated Base RPC endpoint
export ANTSEED_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key>
antseed seller start
```

`config.json` is the durable source of truth. Env vars are for secrets and one-off overrides.

### Buyer state isolation

Buyer runtime state lives in the data directory, not just in the config file. By default that directory is `~/.antseed`, which contains `buyer.state.json`, SQLite databases, payment-channel state, and the fallback `identity.key`.

Use a separate data directory for each independent buyer node, service integration, test run, or concurrent process:

```bash
export BUYDIR="$HOME/.antseed-buyer-myapp"
mkdir -p "$BUYDIR"

ANTSEED_DATA_DIR="$BUYDIR" \
antseed --data-dir "$BUYDIR" buyer start \
  --peer <peer-id> \
  --port 8380
```

Notes:

- `--data-dir <path>` is the most explicit option and is recommended in service managers such as systemd.
- `ANTSEED_DATA_DIR=<path>` is the environment-variable equivalent for scripts and wrappers.
- Do not reuse the same buyer data directory across concurrent buyer processes.
- If behavior looks stale or unexpected, confirm which `buyer.state.json` and SQLite files the process logged at startup.
- `ANTSEED_HOME` is not the buyer state-isolation knob for the CLI; use `--data-dir` or `ANTSEED_DATA_DIR`.

## Plugins

Antseed uses an open plugin ecosystem. Provider and router plugins are installed into `~/.antseed/plugins/` via npm.

**Providers** connect your node to an upstream AI API (seeder mode):

```bash
antseed config seller add-provider anthropic --plugin anthropic
antseed config seller add-service anthropic claude-sonnet-4-5-20250929 \
  --input 12 --output 18 --cached 6 \
  --categories coding,chat
antseed seller start
```

Per-service capability hints and non-token billing are durable config fields:

```bash
antseed config seller add-service openai gpt-image-1 \
  --input 0 --output 0 \
  --capabilities '{"inputs":["text","image"]}' \
  --unit-billing-models '{"openai-images":{"version":1,"components":[{"unit":"output_images","priceUsd":0.04}]}}'
```

`--unit-billing-models` is currently consumed by the `openai` provider for `openai-images`. Seller startup warns when the selected plugin ignores it. Image services are skipped by periodic model health checks to avoid generating billable probe images.

Services whose token and unit prices are all zero are unlimited unless the seller configures a persistent free tier, keyed by buyer address, remote IP, or both:

```bash
antseed config seller set freeTier.maxRequestsPerAddress 100
antseed config seller set freeTier.maxRequestsPerIp 300
antseed config seller set freeTier.windowMs 86400000
```

This allows each authenticated buyer address 100 requests, and each remote IP 300 requests, across all fully zero-priced services in a sliding 24-hour window. A request is served only while every configured limit still has headroom. Reconnects and seller restarts do not reset the counters. Exhausted buyers receive HTTP 429 with `free_tier_exhausted` and a `limitedBy` field (`address` or `ip`); paid services are unaffected. The address limit alone can be bypassed by creating another identity; the IP limit (IPv6 grouped by /64) closes that gap at the cost of sharing the allowance between users behind one NAT, so set it higher than the per-address limit.

**Routers** select peers and proxy requests (consumer mode):

```bash
antseed buyer start
```

## Configuration

Configuration is stored at `~/.antseed/config.json` by default. Use `-c` / `--config` to specify an alternative path.

Runtime env variables are loaded via `dotenv` from `.env.local` and `.env` in the current working directory.
See `.env.example` for supported keys.

Enable debug logs with either:

```bash
antseed -v <command>
```

or:

```bash
ANTSEED_DEBUG=1 antseed <command>
```

Filter debug logs by source or text with:

```bash
antseed buyer start --log-filter ProxyMux
ANTSEED_LOG_FILTER=PaymentMux,BuyerPayment ANTSEED_DEBUG=1 antseed buyer start
```

For dashboard frontend debug logging, set:

```bash
VITE_ANTSEED_DEBUG=1
```

Pricing is configured in USD per 1M tokens with role-specific defaults and optional provider/service overrides. You can also set node `displayName`, an optional seller `publicAddress`, and per-service category tags announced in discovery metadata:

```json
{
  "identity": {
    "displayName": "Acme Inference - us-east-1"
  },
  "seller": {
    "publicAddress": "peer.example.com:6882",
    "maxUploadBodyBytes": 134217728,
    "freeTier": {
      "maxRequestsPerAddress": 100,
      "maxRequestsPerIp": 300,
      "windowMs": 86400000
    },
    "providers": {
      "anthropic": {
        "plugin": "anthropic",
        "defaults": {
          "inputUsdPerMillion": 10,
          "outputUsdPerMillion": 10,
          "cachedInputUsdPerMillion": 5
        },
        "services": {
          "claude-sonnet-4-5-20250929": {
            "upstreamModel": "claude-sonnet-4-5-20250929",
            "categories": ["coding", "chat"],
            "pricing": {
              "inputUsdPerMillion": 12,
              "outputUsdPerMillion": 18,
              "cachedInputUsdPerMillion": 6
            }
          }
        }
      }
    }
  },
  "buyer": {
    "maxPricing": {
      "defaults": {
        "inputUsdPerMillion": 100,
        "cachedInputUsdPerMillion": 50,
        "outputUsdPerMillion": 100
      }
    },
    "proxyPort": 8377,
    "peerRefreshIntervalMs": 300000,
    "metadataFetchTimeoutMs": 1500,
    "disableMetadataV2Services": false
  }
}
```

Service categories are normalized to lowercase tags. Recommended normie-friendly tags include: `chat`, `coding`, `math`, `study`, `creative`, `writing`, `tasks`, `fast`, `free`, `translate` (custom tags are also allowed).

The set of keys under `seller.providers.<name>.services` determines which services this peer announces on the network — there's no separate allow-list.

### Ant Agent

Providers can wrap their service with an ant agent — a read-only, knowledge-augmented AI service that injects a persona, guardrails, and on-demand loaded knowledge into buyer requests.

```json
{
  "seller": {
    "agentDir": "./my-agent"
  }
}
```

The agent directory contains an `agent.json` manifest that defines the agent's persona, guardrails, and knowledge modules. Knowledge modules are loaded on demand via the `antseed_load_knowledge` tool — the LLM decides which modules to load during the conversation and only relevant knowledge is brought into context. Buyers only see the LLM's natural response, never the injected content or internal tool calls.

See the [`@antseed/ant-agent` README](../../packages/ant-agent/README.md) for the full manifest reference and directory structure.

Role-first config examples:

```bash
# Identity / metadata display name
antseed config set identity.displayName "Acme Inference - us-east-1"

# Add a provider and then a service
antseed config seller add-provider anthropic --plugin anthropic --input 12 --output 18
antseed config seller add-service anthropic claude-sonnet-4-5-20250929 \
  --upstream "claude-sonnet-4-5-20250929" \
  --input 12 --output 18 --cached 6 \
  --categories coding,chat

# Remove a service
antseed config seller remove-service anthropic claude-sonnet-4-5-20250929

# Fine-grained edits to a service already in the config (auto-creates
# intermediate objects; --dynamic paths under seller.providers.* are allowed)
antseed config seller set providers.anthropic.defaults.inputUsdPerMillion 12
antseed config seller set providers.anthropic.services.claude-sonnet-4-5-20250929.pricing.outputUsdPerMillion 20
antseed config seller set providers.anthropic.services.claude-sonnet-4-5-20250929.categories '["coding","legal"]'
antseed config seller set providers.anthropic.services.claude-sonnet-4-5-20250929.capabilities '{"contextWindow":200000,"inputs":["text","image"],"toolUse":true}'

# Seller public address override for load-balanced deployments
antseed config seller set publicAddress "peer.example.com:6882"

# Raise the seller per-request upload cap (bytes) for large Codex-style payloads
antseed config seller set maxUploadBodyBytes 134217728

# Cap zero-priced services per authenticated buyer address and per remote IP
antseed config seller set freeTier.maxRequestsPerAddress 100
antseed config seller set freeTier.maxRequestsPerIp 300
antseed config seller set freeTier.windowMs 86400000

# Buyer max pricing, DHT peer refresh cadence, and metadata fetch timeout
antseed config buyer set maxPricing.defaults.inputUsdPerMillion 25
antseed config buyer set maxPricing.defaults.cachedInputUsdPerMillion 12
antseed config buyer set maxPricing.defaults.outputUsdPerMillion 75
antseed config buyer set routingPreferences.minTrustScore 60
antseed config buyer set routingPreferences.maxInputUsdPerMillion 25
antseed config buyer set peerRefreshIntervalMs 300000
antseed config buyer set metadataFetchTimeoutMs 1500
antseed config buyer set disableMetadataV2Services true
```

Runtime-only overrides (do not write your config file):

```bash
antseed seller start --provider anthropic --input-usd-per-million 10 --cached-input-usd-per-million 5 --output-usd-per-million 30
antseed seller start --base-rpc-url https://base-mainnet.infura.io/v3/<key>
antseed buyer start --max-input-usd-per-million 20 --max-cached-input-usd-per-million 10 --max-output-usd-per-million 60
antseed buyer start --metadata-fetch-timeout-ms 1500
antseed buyer start --disable-metadata-v2-services
```

For production sellers, prefer a dedicated Base JSON-RPC endpoint over public defaults. You can set it durably with `payments.crypto.rpcUrl`, at runtime with `ANTSEED_BASE_RPC_URL`, or for one run with `antseed seller start --base-rpc-url <url>`.

### Metadata v12 rollout

This release announces metadata v12. Buyers supporting only older metadata versions drop v12 sellers from discovery, while updated buyers continue accepting older v10/v11 sellers. Upgrade buyer CLIs and desktop apps before upgrading sellers. Removing capability or unit-billing fields does not downgrade the metadata version; rollback requires running the older seller binary.

### Model-only routing and peer pinning

Pinning a peer is optional. A request that names only a model uses the shared
Price + Trust ranking configured under `buyer.routingPreferences`. The default
`minTrustScore` is `60` and acts as a hard eligibility gate; eligible offers are
ordered using trust, token or image price, cached-input pricing coverage, recent
failures, cooldowns, free-peer preference, and seller access rules. Model-only
requests can fail over on peer-attributed retryable errors.

Discover what the network serves without any pin:

```bash
# Every model on the network, aggregated across sellers (answered locally)
curl -s http://localhost:8377/v1/models | jq '.data[].id'

# Filter the list by modality, or inspect one unified model and its ranked offers
curl -s 'http://localhost:8377/v1/models?type=text'
curl -s 'http://localhost:8377/v1/models?type=images'
curl -s 'http://localhost:8377/v1/models?type=decisions'
curl -s http://localhost:8377/v1/models/<model-id>

# Peers, pricing, protocols, capabilities, and reputation
antseed network browse
```

`GET /v1/models` is network-wide and groups compatible aliases. Duplicate
offers from one seller collapse to its cheapest matching service. For recognized
conversations, the first successful automatic route becomes a soft affinity:
later turns prefer the same seller and service while they remain healthy and
policy-eligible, but can still fail over. Explicit pins remain hard.

When you do want to force a specific seller, pin it. After `antseed buyer
start` is running, you can pin all subsequent requests to a peer without
restarting:

```bash
# Pin all requests to a specific peer (bypasses router for peer selection)
antseed buyer connection set --peer <40-char-hex-peer-id>

# Check current session state
antseed buyer connection get

# Clear the session pin
antseed buyer connection clear
```

Session peer pins are stored in `~/.antseed/buyer.state.json`, survive proxy restarts, and are picked up by the running proxy immediately via file-watching. The desktop app reads and writes the same file to expose explicit peer selection in its UI.

For tools that can only set a model name, use `<peerId>@<model>` as the model. The proxy strips the peer prefix before provider matching and forwards only `<model>` to the seller. If both this model prefix and `x-antseed-pin-peer` are sent, the header selects the peer and the model prefix is still stripped.

## Payments

Payments run on **Base Mainnet** by default. Contract addresses are resolved automatically — no manual configuration needed.

**Protocol start: September 10, 2026 at 09:54:21 UTC (epoch 22).**
See [Recognized Usage and ANTS Rewards](../website/docs/protocol/recognized-usage.md)
for ANTS pool positions, seller eligibility, and usage rewards. The SDK exposes
the contract inventory as `getChainConfig('base-mainnet').recognizedUsage`.
See [Reward Policies](../website/docs/protocol/reward-policies.md) for how usage
points are adjusted and historical wash-trading evidence affects rewards.

Looking for pre-migration USDC staking or rewards? See
[Legacy emissions and claims](../website/docs/protocol/legacy-emissions.md).
The setup commands below use that legacy USDC interface; they do not create
ANTS pool positions.

### ANTS Staking Dashboard and Commands

`antseed ants` starts a local dashboard on `http://127.0.0.1:3119` and opens it
in your browser. Browse pools before connecting; once you connect a browser
wallet it becomes the acting account for staking, positions and seller
actions, and every transaction is approved in that wallet. The dashboard binds
to localhost only and requires the one-time session token embedded in the URL
it prints, so no other page can act with your wallet. Pass `--no-open` to
print the URL only, or `--port` to change the port. Buyer rewards follow the
connected wallet too: a wallet that is a buyer account in its own right sees
its own usage and legacy buyer rewards. If the wallet is instead the on-chain
authorized operator of the local identity's buyer account (the one in
`--data-dir`), that buyer account's rewards are shown, and the existing
payments flow can authorize such an operator.

`antseed ants --address 0x...` pins the dashboard to one account instead.
Seller and position actions then require that account's wallet, buyer reward
actions require its current deposits operator, and switching browser wallets
does not change the pinned account. It does not use the local wallet, load or
create a local identity, or offer the local authorization flow. Buyer rewards
and positions created by staking them belong to the authorized operator; pin
the operator's address to manage those positions.

Pool statistics, volume history, and closed positions come from the Antscan
indexer (`payments.crypto.explorerApiUrl`). Positions, personal pool totals, and
staking rewards share its paginated `/api/staking/positions?include=rewards`
response, including closed positions with unclaimed rewards. Power and status
are included by default; there is no separate live-mode request. Wallet totals
are calculated across all pages rather than treating page totals as wallet totals.
Claims and restaking still validate positions and amounts on-chain.

The configured Antscan deployment must include Antscan PR #8 and complete its
reward backfill. Stale or incomplete rewards appear as unavailable, not zero;
JSON reward amounts can be `null`. Live-state failures do not discard usable
indexed rewards. Position/personal-pool reads show an error instead of repeating
per-position RPC calls when the configured indexer is unavailable. An explicitly
unconfigured indexer retains direct chain reads for local setups.

During a dashboard session, confirmed transactions temporarily block older
position/reward snapshots until Antscan catches up. This marker is in memory,
not saved to disk or shared with later CLI invocations. After a restart, indexed
amounts remain estimates at the displayed source block, not transaction quotes.

Everything the dashboard does is also a command under `antseed ants`, so the
dashboard is optional:

```bash
antseed ants status                                   # phase, epoch countdown, balances, claimable rewards
antseed ants stake 250 --agent 84990 --epochs 12      # stake into a registered seller pool
antseed ants positions --json                         # positions, pending rewards, exit slash
antseed ants split 7 100 && antseed ants merge 8 9    # restructure (effective next epoch)
antseed ants move 7 --to 84991                        # move stake to another pool
antseed ants withdraw 7 --preview                     # slashing estimate before an early exit
antseed ants rewards && antseed ants rewards claim    # all buckets: staker, seller, buyer, legacy, locked
antseed ants rewards compound --epochs 8 --to 59096   # restake all rewards (bonus kept), move them into pool 59096
antseed ants verify submit seller-proof.json          # stage → authenticate chunks → finalize
```

Before the cutover (phase `deployed`) the commands read the deployed contracts
and can stake once ANTS transfers are enabled for your wallet; reward accounting
starts at the effective epoch. Buyer usage rewards are paid to the deposits
operator, so they are claimable here only when the node wallet is its own
operator. Loop-proof artifacts come from the `antseed-loop-proof` host
(`kind: antseed-wash-trading-seller-proof`); submission is resumable, so a
partially authenticated proof can be re-submitted with the same file.
The [staking guide](../website/docs/guides/staking.md) walks through the
dashboard tabs and how to read the pool table.

### Legacy USDC Provider Setup (Pre-Migration)

```bash
# 1. Set your identity (secp256k1 private key)
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 2. Fund your wallet with ETH (for gas) on Base Mainnet

# 3. Register your identity on-chain
antseed seller register

# 4. Optional: stake USDC (minimum $10 if you stake)
antseed seller legacy stake 10

# 5. Start providing
antseed seller start
```

Staking is optional: the seller registry's minimum pool stake is currently 0, so a registered seller can start without staking. After the M001 recognized-usage cutover, new seller stake moves from legacy USDC staking to ANTS seller pools:

```bash
antseed seller register
antseed seller legacy claim-starter
antseed seller stake 100 --epochs 4
antseed seller pool positions
antseed seller rewards
antseed seller rewards claim
```

`antseed seller stake <ants> --epochs <n>` always stakes ANTS and requires the recognized-usage upgrade. On older networks it stops without sending a transaction and directs you to `antseed seller legacy stake <usdc>`. New legacy USDC stakes are rejected after the upgrade. `antseed seller legacy unstake` withdraws legacy stake and warns that doing so can remove temporary eligibility before an ANTS position becomes active. `antseed seller legacy claim-starter` claims the starter position for an eligible legacy seller. `antseed seller rewards` combines legacy emissions, recognized-use emissions, and pool-staking rewards.

`seller register` explicitly binds your existing agent identity to the current seller registry, independently of legacy stake. Repeating it when already bound sends no transaction. If registration needs updating, `seller stake` stops and asks you to run `antseed seller register`; staking never registers you silently.

`seller rewards` is read-only: it calculates unclaimed rewards from completed epochs using existing contract getters, including pool earnings that have not yet been indexed. It does not sign transactions or spend gas. Pool previews use the same reward-index and position-segment rounding as the payout calculation. The pool contribution is read at a single block; amounts can change before a claim confirms. Historical position discovery includes withdrawn and closed positions using receipt burn events and may require an archive-capable RPC with historical log support. Read failures are reported rather than treated as zero rewards.

`seller rewards claim` prepares pool accounting in bounded transactions when necessary, then claims all eligible seller rewards to the current wallet. Preparation and claims require gas. Confirmed transaction hashes are printed immediately, and received amounts are read from ANTS transfer receipts. If a later step fails, the CLI reports partial completion; rerun the command to collect remaining rewards. Position-specific claims and alternate reward recipients are not exposed by this minimal command.

#### Command migration

These are intentional command-surface breaks, not hidden aliases:

| Removed command or behavior | Replacement |
|---|---|
| `seller stake <amount>` staking USDC | `seller legacy stake <usdc>` |
| `seller stake --agent-id <id>` | Bind the identity with `seller register --agent-id <id>` first, then stake ANTS without an identity override |
| `seller unstake` | `seller legacy unstake` |
| `seller pool claim-starter`, `seller pool bootstrap`, `seller pool init` | `seller legacy claim-starter` |
| `seller emissions info`, `seller pool rewards` | `seller rewards` |
| `seller emissions claim`, `seller pool rewards claim` | `seller rewards claim` (all eligible rewards to the current wallet; no era, position, or recipient flags) |
| `network contracts` | No replacement command; registry/address validation remains automatic inside payment commands |

Buyer emissions commands and their `--legacy-only` / `--new-only` filters are unchanged.

Early withdrawal requires `--accept-slashing` and interactive confirmation; add `--yes` for automation. The CLI rechecks the estimate before submitting. Existing contracts determine slashing at execution and do not accept a maximum-loss bound, so the displayed estimate is not a guaranteed cap if rates change before confirmation.

### M001 Anvil rehearsal

The repository includes a persistent Base-mainnet fork sandbox for exercising the exact pre-cutover and post-cutover CLI paths. It requires an archive-capable `BASE_MAINNET_RPC_URL` and an `ANTS_HOLDER` address with ANTS at the pinned fork block. Seller USDC is sourced from the forked legacy staking contract.

```bash
export BASE_MAINNET_RPC_URL=https://your-archive-base-rpc.example
export ANTS_HOLDER=0x...

pnpm m001:sandbox up
pnpm m001:sandbox status

# Use .m001-sandbox/cli-config.json with CLI commands before cutover.
pnpm m001:sandbox cutover
pnpm m001:sandbox advance-epoch 2
pnpm m001:sandbox fund-ants 0xYourCliWallet 100
pnpm m001:sandbox down
```

Use `--port <port>` and `--out <dir>` on each sandbox command to override the defaults (`8545` and `.m001-sandbox/`).

### Buyer Setup (Consuming)

```bash
# 1. Set your identity (secp256k1 private key)
export ANTSEED_IDENTITY_HEX=<your-private-key-hex>

# 2. Connect to the network
antseed buyer start
# Proxy listening on http://localhost:8377

# 3. Fund your node: shows your address + a QR code, then deposits incoming
#    USDC into your credits automatically (gasless — a relayer submits the
#    transaction for a fixed ~$0.05 USDC fee)
antseed buyer deposit
```

Point your AI tools (Claude Code, Codex, etc.) at `http://localhost:8377` as the API base URL. The router handles peer selection and failover transparently.

### Depositing USDC

`antseed buyer deposit` prints your node's funding address and a QR code (an EIP-681 payment request any mobile wallet can scan). Send USDC on Base to that address from anywhere — an exchange withdrawal, another wallet, a card on-ramp. Incoming funds are swept into your deposits balance gaslessly: your node signs an EIP-3009 authorization and a permissionless relayer submits the transaction for a fixed ~$0.05 USDC fee, so the hot wallet never needs ETH. While watching, the command also serves the connected-wallet checkout page and prints its link (`http://127.0.0.1:3118?token=…`) for depositing from a browser-extension wallet instead.

While `antseed buyer start` is running, this sweeping happens automatically in the background (disable with `buyer.autoSweep: false` in your config). `antseed buyer sweep` triggers the same gasless sweep manually, and `antseed buyer deposit --onchain <usdc>` remains for direct on-chain deposits from a hot wallet that holds ETH. (The `antseed payments` web portal is retired.)

### Set an authorized wallet

```bash
# Recommended: open the secure local page, connect an external wallet,
# and approve the transaction from that wallet.
antseed buyer set-authorized-wallet

# Print the secure local URL without opening the browser automatically.
antseed buyer set-authorized-wallet --no-open

# Alternatively, make the buyer hot wallet its own authorized wallet.
antseed buyer set-authorized-wallet --self

# Select the same buyer identity/config used for your deposits:
antseed --data-dir ~/.antseed-buyer --config ~/.antseed-buyer/config.json buyer set-authorized-wallet
```

By default, the command opens the same **Set authorized wallet** browser flow used by AI VPN. The local buyer identity signs the deposits contract's EIP-712 authorization, then the connected external wallet submits `setOperator` and pays ETH gas. The CLI prints the localhost URL as a fallback and waits for confirmation before shutting down the local server. Use `--no-open` to print the URL without launching the browser.

With `--self`, the CLI makes the buyer hot wallet its own authorized wallet. The buyer signs and submits the transaction, so it must have ETH on the configured chain. Both modes respect the selected data directory, identity environment override, and payment chain/contract configuration. The command does not accept an arbitrary address: connect an external wallet to prove control, or explicitly choose the buyer wallet with `--self`.

**The authorized wallet gains control of withdrawals and future authorization transfers.** Choose a wallet you control. Initial authorization is only possible when no authorized wallet is set. Self-authorization sends no transaction when the buyer wallet is already authorized and rejects replacement of a different existing wallet. Changing it later requires an operator-transfer transaction from the current authorized wallet, not the buyer identity.

`antseed buyer withdraw` still submits from the buyer identity. If you authorize an external wallet, withdraw from that wallet through AI VPN's payments UI (for the same buyer identity) or the deposits contract, not through the current CLI withdrawal command. To use CLI withdrawal, the buyer identity itself must be the authorized wallet. Setting an operator does not resolve other withdrawal constraints, such as reserved funds or insufficient available balance.


### Configuration

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

Use `base-sepolia` for testing with MockUSDC.

### Runtime Controls

- `ANTSEED_BASE_RPC_URL=<url>` — custom Base JSON-RPC endpoint for seller on-chain operations (recommended for production)
- `ANTSEED_COMPARABLE_PRICES_URL=<url>` — retail-prices models API for the `antseed buyer activity` Saved tile (OpenRouter-compatible schema, e.g. `https://openrouter.ai/api/v1/models`). Release builds ship with a baked-in default; set the variable to override it, or set it to an empty string to disable the savings baseline. Builds from source have no default
- `ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS=<ms>` — runtime override for buyer peer-discovery metadata fetch timeout
- `ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES=true` — suppress buyer per-service metadata v2 attribution while keeping aggregate usage totals
- `ANTSEED_SETTLEMENT_IDLE_MS=600000` — idle time before settling a session (default: 10 minutes)
- `ANTSEED_DEFAULT_DEPOSIT_USDC=1` — default lock amount per session
- `ANTSEED_IDENTITY_HEX=<hex>` — inject identity via env (supports 0x prefix)

Provider-specific options are configured via each plugin's config schema (see `antseed plugin add --help`).

## Metrics

Expose a Prometheus-compatible endpoint for a buyer or seller:

```bash
antseed --config ~/.antseed/config.json --data-dir ~/.antseed \
  metrics serve --role seller --host 0.0.0.0 --port 9108 --instance my-peer
```

Endpoints:

```text
/metrics
/healthz
/readyz
```

See [Metrics](../../apps/website/docs/guides/metrics.md) for metric names, labels, and operational notes.

## Development

Blockchain access and reward calculations live in `@antseed/node/payments`.
The CLI uses those SDK clients for registration, position discovery, reward
previews/claims, slashing estimates, and confirmed token receipts. Command
parsing, output, actionable instructions, and withdrawal confirmation stay in
the CLI; it has no direct `ethers` dependency.

```bash
npm install
npm run build
npm run dev
```

### Buyer TEE evidence cache

`src/proxy/tee-verification.ts` owns a TanStack Query Core `QueryClient` per
buyer session. CLI routing and Electron's verification control endpoint share
that buyer's cache; separate buyer processes do not share memory. Query Core
stores evidence and deduplicates in-flight checks, with keys containing the
seller ID, selected verifier, and advertised-verifier fingerprint. The renderer
does not need a new query client for this service.

Trust lifetimes remain explicit in the service: successful badge evidence lasts
up to 24 hours from check start, but routing evidence lasts only five minutes.
Transient outcomes are not reused, and each caller recomputes its routing
allowance from its own policy. Query freshness is not routing authorization.
Refreshes hide old success while checking; new failed or unavailable results
replace it. Capability changes, discovery removal, and buyer shutdown remove
queries and prevent late results from restoring evidence.

This headless client has no automatic retries or browser-connectivity pausing.
The service limits actual checks to eight and cached entries to 512, evicting
settled entries rather than pending checks. Timer-based garbage collection is
disabled; the entry bound and buyer lifecycle own cleanup instead. There is no
disk persistence and no per-inference-response proof in this cache.

## Links

- Node SDK: `@antseed/node` (`../node`)
