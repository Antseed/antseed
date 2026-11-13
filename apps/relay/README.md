# @antseed/relay

Web relay for browser buyers. Two jobs:

1. **Seller cache** — periodically discovers sellers over the DHT (same flow
   as network-stats) and serves the snapshot at `GET /sellers` (CORS `*`).
2. **Signaling bridge** — `WS /bridge/<peerId>` pipes bytes verbatim to that
   seller's TCP signaling port. The bridge never parses traffic; connection
   auth is end-to-end (the buyer signs its own hello envelope). It only dials
   endpoints present in the cache, and because discovered `publicAddress`
   values are attacker-announced, it refuses to dial loopback, private,
   link-local, and CGNAT ranges for non-static sellers (checked for IP
   literals at upgrade time and again at DNS resolution, so rebinding does
   not bypass it). Static sellers are operator-configured and exempt.

Browsers cannot open raw TCP sockets or join the UDP DHT — this service is
the minimal shim that lets a browser reach an **unmodified** seller. The
WebRTC DataChannel itself is established directly between browser and seller;
the relay only carries signaling.

The service exposes `GET /healthz` for process liveness, `GET /readyz` for
seller-cache freshness, and `GET /metrics` for aggregate JSON counters. The
metrics contain no client IPs, seller IDs, SDP, or ICE data.

## Run

```bash
pnpm --filter=@antseed/relay run build
node apps/relay/dist/index.js
```

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_PORT` | `8917` | HTTP/WS listen port |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `RELAY_DISABLE_DHT` | unset | `1` disables DHT discovery (static-only) |
| `RELAY_POLL_MS` | `300000` | DHT poll interval |
| `RELAY_STATIC_SELLERS` | empty | `peerId@host:port,...` extra sellers (dev/e2e) |
| `RELAY_MAX_BRIDGES_PER_IP` | `16` | Concurrent bridges per client IP |
| `RELAY_MAX_BRIDGES_GLOBAL` | `1024` | Global concurrent signaling bridges |
| `RELAY_MAX_BRIDGES_PER_SELLER` | `8` | Concurrent bridges to one seller |
| `RELAY_MAX_PAYLOAD_BYTES` | `1048576` | Maximum WebSocket signaling message size |
| `RELAY_TCP_CONNECT_TIMEOUT_MS` | `10000` | Seller dial timeout |
| `RELAY_IDLE_TIMEOUT_MS` | `600000` | Idle bridge teardown |
| `RELAY_READINESS_MAX_AGE_MS` | `900000` | Maximum DHT snapshot age accepted by `/readyz` |
| `RELAY_ALLOWED_ORIGINS` | empty | Optional comma-separated browser Origin allowlist |
| `RELAY_TRUST_PROXY` | unset | `1` when behind a TLS terminator: per-IP limits use the last `X-Forwarded-For` entry |

Production note: browsers require `wss://` from HTTPS pages — terminate TLS
in front of the relay (ALB, nginx, Caddy). Set `RELAY_TRUST_PROXY=1` there,
otherwise every client shares the proxy's IP and one per-IP bridge cap.
Set `RELAY_ALLOWED_ORIGINS` for a product-specific deployment; it reduces
drive-by browser use but is not authentication because non-browser clients can
forge `Origin`.
