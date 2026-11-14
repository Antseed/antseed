---
title: Privacy and verification
slug: /local-ai/privacy
sidebar_label: Privacy and verification
description: How colony pools keep prompts away from the pool operator, what the Mac app's hardening and Apple's device attestation prove, and where the limits are.
---

# Privacy and verification

A request to a colony pool passes through two parties: the pool seller, which routes it, and the worker machine that answers it. Buyers' clients handle the encryption below automatically; nothing needs setting up.

## The pool operator sees ciphertext

- The buyer asks the pool for its top-ranked workers and checks each one's key certificate, signed by the worker's own address, before using it.
- It encrypts the request for those workers only (P-256 key agreement per worker, ChaCha20-Poly1305). The pool sees the model name, whether the answer streams and the token limit, and nothing else.
- The worker encrypts its answer under a key only that buyer and that worker share, with an authenticated end marker. The buyer refuses an answer that doesn't open, was cut short, or reports different token usage in the clear than inside the seal, and pays only for one that verifies.
- A pool refuses plaintext requests, and buyers never send a pool request in plaintext.

By default each request is encrypted for one worker, so only one Mac can ever read it. A buyer's SDK option `colonyPoolRecipients` (2 or 3) trades that for failover: the pool may then try the next worker in the set without a round trip, but any of them could read the request.

## Hardened Macs

The Mac app runs as a signed app with the hardened runtime, keeps its decryption and attestation keys in the Secure Enclave bound to the app, refuses debuggers and stops serving when System Integrity Protection is off. Every 5 minutes it signs an attestation of these protections, its code identity and its model files, which the pool passes to buyers.

**Every current build attests not hardened.** The app hands the decrypted prompt to its bundled engine, a separate process the app's protections don't cover, over an owner-only Unix socket with no network port. So the Mac's owner can still read prompts in the engine's memory. Hardening is also the app's own report, signed by a key it chose, so pools and buyers show it as a label and never require it.

## Apple-verified Macs

A pool operator can run an MDM server and enroll Macs in it. Apple then attests, about once a week, that the Mac with that serial number has SIP on, in a certificate chain that leads to Apple's Enterprise Attestation root and that names the worker and its attestation key. The operator binds each enrolled Mac to the worker that runs on it.

Buyers verify Apple's chain themselves and accept one up to 8 days old. A buyer whose SDK sets `requireAppleVerifiedWorkers` only uses Apple-verified workers. A pool with `COLONY_POOL_REQUIRE_DEVICE_ATTESTATION` only routes to them.

## Limits

- **Not a TEE.** Memory is not encrypted. A kernel exploit or a gap in macOS's enforcement exposes prompts, and so does the engine process today. For hardware-encrypted inference, use [TEE sellers](/docs/verify-tee).
- **Apple vouches for the Mac, not the app.** The owner of an enrolled Mac could run a modified app under the bound worker's key and still present the Mac's attestation.
- **Model reports are self-reported.** Pinned models and file hashes catch a wrong revision or drift, not a modified worker.
- **Routing is the operator's.** The operator chooses which workers get work, within the set each buyer signed.

The [colony pool specification](https://github.com/Antseed/antseed/blob/main/docs/protocol/colony-pool.md) has the exact key schedule, attestation format and checks.
