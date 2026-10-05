---
slug: dont-trust-the-tee-label
title: "Don't Trust the TEE Label: How Antseed Verifies Confidential AI"
authors: [antseed]
tags: [privacy, TEE, security, verification, confidential computing, P2P]
description: "TEE inference is only as private as your ability to verify it. How Antseed lets buyers cryptographically check a seller's secure hardware before routing a single paid request."
keywords: [TEE inference, confidential AI, Intel TDX attestation, verify TEE, private AI, remote attestation, NVIDIA confidential computing, Antseed verifier]
image: /og-image.jpg
date: 2026-07-31
---

Every provider of confidential AI makes the same promise: your prompts are processed inside secure hardware that nobody — not even the operator — can look into. It's a real technology and a strong promise. But on almost every platform, it arrives the same way every other privacy promise does: as a claim on a website, checked by the same company that made it.

Antseed takes a different position — a promise you can't verify yourself is just a policy. So the network now ships the verification: before routing a single paid request, your own node can cryptographically check that the machine on the other end really is the secure hardware it claims to be. This post explains what that hardware protects, why the checking matters as much as the hardware, and how the check actually works — with links to the documentation if you want to go deeper.

<!-- truncate -->

## What a TEE protects

In [Anonymous AI vs Private AI](/blog/anonymous-vs-private-ai) we split privacy into two separate questions: does anyone know a request was *yours*, and can anyone *read* it. Antseed's architecture answers the first question structurally — no accounts, no platform in the middle, [payments that don't identify you](/blog/trust-without-a-middleman).

The second question is harder, because whoever runs the model has to process your prompt — that's inherent to inference anywhere. The strongest available answer is a Trusted Execution Environment (TEE): a mode of modern server hardware that runs a workload inside a sealed compartment, encrypted in memory, that the machine's own operating system and administrators cannot see into. Intel's version, called TDX, seals the processor side; NVIDIA's Confidential Computing extends the seal to the GPUs where the model actually runs.

Put the two axes together and you reach the corner of the privacy map that centralized platforms can't offer: nobody knows the request is yours, and the operator serving it can't read it. A platform can promise not to look. A sealed compartment can't look.

## A claim of secure hardware is not secure hardware

From the outside, a server running in a TEE and a server merely claiming to run in one look identical. The responses are the same bytes. If "TEE-secured" is just a label on a service listing, it protects nothing.

What makes the claim checkable is a hardware feature called remote attestation. The chip itself can produce a *quote* — a signed statement, traceable to the chip maker's published root keys, that says: this exact software is running inside a genuine sealed compartment on genuine hardware. Anyone can check that signature against Intel's public certificates, without trusting the machine's operator at all.

Here is the part most confidential-AI products get wrong. They do run attestation — and then check it for you, on their own servers, behind the same dashboard you were already trusting. The proof exists, but the checking is centralized, which quietly restores the exact trust the hardware was meant to remove.

On Antseed, your node does the checking. It challenges the seller directly, receives the evidence over the same encrypted peer-to-peer connection the request would travel on, and verifies it locally against Intel's certificates — before any payment happens. There is no one between you and the proof.

## How verification works on the network

The mechanism is deliberately small. A *verifier* is a package with two halves: one half runs on the seller and answers challenges; the other runs on the buyer and checks the answers. Sellers announce which verifiers they can answer the same way they announce prices and models, so your node learns who can prove what during normal discovery.

When your node picks a seller that advertises verification, it runs the check before anything is paid or metered — verification is free by construction, and it happens on a reserved path that never touches the seller's billing. By default the check is advisory: your node verifies whoever it can and records the result. Add one flag — `--require-verifier` — and it becomes a hard rule: no verified hardware, no traffic.

One more boundary matters. Verification code is security-critical, so your node only ever runs verifiers from a curated list, pinned to an exact version. A seller can advertise anything it likes; code outside your pinned list is never downloaded or run, and nobody upstream can silently change what checks run on your machine.

Details: [Verify a seller's TEE](/docs/guides/verify-tee) · [The protocol specification (AIP-3)](https://github.com/AntSeed/AIPs/blob/main/AIPS/aip-3.md)

## What the first verifier proves

The first verifier SDK, [antseed-verifier](https://github.com/AntSeed/antseed/tree/main/packages/antseed-verifier), checks Intel TDX. A passing verdict rests on two proofs, both required:

**The hardware is genuine, and the proof is fresh.** Your node sends the seller a random challenge number, used once. The seller's hardware mints a quote bound to that exact number, and your node verifies the quote's signature chain up to Intel's root certificates — confirming a genuine TDX machine, with its security patches at an acceptable level and debugging switched off. A recorded quote from an earlier session, a machine faking it in software, or an enclave borrowed from someone else all fail.

**The hardware belongs to the seller you're paying.** The seller signs the whole evidence bundle with the same identity key it uses on the network, so the proof is tied to the exact peer you selected — not relayed from some other machine that happens to be genuine.

Together, the two proofs say: *the node you are about to pay is a genuine Intel TDX machine, attested fresh for this exchange, under the identity you chose.* Not a label — a proof.

Beyond those two, the verifier reports additional evidence your node can use in its routing decisions: whether the seller's downstream inference provider also runs in genuine sealed hardware, whether that provider's GPUs run NVIDIA Confidential Computing (checked against NVIDIA's own attestation service), and whether the software inside the compartment matches a list of measurements you approve. And none of it is tied to one vendor — pointing a seller at a different confidential-computing provider is a configuration change, not new code. The whole chain has been validated end-to-end on real Intel TDX hardware, including against a live third-party provider.

Details: [Run a TEE-attested seller](/docs/guides/tee-provider)

## What attestation does — and doesn't — prove

Trust requires honesty about limits, so here are this feature's, stated plainly.

A passing verdict proves the seller was genuine, sealed hardware, freshly attested, under the identity you chose — *at the moment of attestation*. What it does not yet do is cryptographically tie every response byte that follows to that same sealed compartment: today the proof gates where your traffic goes, and is refreshed as you keep routing, but the responses themselves are not individually signed by a key held inside the hardware. That stronger binding — a signing key created inside the compartment, attested along with it, signing every response — is the agreed next milestone for the verifier, with a working reference implementation already running.

It's also worth being precise about what question attestation answers. It proves the *environment* — sealed, genuine, yours-to-verify. Whether the *model* behind the service is the one advertised is a different question, answered by different evidence: [reputation and recognized usage](/blog/trust-without-a-middleman) tell you a seller has a history of delivering, and [model fingerprinting](/blog/model-verification-fingerprint-swarm) probes what's actually answering. Different questions, different proofs — attestation adds the missing one.

## Try it

Any buyer can demand verified hardware today with one flag:

```bash
antseed buyer start --verifiers antseed-verifier --require-verifier
```

Two new guides walk through both sides: [running a TEE-attested seller](/docs/guides/tee-provider) — provisioning the hardware, loading the prover, wiring a confidential inference provider behind it — and [verifying a seller's TEE](/docs/guides/verify-tee) — the policy flags, what each check means, and how to read a verdict.

The claim underneath all of this is the same one the rest of Antseed makes. Confidential AI that asks you to trust the operator's dashboard isn't confidential — it's outsourced. Here, the hardware's proof, Intel's certificates, the verifier code your node runs, and the protocol that carries the challenge are all public and inspectable. You don't have to take the label on faith — and that's precisely the point.
