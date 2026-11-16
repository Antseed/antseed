# @antseed/relay

The relay that lets a browser buyer (`packages/web-sdk`) reach an unmodified seller. Browsers cannot join the UDP DHT or open TCP sockets, so this Node service discovers sellers over the DHT and serves them at `GET /sellers`, and pipes a WebSocket (`/bridge/<peerId>`) byte for byte to that seller's TCP signaling port. The WebRTC DataChannel then runs directly between browser and seller; the relay carries signaling only. Published to npm (`@antseed/node` is a peer dependency). Anyone can run one; `README.md` lists its env variables.

## Inside

- `src/index.ts` — entry: reads env, starts the cache and the server.
- `src/seller-cache.ts` — `SellerCache`: DHT lookups plus static, operator-configured sellers.
- `src/server.ts` — `RelayServer`: health, readiness, metrics, `/sellers`, and the guarded WebSocket bridge.
- `src/address-guard.ts` — refuses private and internal addresses for discovered sellers.
- Where to add: a new limit is a `RelayServerConfig` field, a `RELAY_*` variable in `index.ts`, a row in `README.md` and a test in `server.test.ts`.

| Rule | Enforced by |
| --- | --- |
| The bridge never parses or rewrites traffic. Auth is end-to-end: the buyer signs its own hello. | review only |
| It dials only peers in the cache, so it is never an open TCP proxy. Unknown peer is 404, malformed id 400. | `src/server.test.ts` |
| Discovered addresses are attacker-announced: private ranges are refused at upgrade and again at DNS resolution (no rebinding). Only static, operator-configured sellers skip the guard. | `src/server.test.ts` (address guard and dial cases) |
| `/metrics` holds no client IPs, seller ids, SDP or ICE data. | `src/server.test.ts` ("privacy-safe aggregate metrics") |
| Behind a TLS terminator with `RELAY_TRUST_PROXY=1`, the per-IP cap keys on the last `X-Forwarded-For` entry. | `src/server.test.ts` |

## Connections

- Uses `@antseed/node` and `@antseed/node/discovery`; a change to metadata decoding, `publicAddress` or the signaling handshake in node reaches the relay.
- `packages/web-sdk` is the only client. Its `integration.test.ts` runs `RelayServer` and `SellerCache` from this package's `src/` against real seller code, so a relay API change breaks that test.
- Published from `scripts/npm-publish-plan.mjs` `EXTRA_DIRS`. The discovery flow mirrors `apps/network-stats`.

## Traps

- `/readyz` answers 503 until the DHT has warmed up and a fresh snapshot exists. Any static seller makes it always ready; `RELAY_DISABLE_DHT=1` without static sellers makes it never ready.
- `SellerCacheConfig.bootstrapNodes` replaces the official list (tests only); no env sets it.
- Without `RELAY_TRUST_PROXY=1` behind a proxy, every client shares one per-IP cap. With it and no proxy, clients can forge `X-Forwarded-For`.
- `RELAY_ALLOWED_ORIGINS` is not authentication; non-browser clients forge `Origin`.
- Browsers on HTTPS pages need `wss://`, so production runs behind a TLS terminator.

**Ask first:** the address guard, the cache-only dial rule, the bridge caps' defaults, anything that would make the relay read or change signaling bytes.

**Prove it:** `pnpm --filter @antseed/relay test` and `pnpm --filter @antseed/relay typecheck`, then `pnpm --filter @antseed/web-sdk test` (its integration test runs this relay).
