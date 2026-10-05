# 01 - Discovery Protocol

## Overview

The discovery protocol enables buyers to find sellers offering AI inference capacity on the Antseed Network. It uses a DHT network (built on BEP 5) combined with an HTTP metadata endpoint for retrieving provider details, and a scoring system for selecting the best peer from the candidate pool.

---

## DHT Layer

**Source:** `node/src/discovery/dht-node.ts`, `node/src/discovery/bootstrap.ts`

The network uses the BitTorrent Mainline DHT (BEP 5) as a decentralised directory of seller nodes.

### Topic Hashing

Sellers announce a small set of topics on the DHT: one subnet, the wildcard, the per-peer topic, and any configured capability topics. Service-level topics were intentionally removed: the signed metadata document carries the full service catalog (`providers[].services`, pricing, categories, protocols), so service filtering is metadata-driven and the announce cycle stays O(1) in the seller's service count regardless of how many services a provider exposes.

```
ANTSEED_WILDCARD_TOPIC           = "antseed:*"
subnetTopic(index)               = "antseed:subnet:" + index
peerTopic(peerId)                = "antseed:peer:" + normalizeHex(peerId)
capabilityTopic(capability)      = "antseed:" + normalize(capability)
capabilityTopic(capability,id)   = "antseed:" + normalize(capability) + ":" + normalize(id)

normalize(x) = trim(lowercase(x))
normalizeHex(x) = trim(lowercase(x)).removeLeading("0x")
subnet(peer) = parseInt(peerId[0:2], 16) % SUBNET_COUNT   // SUBNET_COUNT = 16
infoHash     = SHA1(topic)      // 20-byte info hash
```

The announcer always publishes the peer's `subnetTopic`, the wildcard topic (kept during the subnet rollout for older buyers), the per-peer topic, and any configured capability topics. Service filtering is performed against the signed metadata fetched after enumeration.

`topicToInfoHash()` produces the SHA-1 digest used as the DHT info hash.

### Bootstrap Nodes

| Host                  | Port | Label      |
|-----------------------|------|------------|
| dht1.antseed.com      | 6881 | AntSeed-1  |
| dht2.antseed.com      | 6881 | AntSeed-2  |

Custom bootstrap nodes can be supplied and are merged (deduplicated by `host:port`) with the official list via `mergeBootstrapNodes()`.

### Default Configuration

| Parameter              | Value          | Constant / Location                          |
|------------------------|----------------|----------------------------------------------|
| Port                   | 6881           | `DEFAULT_DHT_CONFIG.port`                    |
| Re-announce interval   | 5 minutes      | `DEFAULT_DHT_CONFIG.reannounceIntervalMs` (5 * 60 * 1000 = 300 000 ms) |
| Operation timeout      | 25 seconds     | `DEFAULT_DHT_CONFIG.operationTimeoutMs` (25 000 ms) |
| Subnet count           | 16             | `SUBNET_COUNT` in `dht-node.ts`              |

### Operations

- **`start()`** -- Binds the DHT socket to the configured port, bootstraps the routing table, and emits a `ready` event. If bootstrap does not complete within `operationTimeoutMs`, the node resolves anyway (partial bootstrap is acceptable).
- **`announce(infoHash, port)`** -- Announces the local peer under the given info hash at the given signaling port. Times out after `operationTimeoutMs`.
- **`lookup(infoHash)`** -- Queries the DHT for peers registered under the given info hash. Collects `{host, port}` pairs until the lookup callback fires or the operation times out.
- **`stop()`** -- Destroys the DHT instance and releases the socket.

---

## Metadata Protocol

### Metadata Version

**Source:** `node/src/discovery/peer-metadata.ts`

```
METADATA_VERSION = 12
MIN_SUPPORTED_METADATA_VERSION = 10
```

### Data Structures

#### PeerMetadata

| Field       | Type                    | Description                             |
|-------------|-------------------------|-----------------------------------------|
| peerId      | PeerId (string)         | 40 hex chars (20-byte EVM address)      |
| version     | number                  | Supported range is 10 through `METADATA_VERSION` (12) |
| displayName | string                  | Optional human-readable node label      |
| publicAddress | string                | Optional public `host:port` buyers should dial instead of the raw DHT source address |
| providers   | ProviderAnnouncement[]  | List of provider offerings              |
| offerings   | PeerOffering[]          | Optional higher-level capability offerings |
| region      | string                  | Geographic region identifier            |
| timestamp   | number                  | Unix epoch milliseconds                 |
| stakeAmountUSDC | number              | Optional stake amount, when available   |
| onChainChannelCount | number          | Optional on-chain channel count         |
| onChainGhostCount | number            | Optional on-chain ghost count           |
| capabilities | string[]               | Optional peer-level protocol capabilities |
| sellerContract | string               | Optional 40-hex-char on-chain seller contract used for payment channels |
| verifications | PeerVerifications     | Optional signed domain/GitHub ownership claims |
| signature   | string                  | 130 hex chars (65-byte secp256k1 signature) |

