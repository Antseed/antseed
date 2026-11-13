# Build a Antseed Router Plugin

This template shows how to publish a **router plugin** for the Antseed Network. A router plugin implements general buyer policy and peer-selection logic based on latency, price, reputation, or custom criteria. The CLI buyer proxy additionally applies the shared model-route planner to model-only requests so `/v1/models`, Desktop, and API dispatch agree on seller ordering.

## How It Works

```
antseed buyer start --router lowest-latency
       ↓
CLI loads antseed-router-lowest-latency from ~/.antseed/plugins/
       ↓
plugin.createRouter(config) → Router
       ↓
AntseedNode (buyer mode) calls router.selectPeer() for generic requests
       ↓
CLI model-only requests resolve canonical offers, apply router policy,
then rank eligible offers with @antseed/node/model-routing
```

Your plugin owns general peer policy and generic selection. Discovery, canonical model matching, transport, metering, and payments are handled by the node and buyer proxy. Explicit peer pins remain hard overrides.

## Quick Start

```bash
npm install
npm run verify     # check the plugin satisfies the interface
npm run build      # compile to dist/
```

To test end-to-end with the CLI:

```bash
antseed plugin add ./   # install this package as a plugin
antseed buyer start --router lowest-latency
```

## Customization

Replace `LowestLatencyRouter` in `src/router.ts` with your own selection strategy:

```ts
import type { Router } from '@antseed/node';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node/types';

export class CheapestRouter implements Router {
  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    if (peers.length === 0) return null;
    // Sort by price ascending, fall back to latency
    return [...peers].sort((a, b) =>
      (a.defaultInputUsdPerMillion ?? Number.POSITIVE_INFINITY) -
      (b.defaultInputUsdPerMillion ?? Number.POSITIVE_INFINITY)
    )[0] ?? null;
  }

  onResult(_peer: PeerInfo, _result: { success: boolean; latencyMs: number; tokens: number }): void {
    // Update internal state (latency EMA, reputation, etc.)
  }
}
```

Then update `src/index.ts` to use the new class and adjust `name`, `displayName`, and `configKeys`.

## DefaultRouter

`@antseed/node` ships a built-in router that filters by minimum reputation score and sorts by price:

```ts
import { DefaultRouter } from '@antseed/node';
const router = new DefaultRouter({ minReputation: 70 }); // default is 0 (no reputation gate)
```

That `DefaultRouter` behavior is the generic SDK fallback. In the CLI buyer proxy, a bare model id is planned with the shared Price + Trust preferences after router-policy checks. The model-route default `minTrustScore` is `60`, independent of the generic router's `minReputation` default.

## Publishing

```bash
npm publish

# Users install with:
antseed plugin add my-router-package
antseed buyer start --router my-router
```

## Verification

```bash
npm run verify
```

## Interface Reference

### `Router`

```ts
interface Router {
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
  }): void;
}
```

- `selectPeer` — called before each request. Return the peer to route to, or `null` to skip.
- `onResult` — called after each request completes. Update latency, reputation, or other routing state.

### `AntseedRouterPlugin`

| Property | Type | Description |
|---|---|---|
| `type` | `'router'` | Must be `'router'` |
| `name` | `string` | Short ID, e.g. `'local'` |
| `displayName` | `string` | Human-readable label |
| `version` | `string` | Semantic version (e.g. `'1.0.0'`) |
| `description` | `string` | Short description of the plugin |
| `configSchema` | `ConfigField[]` | Plugin configuration fields |
| `createRouter(config)` | `Router \| Promise<Router>` | Factory |

## Links

- [@antseed/node source](https://github.com/Antseed/node)
- [Router interface](https://github.com/Antseed/node/tree/main/src/interfaces/buyer-router.ts)
- [Official local router](https://github.com/Antseed/router-local)
- [Provider plugin template](../provider-plugin/)
