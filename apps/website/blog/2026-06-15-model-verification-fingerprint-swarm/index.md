---
slug: model-verification-fingerprint-swarm
title: "Model Verification Needs More Than a Label"
authors: [antseed]
tags: [protocol, model-verification, decentralized-ai, P2P AI, cryptography, fingerprints]
description: How Antseed turns AI API responses into attributable evidence, then builds toward black-box model fingerprints and a torrent-like public fingerprint swarm.
keywords: [AI model verification, LLM fingerprinting, ResponseAuth, decentralized AI, P2P AI, KBF, fingerprint swarm, model substitution, shadow APIs]
image: /og-image.jpg
date: 2026-06-15
---

Most AI APIs ask you to trust the label.

gpt-5.5 |
claude-opus-4.8 |
minimax-m3 |
premium model

But if an endpoint silently routes you to a cheaper model, mixes traffic across providers, wraps another API, or serves a quantized substitute, what evidence do you actually have?

Usually: almost none.

Antseed is building the missing verification layer for that market.

<!-- truncate -->

## The Label Is Not Evidence

The problem is not hypothetical. The paper [Real Money, Fake Models](https://arxiv.org/abs/2603.01919) audits shadow APIs that claim to serve official frontier models and finds divergence across utility, safety, and identity verification. The economic incentive is obvious: charge for the expensive model, serve something cheaper, pocket the spread.

Centralized APIs can ask users to trust brand, contracts, or customer support. A peer-to-peer market cannot depend on any of that. Antseed sellers are independent peers. Buyers need evidence that travels with the response.

That starts with a distinction that matters:

Signed responses do not prove model identity.

They prove who served which bytes.

That is the base layer. Once a seller's responses are attributable, buyers can run black-box model verification on top. Cryptographic provenance first. Statistical model auditing second.

## What Is Already Implemented: ResponseAuth

Antseed now has a signed response-authentication substrate in `@antseed/node`.

For supported buyer-seller connections, the seller signs a `ResponseAuthPayload` after serving a response. The payload commits to:

- the request hash;
- the response hash;
- buyer peer id;
- seller peer id;
- advertised service;
- provider name;
- status code;
- timing;
- optional payment channel id.

The buyer verifies the signature against the seller peer identity and stores the result in local verification storage. A random sample of verified exchanges can also be written to disk as full evidence:

```text
<dataDir>/verification_samples/
  <sellerPeerId>/
    <sampleId>/
      manifest.json
      request.bin
      response.bin
```

This does not tell us whether the response came from the claimed model. It tells us that the seller cannot later deny serving those exact bytes. That is the difference between a complaint and evidence.

## What Comes Next: Fingerprint Verifiers

The next layer is a verifier suite, not one magic test.

Different cheats leave different traces. A cheap substitute might fail knowledge-boundary probes. A wrapper around a real model might show instruction-hierarchy artifacts. A relay might reveal itself through runtime behavior. A model family may have rare-token or perturbation signatures.

The model-verification spec tracks several verifier families:

- **KBF**: knowledge-boundary fingerprinting with numeric probes near the claimed model's edge of knowledge. See [Knowledge Boundary Fingerprinting](https://arxiv.org/abs/2605.29524) and the [KBF reference implementation](https://github.com/Ooo0ption/KBF).
- **LLMmap-style behavioral probes**: active prompts selected because model families respond differently. See [LLMmap](https://www.usenix.org/conference/usenixsecurity25/presentation/pasquini).
- **TRAP-style adversarial triggers**: private prompts that elicit distinctive target-model behavior. See [TRAP](https://arxiv.org/abs/2402.12991).
- **ZeroPrint-style perturbation fingerprints**: compare how responses change under semantic-preserving input variations. See [ZeroPrint](https://arxiv.org/abs/2510.06605).
- **UTF / rare-token fingerprints**: probe behavior around under-trained or unusual tokens. See [UTF](https://aclanthology.org/2025.llmsec-1.1/).
- **LLMPrint-style prompt-injection fingerprints**: exercise instruction hierarchy and prompt-injection behavior. See [LLMPrint](https://openreview.net/forum?id=ND0q3wjNgW).
- **Julius-style service fingerprints**: identify serving stacks such as Ollama, vLLM, LiteLLM, and other LLM API runtimes. See [Julius](https://www.praetorian.com/blog/introducing-julius-open-source-llm-service-fingerprinting/) and its [open-source repository](https://github.com/praetorian-inc/julius).
- **READER-style passive provenance**: analyze ordinary signed responses after the fact with reader/provenance models. See [READER](https://arxiv.org/abs/2606.10794).

None of these should be treated as absolute truth alone. The point is to build a suite where independent signals compound. A `SAME` result is not a certificate. A strong `DIFF` result, backed by signed response evidence and reproducible references, becomes something a buyer can act on.

## Why Public Fingerprints Should Behave Like Torrents

Private probes matter for adversarial enforcement. If every seller can see the exact test set, a dishonest seller can route those prompts to the real model and serve cheap responses for everything else.

But public fingerprints still matter.

They are useful for reproducibility, smoke tests, shared baselines, research, and network-wide learning. The question is how to distribute them without turning Antseed into another centralized API or hosted database.

The answer in the spec is a fingerprint swarm.

Think torrent, not registry:

| Torrent concept | Antseed fingerprint swarm |
|---|---|
| `.torrent` / magnet metadata | fingerprint pack announcement |
| info hash | `packId` |
| tracker / DHT | Antseed discovery topics |
| seeders | peers mirroring verified packs |
| downloaded files | signed fingerprint packs |
| piece hashes | optional chunk hashes |
| uploader identity | publisher peer id + signature |

A fingerprint pack is a signed, content-addressed bundle. Peers announce small metadata. Other peers fetch the pack from any mirror or seeder, verify the content hash, verify the publisher signature, and decide locally whether to trust it.

The trust model is simple:

```text
Discovery tells me a pack exists.
Storage gives me bytes.
Hash proves the bytes are correct.
Signature proves who published the pack.
Local trust policy decides whether I use it.
```

No central server has to be the source of truth. GitHub can be a review surface and bootstrap mirror. IPFS, Arweave, HTTPS mirrors, and Antseed peers can all serve the same pack bytes. The pack is valid if the hash and signature check out.

## What This Enables

The long-term flow looks like this:

1. A seller advertises a model or service.
2. The buyer sends normal requests through Antseed.
3. The seller signs response provenance with ResponseAuth.
4. The buyer stores verified evidence locally.
5. The buyer imports trusted public fingerprint packs from the swarm.
6. The buyer keeps private references for stronger audits.
7. The buyer runs fingerprint verifiers locally.
8. Local routing avoids sellers with bad evidence.
9. Disputes and slashing come later, only after off-chain verification.

The important part is the ordering. We do not start with slashing. We start by making responses attributable, then make verification local, then make public fingerprints easy to share, then build dispute machinery only once the evidence format is mature.

## What Gets Built Next

The merged specs define the implementation path:

- `@antseed/fingerprints`: shared verifier interfaces, reference schemas, pack schemas, canonical hashing, and KBF as the first verifier.
- Fingerprint swarm support: signed pack announcements, content-addressed fetches, peer seeding, mirrors, and local trust policy.
- Buyer reference store: trusted references under `<dataDir>/fingerprints/references`.
- Audit runner: send normal Antseed requests, require verified ResponseAuth, force-store audit evidence, compute verifier results.
- Local routing policy: downgrade or avoid sellers with repeated adverse evidence.
- Dispute path later: commit-reveal, off-chain exhibit verification, and compact on-chain slash signals only for confirmed substitution.

The first shipped piece is already there: signed response provenance.

Everything else builds on that.

## The Bigger Point

AI infrastructure is moving from branded endpoints to markets of interchangeable providers, routers, resellers, agents, wrappers, and local runtimes. In that world, "trust me, this is the model" is not enough.

The market needs public, inspectable, reusable model fingerprints.

It also needs private probes, because public tests can be gamed.

And it needs cryptographic provenance, because without attribution, every model-verification result is just a claim.

Antseed is putting those pieces together:

- signed responses for attribution;
- black-box verifier suites for model identity signals;
- a torrent-like fingerprint swarm for public packs;
- buyer-local audits for enforcement;
- dispute and slashing only after evidence can survive review.

A normal API response is just text.

An Antseed response can become attributable audit evidence.

[Read the model-verification spec](https://github.com/AntSeed/antseed/blob/main/docs/protocol/spec/07-model-verification.md)

[Read the fingerprint-swarm spec](https://github.com/AntSeed/antseed/blob/main/docs/protocol/spec/08-fingerprint-swarm.md)
