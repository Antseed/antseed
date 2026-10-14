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
  "version": 12,
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

Buyers accept metadata versions 10 through 12 and reject versions newer than they understand. The current version is 12.

`publicAddress` is optional. When present, buyers should prefer it over the raw host learned from the DHT announcement. This is intended for deployments where DHT traffic exits from one IP but buyers must connect to another address, such as a Kubernetes load balancer.

`sellerContract` is optional. When present, buyers use the contract as the on-chain seller address and verify separately that the peer identity is an authorized operator of that contract.

`verifications` is optional. It carries external ownership claims that are included in the signed metadata. Domain and GitHub proofs bind to `peerId`, not to `sellerContract`, because the peer identity is the key that signs discovery metadata and operates the node.

## Domain and GitHub verification claims

The optional `verifications` field carries domain claims (proved by a DNS TXT record at `_antseed.<domain>` or an HTTPS well-known file at `/.well-known/antseed.json`) and GitHub claims (proved by an `antseed.json` file in a public repository). Proofs bind to `peerId`, not `sellerContract`, and verifiers reject redirected proof URLs. For the exact record and file formats and how to publish them, see [Verified identity](/docs/provide/verified-identity).

## Matching and ranking

Buyers match the requested service against each seller's catalog locally, then filter and rank eligible sellers. The trust score is described in [Reputation](/docs/reputation). Routing weights, defaults, and filters are documented only in the [router plugin API](/docs/router-api).
