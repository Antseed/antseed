# Antseed Pricing

There are **two ways** to get Antseed pricing. They differ in freshness, trust model and JSON shape.

Full documentation: **<https://antseed.com/docs/api/routing>**

## Cached vs live

|              | Cached HTTP endpoint                                       | Live CLI query                                  |
|--------------|------------------------------------------------------------|-------------------------------------------------|
| Source       | Antscan, the Antseed explorer                              | Direct DHT query against peers                  |
| Freshness    | Minutes old (`collector.lastPollCompletedAt`)              | Real-time                                       |
| Auth         | None                                                       | Local CLI install                               |
| Best for     | Quick browsing, examples, ballpark estimates               | Purchase decisions, integrations, freshest data |
| How          | `GET https://antscan.co/api/marketplace?limit=5000`        | `antseed network browse --json`                 |

Use the cached endpoint for read-only browsing. Use the CLI for anything where the price actually matters.

## Cached endpoint

```text
GET https://antscan.co/api/marketplace?limit=5000
```

- This is a **snapshot**: Antscan walks the DHT on a schedule and lists every live offering it finds. `collector.lastPollCompletedAt` says when it last did.
- No authentication, CORS `*`. Returns `application/json`.
- `limit` caps the list (250 by default, 5000 at most); there is no paging.
- Same data that powers <https://antseed.com/network> and <https://antscan.co>.

```bash
curl -s 'https://antscan.co/api/marketplace?limit=5000' | jq '.offerings[0]'
```

## Live pricing via CLI

```bash
npm install -g @antseed/cli

antseed network browse              # human-readable
antseed network browse --json       # machine-readable
```

The CLI joins the DHT and asks peers directly. There is no intermediary. Its JSON has its own shape (see the [routing docs](https://antseed.com/docs/api/routing)).

## Schema (abbreviated)

Token prices are USD per **one million tokens**.

```ts
interface MarketplaceResponse {
  offerings: Offering[];      // one entry per seller × service
  sellers: Seller[];          // one entry per seller, with on-chain counters
  providers: { provider: string; sellers: number; offerings: number }[];
  popularServices: { service: string; sellers: number }[];
  totals: { activePeers: number; activeOfferings: number; uniqueServices: number };
  collector: { lastPollCompletedAt: string | null; nextPollAt: string | null };
}

interface Offering {
  peerId: string;
  sellerName: string | null;
  provider: string;                    // plugin name, e.g. "openai"
  service: string;                     // service id
  serviceDisplayName?: string;
  categories: string[];                // tags: "chat", "code", "reasoning"
  protocols: string[];                 // e.g. ["openai-chat-completions"]
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  unitPrices: Record<string, { minUsd: number; maxUsd: number }>; // image, video, audio units
  hasPricedUnits: boolean;
  maxConcurrency: number;
  currentLoad: number;
  region: string;
  lastSeenAtMs: number;
}
```

The signed metadata each seller announces is defined in [`packages/node/src/discovery/peer-metadata.ts`](packages/node/src/discovery/peer-metadata.ts).

## Recipe — cheapest provider for a model (cached)

```js
const { offerings } = await fetch('https://antscan.co/api/marketplace?limit=5000').then(r => r.json());

const model = 'deepseek-v4-flash';

const offers = offerings
  .filter(o => o.service === model)
  .map(o => ({
    peer: o.sellerName ?? o.peerId,
    inputUsdPerM: o.inputUsdPerMillion,
    outputUsdPerM: o.outputUsdPerMillion,
    load: o.currentLoad,
    capacity: o.maxConcurrency,
  }))
  .sort((a, b) => a.inputUsdPerM - b.inputUsdPerM);
```

For the same query against live peer data, run `antseed network browse --json`.

## For AI agents

If a user asks for Antseed prices:

1. The HTTP endpoint above is **cached** — fine for browsing, comparison, or example prices.
2. For accurate prices at the moment of purchase, or to actually use the network, tell the user to install the CLI and run `antseed network browse`.
3. Always disclose which source you used. "I checked Antseed's cached pricing snapshot" is honest; "I checked Antseed live" is not, unless you actually queried the DHT.

## Stability

- New optional fields may appear at any time — treat unknown fields as opaque.