#### ProviderAnnouncement

| Field            | Type     | Description                                                  |
|------------------|----------|--------------------------------------------------------------|
| provider         | string   | Provider name (e.g. "anthropic")                            |
| services         | string[] | List of service identifiers                                  |
| defaultPricing   | object   | Default `{ inputUsdPerMillion, cachedInputUsdPerMillion?, outputUsdPerMillion }` |
| servicePricing     | object   | Optional per-service map `{ [service]: { inputUsdPerMillion, cachedInputUsdPerMillion?, outputUsdPerMillion } }` |
| serviceCategories  | object   | Optional per-service map `{ [service]: string[] }` with lowercase tags |
| serviceApiProtocols| object   | Optional per-service map `{ [service]: string[] }` of supported service API protocols |
| serviceUnitBillingModels | object | v11+. Optional map `{ [service]: { [protocol]: UnitBillingModelV1 } }` for non-token usage such as `output_images` |
| serviceCapabilities | object | v12+. Optional map `{ [service]: ServiceCapabilities }` with context/output limits, input/output modalities, reasoning, tool-use, structured-output, and supported-parameter hints |
| maxConcurrency   | number   | Maximum concurrent requests (>= 1)                           |
| currentLoad      | number   | Current number of active requests                            |

For a service using the `openai-images` API protocol, modality capabilities are normative routing claims:

- `{ inputs: ["text"], outputs: ["image"] }` means image generation only.
- `{ inputs: ["text", "image"], outputs: ["image"] }` means image generation and image editing.

A seller MUST advertise `image` input only when the exact announced service can accept an image-bearing edit request through its configured provider adapter and upstream route. Support elsewhere in the upstream vendor's API, or through a different upstream model, does not make the announced service edit-capable. Buyers MUST NOT route `/v1/images/edits` to a service that omits `image` from its inputs.

### Binary Encoding Format

**Source:** `node/src/discovery/metadata-codec.ts`

All multi-byte integers are big-endian. Strings are UTF-8 encoded.

