---
slug: /discovery
title: Peer discovery
sidebar_label: Discovery
description: How sellers announce themselves on the DHT and how buyers fetch and validate signed seller metadata.
hide_title: true
---

# Peer discovery

Discovery uses a DHT (built on BEP 5) as a decentralized directory of seller nodes, plus an HTTP metadata endpoint on each seller that returns its signed service catalog, prices, and capabilities. Nodes bootstrap through Antseed-run DHT bootstrap nodes; after that, discovery is peer to peer.

## DHT topic hashing

Sellers announce multiple topic types. Each topic is SHA1-hashed for DHT lookup.

| Topic type | Plain topic string | Key normalization |
|---|---|---|
| Wildcard | `antseed:*` | Fixed topic; also supports older buyers |
| Subnet | `antseed:subnet:{index}` | First byte of normalized peer ID modulo 16 |
| Peer | `antseed:peer:{peerId}` | Lowercase hex without the `0x` prefix |
| Optional capability | `antseed:{capability}` or `antseed:{capability}:{name}` | `trim + lowercase`; announced for configured offerings |

Each seller announces the wildcard, exactly one subnet topic, its per-peer topic,
and any configured capability topics. There are no per-service, model-search, or
provider-name topics. The signed metadata document carries the full service
catalog, keeping the announcement count independent of the number of services.

### Enumeration and local service matching

1. Query `SHA1("antseed:*")` to enumerate endpoints and warm the routing table.
2. Query subnet topics sequentially, not in parallel. A foreground time budget
   can limit the scan; subsequent scans rotate through the remaining subnets.
   The background sweep completes all subnets and can emit incremental results.
3. Deduplicate endpoints by `host:port` and fetch `GET /metadata` from each.
4. Validate metadata schema, signature, and freshness. Deduplicate accepted
   results by peer identity when constructing the buyer's peer list.
5. Match the requested service against the metadata catalog locally, then apply
   routing eligibility and ranking.

A known peer can be resolved directly through `antseed:peer:{peerId}`.
Capability-specific lookup is also available separately. Neither requires
reintroducing per-model announcements.

## Bootstrap nodes

| Host | Port |
|---|---|
| `dht1.antseed.com` | 6881 |
| `dht2.antseed.com` | 6881 |

## DHT configuration

| Parameter | Value |
|---|---|
| Port | 6881 |
| Re-announce interval | 5 minutes |
| Operation timeout | 25 seconds |
| Subnet count | 16 |

## Metadata endpoint

Each seller runs an HTTP server exposing `GET /metadata` which returns JSON-serialized `PeerMetadata` with pricing, capacity, and optional tags and protocol hints. By default, metadata is fetched from `http://{host}:{port}/metadata` (`metadataPortOffset = 0`).

## PeerMetadata

```json title="metadata structure"
{
  "peerId": "<peerId>",
  "version": 13,
  "displayName": "Example Inference",
  "publicAddress": "peer.example.com:6882",
  "providers": [{
    "provider": "openai",
    "services": ["kimi-k2.6", "deepseek-v4-flash"],
    "defaultPricing": {
      "inputUsdPerMillion": 0.6,
      "cachedInputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 2.5
    },
    "servicePricing": {
      "kimi-k2.6": { "inputUsdPerMillion": 0.6, "cachedInputUsdPerMillion": 0.06, "outputUsdPerMillion": 2.5 },
      "deepseek-v4-flash": { "inputUsdPerMillion": 0.25, "cachedInputUsdPerMillion": 0.025, "outputUsdPerMillion": 1 }
    },
    "serviceCategories": {
      "kimi-k2.6": ["coding", "privacy"]
    },
    "serviceApiProtocols": {
      "kimi-k2.6": ["openai-chat-completions"]
    },
    "serviceCapabilities": {
      "kimi-k2.6": {
        "contextWindow": 256000,
        "maxOutputTokens": 64000,
        "inputs": ["text"],
        "reasoning": true,
        "toolUse": true,
        "structuredOutput": true
      }
    },
    "maxConcurrency": 5,
    "currentLoad": 2
  }],
  "region": "us-east",
  "timestamp": 1708272000000,
  "capabilities": ["verification.response-auth.v1"],
  "sellerContract": "<seller contract address>",
  "verifications": {
    "domains": [
      { "domain": "provider.example.com", "methods": ["dns-txt"] }
    ],
    "github": [
      { "username": "example-org", "repository": "antseed-verification" }
    ]
  },
  "signature": "<EIP-191 signature, 130 hex chars>"
}
```

Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (custom tags are allowed).

Metadata v11 added `serviceUnitBillingModels`; v12 adds `serviceCapabilities` and widens service catalog and service-map counts to support up to 512 entries. Image providers advertise `openai-images` and may attach an `output_images` billing model:

```json
{
  "serviceApiProtocols": { "qwen-image": ["openai-images"] },
  "serviceUnitBillingModels": {
    "qwen-image": {
      "openai-images": {
        "version": 1,
        "components": [
          { "unit": "output_images", "priceUsd": 0.003 }
        ]
      }
    }
  },
  "serviceCapabilities": {
    "qwen-image": {
      "inputs": ["text", "image"],
      "outputs": ["image"],
      "supportedParameters": ["background", "output_format", "quality", "size"]
    }
  }
}
```

Capability fields are optional; absence means unknown. `inputs` and `outputs` declare accepted and produced modalities (`text`, `image`, `audio`, `video`, `pdf`); `supportedParameters` lists extra request-body parameter names the service accepts (lowercase snake_case, announced in code-unit sorted order). Unit-billing components may match `model`, `size`, `quality`, or `resolution`. Discovery only includes capability and billing entries for services currently advertised by the provider.

Capabilities are hints, not enforced contracts. The buyer proxy performs one advisory check: when a peer announces `supportedParameters` for the routed service and the request body carries parameters outside that list, the proxy logs a warning and forwards the request unchanged. The upstream provider remains the authority on which parameters it accepts.

Buyers accept metadata versions 10 through 14 and reject versions newer than they understand. Version 13 added `serviceHealth`, the seller's own health check result for each service, and version 14 (the current one) adds `servicePerformance`, how each service served the seller's buyers in the last hour.

```json
"serviceHealth": {
  "gpt-6-sol": { "status": "failing", "reason": "timeout", "consecutiveFailures": 3, "failingSince": 1793327880000, "checkedAt": 1793328180000, "source": "probe" },
  "gpt-6-terra": { "status": "healthy", "checkedAt": 1793328100000, "source": "traffic" }
}
```

A healthy entry says when the service last succeeded and how: `source: "traffic"` when a paid buyer request got a successful answer, `"probe"` when the seller's own check passed. `checkedAt` moves forward with each success, but buyers see the new value only with the seller's next announcement. The HTTP status of a success is not announced; `httpStatus` appears only on a failing entry.

A seller keeps failing services announced with this status instead of withdrawing them. Buyers leave failing services out of model lists and automatic routing; a request pinned to that seller still goes through. If it fails, the seller answers `503` with `error.code: "seller_self_health_failing"`, and the error says the seller's self health check is failing and why. When every seller of a model reports it failing, a buyer asking for that model gets the same error instead of "model not found".

```json
"servicePerformance": {
  "gpt-6-terra": { "requests": 312, "successRate": 0.9712, "firstTokenMsP50": 420, "firstTokenMsP90": 1250, "tokensPerSecondP50": 78 }
}
```

The seller measures these on its own buyer traffic over the last hour: every buyer request it relayed upstream (`requests`), and the share the upstream answered without a server-side error, rate limit, timeout or an error reported inside the stream (`successRate`, 0 to 1). For streamed answers it adds the median and 90th percentile time from receiving the request to the first generated token (start events and empty deltas do not count) and the median output speed in tokens per second (to within about 5%: the seller keeps running histograms rather than every request). A client error such as a malformed request does not count against it, and health probes and video jobs are not counted. A service with no buyer requests in the last hour has no entry.

Buyers use these figures as their starting point for a seller they have not used yet. Without them, a new seller is assumed to succeed 80% of the time and to be as fast as the sellers the buyer has measured. With them, the buyer starts from the reported success rate (once it covers at least 10 requests, and never above 95%, since sellers grade themselves) and the reported speed. A seller reporting failures is tried after healthier ones from the first request. The buyer's own requests quickly outweigh what the seller reports.

Buyers ask for the version they understand with the `x-antseed-metadata-version` request header. Sellers sign a v12, a v13 and a v14 document and answer with the newest one the buyer understands; a buyer that sends no header gets v12, without the services that are failing.

`publicAddress` is optional. When present, buyers should prefer it over the raw host learned from the DHT announcement. This is intended for deployments where DHT traffic exits from one IP but buyers must connect to another address, such as a Kubernetes load balancer.

`sellerContract` is optional. When present, buyers use the contract as the on-chain seller address and verify separately that the peer identity is an authorized operator of that contract.

`verifications` is optional. It carries external ownership claims that are included in the signed metadata. Domain and GitHub proofs bind to `peerId`, not to `sellerContract`, because the peer identity is the key that signs discovery metadata and operates the node.

## Domain and GitHub verification claims

The optional `verifications` field carries domain claims (proved by a DNS TXT record at `_antseed.<domain>` or an HTTPS well-known file at `/.well-known/antseed.json`) and GitHub claims (proved by an `antseed.json` file in a public repository). Proofs bind to `peerId`, not `sellerContract`, and verifiers reject redirected proof URLs. For the exact record and file formats and how to publish them, see [Verified identity](/docs/provide/verified-identity).

## Matching and ranking

Buyers match the requested service against each seller's catalog locally, then filter and rank eligible sellers. The trust score is described in [Reputation](/docs/reputation). Routing weights, defaults, and filters are documented only in the [router plugin API](/docs/router-api).
