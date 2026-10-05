# 08 - Fingerprint Swarm

**Status:** Proposed / design. This document specifies how public model
fingerprints are published, discovered, fetched, verified, cached, and re-seeded
in a decentralized Antseed swarm. It supports
[07-model-verification.md](./07-model-verification.md), but it is a separate
protocol surface.

## Overview

Antseed should not rely on one public repository or one hosted database for
public model fingerprints. A repository is useful for review and bootstrap, but
the network should behave more like a torrent swarm:

```text
small announcement -> content hash -> many peers can serve the same pack
```

Each public fingerprint dataset is distributed as a signed, content-addressed
**fingerprint pack**. Peers announce pack metadata through Antseed discovery,
fetch pack bytes from any available mirror or peer, verify the pack by hash and
publisher signature, then optionally seed the pack for others.

The core trust model:

```text
Discovery tells me a pack exists.
Storage gives me bytes.
Hash proves the bytes are correct.
Signature proves who published the pack.
Local trust policy decides whether I use it.
```

This makes Antseed the place where participants come to find and check public
fingerprints without making Antseed dependent on a central server.

---

## Torrent Analogy

| Torrent concept | Fingerprint swarm concept |
|---|---|
| `.torrent` / magnet link | `FingerprintPackAnnouncement` |
| info hash | `packId` |
| tracker / DHT | Antseed discovery topics |
| downloaded files | `FingerprintPack` bytes |
| seeders | peers that mirror the pack |
| piece hashes | optional chunk hashes for large packs |
| uploader identity | `publisherPeerId` + signature |

Unlike a normal torrent, a valid download is not automatically trusted. Buyers
still apply local trust policy to the publisher, freshness, provenance, and
separation quality.

---

## Roles

- **Publisher:** creates a fingerprint pack, signs it, and announces it.
- **Seeder:** stores a verified pack and serves it to peers.
- **Fetcher:** discovers and downloads packs from seeders or mirrors.
- **Buyer:** imports trusted references from packs into its local verifier store.
- **Mirror:** any transport endpoint that can serve pack bytes by `packId`
  (Antseed peer transfer, IPFS, Arweave, HTTPS, local file cache).

A single node can be all roles.

---

## Data Model

### FingerprintPack

A pack is the payload. It contains public references and optional public
separation data for one or more verifier families.

```jsonc
{
  "version": 1,
  "packId": "sha256:...",
  "publisher": {
    "peerId": "0x...",
    "displayName": "Antseed public references",
    "url": "https://..."
  },
  "signature": "0x...",
  "createdAt": "2026-06-14T00:00:00.000Z",
  "expiresAt": "2026-09-14T00:00:00.000Z",
  "license": "Apache-2.0",
  "provenance": [
    {
      "url": "https://github.com/Ooo0ption/KBF",
      "commit": "<optional>",
      "license": "Apache-2.0"
    }
  ],
  "references": [
    {
      "version": 1,
      "kind": "kbf",
      "referenceId": "sha256:...",
      "referenceModel": "openai/gpt-5.4",
      "serviceAliases": ["gpt-5.4"],
      "selfTest": {
        "hamming": 3,
        "total": 224,
        "coverage": 1.0,
        "errorRate": 0.0134
      },
      "probes": []
    }
  ],
  "publicResults": [
    {
      "referenceId": "sha256:...",
      "verifierKind": "kbf",
      "modelPair": ["openai/gpt-5.4", "anthropic/claude-opus-4.6"],
      "sampleCount": 224,
      "separationScore": 0.91,
      "notes": "public reproducibility only"
    }
  ]
}
```

`packId` is computed over canonical pack content excluding `packId` and
`signature`:

```text
packId = "sha256:" || sha256(canonical-json(unsignedPack))
```

The signature covers the pack identity and the Antseed domain tag:

```text
signature = sign("antseed-fingerprint-pack-v1" || packId)
```

### FingerprintPackAnnouncement

An announcement is the small, torrent-like record peers advertise and exchange.
It is not the pack itself.

```jsonc
{
  "version": 1,
  "packId": "sha256:...",
  "publisherPeerId": "0x...",
  "signature": "0x...",
  "verifierKinds": ["kbf", "behavioral-classifier"],
  "referenceModels": ["openai/gpt-5.4"],
  "serviceAliases": ["gpt-5.4"],
  "createdAt": "2026-06-14T00:00:00.000Z",
  "expiresAt": "2026-09-14T00:00:00.000Z",
  "byteLength": 123456,
  "chunkSize": 262144,
  "chunkHashes": ["sha256:..."],
  "mirrors": [
    "antseed-peer://0x.../fingerprints/sha256-...",
    "ipfs://...",
    "ar://...",
    "https://example.invalid/antseed/fingerprints/sha256-..."
  ]
}
```

Announcements SHOULD be small enough for discovery metadata. Large fields belong
inside the pack.

