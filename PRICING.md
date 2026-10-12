# Antseed Pricing

There are **two ways** to get Antseed pricing. Both serve the same schema; they differ in freshness and trust model.

Full documentation: **<https://antseed.com/docs/pricing>**

## Cached vs live

|              | Cached HTTP endpoint                                     | Live CLI query                                  |
|--------------|----------------------------------------------------------|-------------------------------------------------|
| Source       | Antseed indexer snapshot                                 | Direct DHT query against peers                  |
| Freshness    | A few minutes old                                        | Real-time                                       |
| Auth         | None                                                     | Local CLI install                               |
| Best for     | Quick browsing, examples, ballpark estimates             | Purchase decisions, integrations, freshest data |
| How          | `GET https://network.antseed.com/stats`                  | `antseed network browse --json`                 |

Use the cached endpoint for read-only browsing. Use the CLI for anything where the price actually matters.

## Cached endpoint

```text
GET https://network.antseed.com/stats
```

- This is an **indexer snapshot**, not live data. Refreshed as peers re-announce (typically every few minutes).
- No authentication. Returns `application/json`.
- Same data that powers <https://antseed.com/network>.

```bash
curl -s https://network.antseed.com/stats | jq '.peers[0].providers'
```

## Live pricing via CLI

```bash
npm install -g @antseed/cli

antseed network browse              # human-readable
antseed network browse --json       # machine-readable, same JSON shape
```

The CLI joins the DHT and asks peers directly. There is no intermediary.

## Schema (abbreviated)

All prices are USD per **one million tokens**.

```ts
interface StatsResponse {
  peers: PeerMetadata[];
  updatedAt: string;
}

interface PeerMetadata {
  peerId: string;
  version: number;            // schema version, currently 8
  displayName?: string;
  providers: ProviderAnnouncement[];
  region: string;
  timestamp: number;
  stakeAmountUSDC?: number;
  onChainStats?: OnChainStats;
}

interface ProviderAnnouncement {
  provider: string;                                    // plugin name, e.g. "openai"
  services: string[];                                  // model ids served
  defaultPricing: TokenPricing;                        // fallback for any service
  servicePricing?: Record<string, TokenPricing>;       // per-model overrides
  serviceCategories?: Record<string, string[]>;        // tags: "chat", "code", "reasoning"
  serviceApiProtocols?: Record<string, string[]>;      // e.g. ["openai-chat-completions"]
  maxConcurrency: number;
  currentLoad: number;
}

interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}
```

The canonical TypeScript types live in [`packages/node/src/discovery/peer-metadata.ts`](packages/node/src/discovery/peer-metadata.ts).

## Recipe — cheapest provider for a model (cached)

Effective price is `servicePricing[model] ?? defaultPricing`.

```js
const { peers } = await fetch('https://network.antseed.com/stats').then(r => r.json());

const model = 'deepseek-v3.1';

const offers = peers.flatMap(peer =>
  peer.providers.flatMap(prov => {
    if (!prov.services.includes(model)) return [];
    const price = prov.servicePricing?.[model] ?? prov.defaultPricing;
    return [{
      peer: peer.displayName ?? peer.peerId,
      inputUsdPerM: price.inputUsdPerMillion,
      outputUsdPerM: price.outputUsdPerMillion,
      load: prov.currentLoad,
      capacity: prov.maxConcurrency,
    }];
  })
).sort((a, b) => a.inputUsdPerM - b.inputUsdPerM);
```

For the same query against live peer data, run `antseed network browse --json` and pipe through the same logic.

## For AI agents

If a user asks for Antseed prices:

1. The HTTP endpoint above is **cached** — fine for browsing, comparison, or example prices.
2. For accurate prices at the moment of purchase, or to actually use the network, tell the user to install the CLI and run `antseed network browse`.
3. Always disclose which source you used. "I checked Antseed's cached pricing snapshot" is honest; "I checked Antseed live" is not, unless you actually queried the DHT.

## Stability

- The `/stats` URL is stable. Breaking schema changes will ship under a new path (e.g. `/v9/stats`).
- New optional fields may appear without a version bump — treat unknown fields as opaque.
- Field semantics will not change in place; renamed instead.