```
Header:
  [version       : 1 byte   uint8 ]
  [peerId        : 20 bytes        ]   // EVM address
  [regionLen     : 1 byte   uint8 ]
  [region        : N bytes  UTF-8  ]   // N = regionLen
  [timestamp     : 8 bytes  BigUint64 big-endian ]
  [providerCount : 1 byte   uint8 ]

Per provider (repeated providerCount times):
  [providerLen   : 1 byte   uint8 ]
  [provider      : N bytes  UTF-8  ]   // N = providerLen
  [serviceCount  : 1 byte uint8 through v11; 2 bytes uint16 in v12+ ]
  Per service (repeated serviceCount times):
    [serviceLen  : 1 byte   uint8 ]
    [service     : N bytes  UTF-8  ]   // N = serviceLen
  [defaultInputUsdPerMillion       : 4 bytes  float32 big-endian ]
  [defaultOutputUsdPerMillion      : 4 bytes  float32 big-endian ]
  [defaultCachedInputUsdPerMillion : 4 bytes  float32 big-endian ]   // v7+; defaults to defaultInputUsdPerMillion
  [servicePricingCount : 1 byte uint8 through v11; 2 bytes uint16 in v12+ ]
  Per service pricing entry (repeated servicePricingCount times):
    [serviceLen : 1 byte   uint8 ]
    [service    : N bytes  UTF-8  ]
    [inputUsdPerMillion       : 4 bytes  float32 big-endian ]
    [outputUsdPerMillion      : 4 bytes  float32 big-endian ]
    [cachedInputUsdPerMillion : 4 bytes  float32 big-endian ]   // v7+; defaults to inputUsdPerMillion
  [serviceCategoryCount : 1 byte uint8 through v11; 2 bytes uint16 in v12+ ]
  Per service category entry (repeated serviceCategoryCount times):
    [serviceLen : 1 byte   uint8 ]
    [service    : N bytes  UTF-8  ]
    [categoryCount : 1 byte uint8 ]
    Per category (repeated categoryCount times):
      [categoryLen : 1 byte uint8 ]
      [category    : N bytes UTF-8 ]
  [serviceApiProtocolCount : 1 byte uint8 through v11; 2 bytes uint16 in v12+ ]
  Per service API protocol entry (repeated serviceApiProtocolCount times):
    [serviceLen : 1 byte   uint8 ]
    [service    : N bytes  UTF-8  ]
    [protocolCount : 1 byte uint8 ]
    Per protocol (repeated protocolCount times):
      [protocolLen : 1 byte uint8 ]
      [protocol    : N bytes UTF-8 ]
  [serviceUnitBillingEntryCount : 1 byte uint8 through v11; 2 bytes uint16 in v12+ ]
  Per unit billing entry:
    [service][protocolId:1][modelVersion:1][componentCount:1][components...]
    Components encode unit id, float32 USD price, and optional match key/value pairs.
  [serviceCapabilityEntryCount : 2 bytes uint16 ]    // v12+
  Per capability entry:
    [service][presenceBits:1][optional uint32 token limits][optional input bitset:1][optional output bitset:1][boolean value bits:1][optional supported parameters]
    Presence bits: contextWindow(0), maxOutputTokens(1), inputs(2), reasoning(3),
    toolUse(4), structuredOutput(5), outputs(6), supportedParameters(7).
    Input/output bitsets index into ["text","image","audio","video","pdf"].
    Supported parameters encode as [count:1] then per parameter [len:1][utf8],
    in code-unit sorted order so re-encoding decoded metadata is byte-stable.
  [maxConcurrency: 2 bytes  uint16  big-endian ]
  [currentLoad   : 2 bytes  uint16  big-endian ]

Post-provider sections:
  [displayNameFlag:1]                             // v3+
  if displayNameFlag == 1:
    [displayNameLen:1][displayName:N]
  [publicAddressFlag:1]                           // v5+
  if publicAddressFlag == 1:
    [publicAddressLen:1][publicAddress:N]
  [sellerContractFlag:1]                          // v8+
  if sellerContractFlag == 1:
    [sellerContract:20]
  [domainVerificationCount:1]                     // v9+
  Per domain verification entry:
    [domainLen:1][domain:N][methodCount:1][methodIds...]
    method id 0 = dns-txt, 1 = https-well-known
  [githubVerificationCount:1]                     // v9+
  Per GitHub verification entry:
    [usernameLen:1][username:N][repositoryLen:1][repository:N]
    repositoryLen 0 means the profile repository `<username>/<username>`
  [offeringCount:2]                               // uint16
  [offeringEntries...]
  [onChainStatsFlag:1] + [statsData:10 if present]
  [capabilityCount:1]                             // v10+
  Per capability entry:
    [capabilityLen:1][capability:N]

Trailer:
  [signature     : 65 bytes        ]   // secp256k1 signature
```

### Version Compatibility and Rollout

Metadata validation is intentionally bounded: buyers accept versions from `MIN_SUPPORTED_METADATA_VERSION` through their own `METADATA_VERSION`. Consequently:

| Buyer | Seller v10 | Seller v11 | Seller v12 |
|---|---:|---:|---:|
| v10 | accepted | rejected | rejected |
| v11 | accepted | accepted | rejected |
| v12 | accepted | accepted | accepted |

The decoder cannot safely ignore unknown newer versions because provider extensions are embedded in the signed binary layout. Deploy buyer support first, then seller binaries. Metadata v12 widens service and service-map counts from `uint8` to `uint16`; removing optional fields from config does not make a v12 seller emit an older version.

The body (everything except the trailing 65-byte signature) is the data that is signed. `encodeMetadataForSigning()` produces this body without the signature for signing and verification purposes.

### Validation Limits

**Source:** `node/src/discovery/metadata-validator.ts`

