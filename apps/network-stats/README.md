# @antseed/network-stats

Standalone service that polls the Antseed network as an anonymous buyer and exposes live peer/model stats over HTTP.

## What it does

- Connects to the network via DHT discovery every 15 minutes
- Extracts: active peer count + list of available services
- Caches result to `cache/network.json`
- Exposes a simple Express API for XHR consumption by the website

## API

```
GET /stats   →  { peers: number, services: string[], updatedAt: string }
GET /health  →  { ok: true }
```

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

## Development

```bash
pnpm build
pnpm test
```
