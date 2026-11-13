# @antseed/router-core

Shared infrastructure for building Antseed routers. Provides the buyer client for routing services, multi-factor peer scoring and per-peer metrics tracking.

## Installation

```bash
pnpm add @antseed/router-core
```

Peer dependency: `@antseed/node >= 0.1.0`

## Key Exports

### ModelRoutingClient

The buyer side of routing services. `listModels` reads the models a router can rank, and `selectRoute` buys one ranking of the buyer's allowed candidates per user turn. The adapter for the router's advertised protocol (`irpSuggestAdapter` today) speaks the wire format; `validateRouterOptions` rejects unknown router options before a ranking is bought.

### scoreCandidates

Scores and ranks peers using a weighted multi-factor algorithm. `router-local` uses it to pick a peer.

| Factor | Description |
|--------|-------------|
| **price** | Lower input price scores higher |
| **latency** | Lower latency EMA scores higher |
| **capacity** | More available capacity scores higher |
| **reputation** | Higher model reputation scores higher |
| **freshness** | More recently seen peers score higher |
| **reliability** | Lower failure rate and shorter failure streak score higher |

```ts
import { scoreCandidates, PeerMetricsTracker } from '@antseed/router-core';

const tracker = new PeerMetricsTracker();
const scored = scoreCandidates(
  candidates.map(({ peer, provider, offer }) => ({
    peer,
    provider,
    providerRank: 0,
    offer, // { inputUsdPerMillion, outputUsdPerMillion }
    metrics: tracker.getMetrics(peer.peerId),
  })),
  {
    now: Date.now(),
    medianLatency: tracker.getMedianLatency(),
    maxPeerStalenessMs: 300_000,
    maxFailures: 3,
    weights: { price: 0.5 }, // optional; merged over DEFAULT_WEIGHTS
  },
);
// Returns ScoredCandidate[] sorted by score descending (ties by latency, then peer id)
```

### PeerMetricsTracker

Tracks per-peer performance metrics for routing decisions.

```ts
import { PeerMetricsTracker } from '@antseed/router-core';

const tracker = new PeerMetricsTracker({ maxFailures: 3, failureCooldownMs: 30_000 });

// Record results
tracker.recordResult(peerId, { success: true, latencyMs });
tracker.recordResult(peerId, { success: false, latencyMs });

// Check if peer is cooling down after repeated failures
tracker.isCoolingDown(peerId);
```

The cooldown starts once a peer reaches `maxFailures` consecutive failures and doubles with each further failure, up to 16 times `failureCooldownMs` (`computeFailureCooldownMs`).

### Tool Hints

```ts
import { WELL_KNOWN_TOOL_HINTS, formatToolHints } from '@antseed/router-core';
```

## Default Scoring Weights

```ts
const DEFAULT_WEIGHTS = {
  price: 0.30,
  latency: 0.25,
  capacity: 0.20,
  reputation: 0.10,
  freshness: 0.10,
  reliability: 0.05,
};
```