| Constant                  | Value | Description                                 |
|---------------------------|-------|---------------------------------------------|
| MAX_METADATA_SIZE         | 131072 | Maximum encoded size in bytes              |
| MAX_PROVIDERS             | 10    | Maximum provider entries per metadata       |
| MAX_SERVICES_PER_PROVIDER | 512   | Maximum services per provider entry         |
| MAX_SERVICE_NAME_LENGTH   | 64    | Maximum service name length in characters   |
| MAX_REGION_LENGTH         | 32    | Maximum region string length in characters  |
| MAX_DISPLAY_NAME_LENGTH   | 64    | Maximum display name length in characters   |
| MAX_PUBLIC_ADDRESS_LENGTH | 255   | Maximum public address length in characters |
| MAX_DOMAIN_VERIFICATION_CLAIMS | 5 | Maximum domain verification claims          |
| MAX_DOMAIN_LENGTH         | 253   | Maximum domain claim length in characters   |
| MAX_GITHUB_VERIFICATION_CLAIMS | 5 | Maximum GitHub verification claims          |
| MAX_GITHUB_USERNAME_LENGTH | 39   | Maximum GitHub username length              |
| MAX_GITHUB_REPOSITORY_LENGTH | 100 | Maximum GitHub repository name length       |
| MAX_SERVICE_CATEGORIES_PER_SERVICE | 64 | Maximum categories per service          |
| MAX_SERVICE_CATEGORY_LENGTH | 32  | Maximum category length in characters       |
| MAX_SERVICE_API_PROTOCOLS_PER_SERVICE | 4 | Maximum protocol entries per service |
| MAX_PEER_CAPABILITIES     | 16    | Maximum peer-level capability entries       |
| MAX_PEER_CAPABILITY_LENGTH | 64   | Maximum peer-level capability length        |

Additional validation rules enforced by `validateMetadata()`:

- `version` must be between `MIN_SUPPORTED_METADATA_VERSION` (10) and `METADATA_VERSION` (12).
- `peerId` must be exactly 40 lowercase hex characters.
- `region` must not be empty.
- `displayName` is optional, but when present it must be non-empty and <= 64 chars.
- `publicAddress` is optional, but when present it must be a valid `host:port` and is signed as part of the metadata.
- `sellerContract` is optional, but when present it must be exactly 40 lowercase hex characters and is signed as part of the metadata.
- `verifications` is optional, but when present it must contain at least one supported namespace: `domains` or `github`.
- Domain verification claims must be unique, lower-case hostnames with at least two labels, and may list unique methods from `dns-txt` and `https-well-known`. When `methods` is omitted, clients may try every known method.
- GitHub verification claims must be unique. Usernames must be valid lower-case GitHub usernames, and repository names must be valid lower-case GitHub repository names when provided.
- `capabilities` is optional, but when present values must be unique lower-case strings using letters, digits, hyphen, or dot.
- `timestamp` must be a positive finite number.
- At least one provider must be present.
- `defaultPricing.inputUsdPerMillion` and `defaultPricing.outputUsdPerMillion` must be non-negative.
- `defaultPricing.cachedInputUsdPerMillion` (if present) must be non-negative. Defaults to `inputUsdPerMillion` when omitted.
- Each `servicePricing[service].inputUsdPerMillion` and `servicePricing[service].outputUsdPerMillion` (if present) must be non-negative.
- Each `servicePricing[service].cachedInputUsdPerMillion` (if present) must be non-negative. Defaults to the service's `inputUsdPerMillion` when omitted.
- `serviceCategories` (if present) must reference services listed in `providers[].services`.
- Each category must be lowercase alphanumeric or hyphen: `^[a-z0-9][a-z0-9-]*$`.
- Categories must be non-empty, unique per service, and within per-service/per-tag limits above.
- Recommended category tags: `privacy`, `legal`, `uncensored`, `coding`, `finance`, `tee` (not enforced; custom tags allowed).
- `serviceApiProtocols` (if present) must reference services listed in `providers[].services`.
- `serviceApiProtocols` entries must be known protocol IDs, non-empty, unique per service, and within per-service limits above.
- `maxConcurrency` must be at least 1.
- `currentLoad` must be non-negative and must not exceed `maxConcurrency`.
- `signature` must be exactly 130 lowercase hex characters (65 bytes).
- The full encoded payload must not exceed `MAX_METADATA_SIZE`.

---

## External Verification Claims

External verification claims are signed inside `PeerMetadata.verifications`, but the actual ownership proof is fetched outside the DHT metadata document. Proofs bind to `peerId`, not to `sellerContract`. When `sellerContract` is present, buyers verify the peer-to-contract delegation separately on-chain, for example by calling `sellerContract.isOperator(peerAddress)`.

### Domain verification

A domain claim has this metadata shape:

```json
{
  "domain": "provider.example.com",
  "methods": ["dns-txt"]
}
```

Supported methods:

- `dns-txt`: resolve `_antseed.<domain>` and look for `antseed-peer=<peerId>`.
- `https-well-known`: fetch `https://<domain>/.well-known/antseed.json` without following redirects.

The DNS TXT proof is:

```text
_antseed.provider.example.com TXT "antseed-peer=a1b2c3d4...40hex"
```

The HTTPS well-known proof body is:

```json
{
  "type": "antseed-domain-verification",
  "peerId": "a1b2c3d4...40hex",
  "domain": "provider.example.com"
}
```

### GitHub verification

A GitHub claim has this metadata shape:

```json
{
  "username": "example-org",
  "repository": "antseed-verification"
}
```

The verifier fetches the proof from:

```text
https://raw.githubusercontent.com/<username>/<repository>/HEAD/antseed.json
```

If `repository` is omitted, the profile repository named after the username is used. Redirects are rejected, so renamed or transferred repositories must republish the proof under the claimed account path.

The proof body is:

```json
{
  "type": "antseed-github-verification",
  "peerId": "a1b2c3d4...40hex",
  "username": "example-org"
}
```

## Metadata HTTP Endpoint

### Server Side

**Source:** `node/src/discovery/metadata-server.ts`

The seller runs an HTTP server that exposes its current metadata:

- **Listen address:** `0.0.0.0` on the configured port.
- **Endpoint:** `GET /metadata`
- **Success response:** `200` with `content-type: application/json` body containing JSON-serialized `PeerMetadata`.
- **Not ready response:** `503` with `{"error": "metadata not available"}` when `getMetadata()` returns `null`.
- **Unknown path:** `404` with `{"error": "not found"}`.
- **Wrong method:** `405` with `{"error": "method not allowed"}`.

### Client Side

**Source:** `node/src/discovery/http-metadata-resolver.ts`

The buyer resolves metadata from a discovered peer's HTTP endpoint:

| Parameter              | Default | Description                                                         |
|------------------------|---------|---------------------------------------------------------------------|
| timeoutMs              | 2000    | HTTP fetch timeout in milliseconds                                  |
| metadataPortOffset     | 0       | Offset from the signaling port to the metadata port                 |
| failureCooldownMs      | 30000   | How long to skip an endpoint after it fails                         |

The metadata URL is constructed as:

```
http://{host}:{port + metadataPortOffset}/metadata
```

On any non-OK response, network error, timeout, or invalid JSON, the resolver returns `null` (fail-closed) and marks both the specific endpoint and the peer's host as failed for `failureCooldownMs`. Subsequent resolution attempts for any port on the same host are skipped immediately until the cooldown expires.

All peers returned by a DHT lookup are resolved in parallel, so a single slow or unreachable endpoint does not delay the others.

---

## Peer Lookup

**Source:** `node/src/discovery/peer-lookup.ts`

The `PeerLookup` class orchestrates the full discovery flow:

1. Build lookup topic(s):
   - all-peer lookup: `SHA1(ANTSEED_WILDCARD_TOPIC)` first, then `SHA1(subnetTopic(i))` for each subnet sequentially
   - service "lookup": there is no DHT-level service lookup. Service filtering happens against the signed metadata returned by `findAll()`. See `AntseedNode.discoverPeers(service)`.
   - capability lookup: `SHA1(capabilityTopic(capability[, name]))`
   - per-peer lookup (`findByPeerId`): `SHA1(peerTopic(peerId))`
2. Query the DHT for the topic hash(es) to obtain `{host, port}` peer endpoints.
   General enumeration calls `DHTNode.lookup()` for the wildcard, then each subnet
   in sequence. A configured foreground budget limits how many subnets are
   attempted; the next scan resumes from the rotating subnet cursor. Background
   `findAllExhaustive()` completes a full sweep and can emit incremental results.
   Endpoints are deduplicated by `host:port` before metadata resolution.
3. For each peer (up to `maxResults`):
   a. Fetch metadata via the configured `MetadataResolver`.
   b. If `requireValidSignature` is `true`, verify the secp256k1 signature over the encoded body using ecrecover and compare the recovered address to the peer's `peerId`. Discard peers with invalid signatures.
   c. If `allowStaleMetadata` is `false`, discard metadata where `Date.now() - timestamp > maxAnnouncementAgeMs`.
4. Return the list of `{metadata, host, port}` results.

### Default Lookup Configuration

