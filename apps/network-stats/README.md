# @antseed/network-stats

Standalone service that polls the Antseed network as an anonymous buyer and exposes live peer/model stats over HTTP.

## What it does

- Connects to the network via DHT discovery every 15 minutes
- Keeps each discovered peer's signed metadata (`PeerMetadata`), dropping peers not announced in the last 2 hours
- Caches the result to `cache/network.json`
- When the chain has a stats contract, indexes its `MetadataRecorded` events (settlement metadata) into SQLite and adds on-chain totals per seller and for the network
- Exposes a simple Express API for XHR consumption by the website

## API

```
GET /stats   →  { peers: PeerMetadata[], updatedAt: string }
GET /health  →  { ok: true }
```

With the stats indexer on (a stats contract and a staking contract are configured for the chain), `/stats` returns more:

```
GET /stats   →  {
  peers: (PeerMetadata & { onChainStats: { agentId, totalRequests, totalInputTokens, totalOutputTokens, settlementCount, uniqueBuyers, uniqueChannels, ... } | null })[],
  updatedAt: string,
  totals: { totalRequests, totalInputTokens, totalOutputTokens, settlementCount, sellerCount, lastUpdatedAt },
  indexer?: { lastBlock, lastBlockTimestamp, latestBlock?, synced? }
}
```

`onChainStats` is `null` for a peer with no staked agent id or no settlements yet. Token and request counts are decimal strings.

## Usage

```bash
pnpm install
pnpm build
pnpm start
```

Environment variables:

| Variable     | Default | Description                        |
|--------------|---------|------------------------------------|
| `PORT`       | `4000`  | HTTP port to listen on             |
| `CACHE_PATH` | `cache/network.json` | Path to write JSON cache |
| `NETWORK_STATS_CHAIN_ID` | `base-mainnet` | Chain whose stats contract is indexed |
| `NETWORK_STATS_DB_PATH` | `data/network-stats.sqlite` | SQLite database for the indexer |
| `NETWORK_STATS_RPC_URL` | chain default | RPC endpoint override |
| `NETWORK_STATS_TICK_INTERVAL_MS` | `60000` | Indexer poll interval |
| `NETWORK_STATS_MAX_BLOCKS_PER_TICK` | `2000` | Blocks read per indexer tick |

## Development

```bash
pnpm build
pnpm test
```