For small packs, `chunkHashes` MAY be omitted and the final `packId` check is
sufficient. For large packs, `chunkHashes` lets a fetcher verify chunks and
resume partial downloads.

---

## Discovery Topics

Peers announce packs on deterministic topics:

```text
antseed:fingerprints:v1
antseed:fingerprints:v1:<verifierKind>
antseed:fingerprints:v1:<verifierKind>:<modelSlug>
```

Examples:

```text
antseed:fingerprints:v1:kbf
antseed:fingerprints:v1:kbf:gpt-5.4
antseed:fingerprints:v1:runtime:claude-sonnet-4.6
```

Topic values carry `FingerprintPackAnnouncement` records. A peer MAY announce the
same pack on multiple topics so fetchers can discover by verifier family, model,
or global feed.

---

## Fetching and Seeding

Fetch flow:

1. Fetcher discovers an announcement.
2. Fetcher rejects expired announcements unless local policy allows archival
   imports.
3. Fetcher picks mirrors in local preference order.
4. Fetcher downloads pack bytes, optionally chunk by chunk.
5. Fetcher verifies chunk hashes if present.
6. Fetcher computes `packId` from canonical pack bytes.
7. Fetcher verifies publisher signature.
8. Fetcher applies local trust policy.
9. If trusted, fetcher imports references and MAY seed the pack.

Seeder flow:

1. Seeder stores verified pack bytes under local cache.
2. Seeder announces the pack with itself in `mirrors`.
3. Seeder serves bytes by `packId`.
4. Seeder SHOULD rate-limit serving and SHOULD refuse packs it has not verified.

Local cache layout:

```text
<dataDir>/fingerprint_swarm/
  packs/
    sha256-<packHash>.json
  announcements/
    sha256-<packHash>.json
  chunks/
    sha256-<packHash>/
      000000.part
      000001.part
  trust/
    publishers.json
```

The cache is replaceable. Any cached pack can be deleted and re-fetched from the
swarm as long as at least one seeder or mirror remains.

---

## Storage Backends

The protocol is storage-neutral. Valid mirrors include:

- `antseed-peer://...` - direct peer serving through Antseed transport;
- `ipfs://...` - content-addressed public storage;
- `ar://...` - permanent public storage for high-value packs;
- `https://...` - ordinary web mirrors;
- local file paths for developer fixtures.

All mirrors are untrusted byte sources. Verification is always by `packId` and
signature.

GitHub or another public repository MAY be used as:

- a human review surface;
- a bootstrap list of trusted publisher keys;
- a seed mirror for public packs;
- a changelog for curated packs.

It MUST NOT be the only source of truth.

---

## Trust Policy

Integrity is objective. Trust is local.

A pack with a valid hash and signature proves only:

```text
publisherPeerId signed these exact pack bytes
```

It does not prove the probes are useful, fresh, unbiased, or safe to use for
adverse action.

Buyers SHOULD consider:

- whether the publisher is trusted locally;
- whether the publisher is stake-backed or reputation-backed;
- whether multiple independent publishers endorse the same reference;
- whether the pack is expired or stale;
- whether reference self-error is low enough;
- whether public separation scores still distinguish known contrast models;
- whether license and provenance are acceptable;
- whether the pack contains only public data.

Private Buyer probes MUST NOT be published to the swarm. Public packs are for
bootstrap, reproducibility, network-wide learning, and shared benchmarks. Private
references remain the stronger enforcement path for adversarial Seller audits.

---

## Relationship to Model Verification

[07-model-verification.md](./07-model-verification.md) defines how Buyers run
fingerprint audits against Sellers and store signed evidence.

This document defines how public fingerprint material reaches Buyers:

```text
fingerprint swarm -> trusted local references -> buyer audit runner
```

The swarm does not run audits, verify Sellers, or slash. It distributes public
verifier inputs and public reproducibility data.

---

## Implementation Milestones

1. Define `FingerprintPack` and `FingerprintPackAnnouncement` types in
   `@antseed/fingerprints`.
2. Implement canonical pack hashing and pack signature verification.
3. Add local pack cache under `<dataDir>/fingerprint_swarm`.
4. Add import from local file/HTTPS mirror for development.
5. Add Antseed discovery announcements for pack metadata.
6. Add direct peer fetch by `packId`.
7. Add optional IPFS/Arweave mirror URI support.
8. Add local publisher trust policy.
9. Add seeding controls and rate limits.
10. Add diagnostics: known packs, trusted packs, stale packs, seeding status.

The first implementation can fetch whole packs without chunking. Chunk hashes and
resumable downloads are required only once pack sizes justify the added
complexity.

---

## Summary

The fingerprint swarm is the public distribution layer for Antseed model
fingerprints. It is torrent-like: announcements are small, packs are fetched by
content hash, any peer can seed verified bytes, and trust is decided locally from
publisher signatures and policy.