| Parameter                | Default Value    | Description                              |
|--------------------------|------------------|------------------------------------------|
| requireValidSignature    | true             | Reject metadata with invalid signatures  |
| allowStaleMetadata       | false            | Reject stale metadata                    |
| maxAnnouncementAgeMs     | 30 minutes       | 30 * 60 * 1000 = 1 800 000 ms           |
| maxResults               | 200              | Maximum peers returned per lookup        |

---

## Peer Announcement

**Source:** `node/src/discovery/announcer.ts`

The `PeerAnnouncer` class handles the seller-side announcement lifecycle:

1. Build a `PeerMetadata` object from the configured providers, current pricing, current load, and region.
2. Set `version` to `METADATA_VERSION` (10) and `timestamp` to `Date.now()`.
3. Include configured seller contract, verification claims, and peer capabilities when present.
4. Encode the body (without signature) via `encodeMetadataForSigning()`.
5. Sign the body with the seller's secp256k1 private key (via EIP-191 personal_sign).
6. Announce DHT topics in parallel at the configured signaling port (constant in service count):
   - subnet topic (`subnetTopic(subnetOf(peerId))`)
   - wildcard topic (`ANTSEED_WILDCARD_TOPIC`), kept during the subnet rollout so older buyers still find this peer
   - per-peer topic (`peerTopic(peerId)`)
   - capability topics when offerings are configured (one per offering plus one per unique capability name)

Periodic re-announcement is managed by `startPeriodicAnnounce()`, which calls `announce()` immediately and then every `reannounceIntervalMs` milliseconds. Load can be updated at any time via `updateLoad(providerName, currentLoad)` and will be reflected in the next announcement cycle.

---

## Peer Scoring and Model Route Planning

**Source:** `@antseed/router-core/src/peer-scorer.ts`

Discovery returns signed metadata and on-chain stats. Router plugins enforce general buyer policy and provide generic request selection. For requests that name only a model, the CLI buyer proxy adds a shared model-route planning layer: it canonicalizes the requested model, resolves each peer's matching advertised service, rejects candidates disallowed by router policy, and ranks the remaining offers with `@antseed/node/model-routing`. The same ranking orders each model's `peers` array in the locally answered `/v1/models` catalog.

The default model-only preferences are:

```ts
{
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
}
```

`minTrustScore` and seller access lists determine model-route eligibility. Eligible offers are ordered using effective trust, token or image price, cached-input pricing coverage, recent peer failures, cooldown state, and free-peer preference. When at least one offer for a model advertises cached-input pricing, an offer that omits it receives a model-specific effective-reputation reduction; if no offer advertises it, no seller is penalized.

Recognized conversations softly prefer their previous successful automatic route while it remains healthy and policy-eligible. Peer-attributed retryable failures can advance to the next ranked offer; HTTP 429 receives up to three attempts on the same peer before fallback. Explicit peer pins remain hard and bypass automatic peer selection.

For generic router scoring outside this model-specific planning layer, the official local router filters candidates by buyer pricing policy, optional minimum reputation, and failure cooldown, then scores remaining candidates with these default weights:

| Dimension   | Default Weight | Description                              |
|-------------|----------------|------------------------------------------|
| price       | 0.30           | Lower price scores higher                |
| latency     | 0.25           | Lower latency scores higher              |
| capacity    | 0.20           | Preference for available capacity        |
| reputation  | 0.10           | Higher trust score scores higher         |
| freshness   | 0.10           | Recently seen peers score higher         |
| reliability | 0.05           | Lower failure rate and streak scores higher |

Price, latency, and capacity are normalized across the eligible candidate pool. Reputation is a 0-100 score normalized to 0-1: official routers use the buyer-computed trust score (see [05-reputation](05-reputation.md)) when available, then fall back to the optional `PeerInfo.reputationScore` field. These generic router-core weights are separate from the shared model-route ranking described above.

---

## DHT Health Monitoring

**Source:** `node/src/discovery/dht-health.ts`

The `DHTHealthMonitor` tracks operational health of the DHT node.

### Default Health Thresholds

| Threshold              | Default Value | Description                                  |
|------------------------|---------------|----------------------------------------------|
| minNodeCount           | 5             | Minimum DHT routing table nodes              |
| minLookupSuccessRate   | 0.3           | Minimum lookup success ratio (after 5+ lookups) |
| maxAvgLookupLatencyMs  | 15 000        | Maximum average lookup latency (after 5+ samples) |

The node is considered healthy when all applicable thresholds are satisfied. Latency samples are kept in a rolling window of up to 100 entries.
