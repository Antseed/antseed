---
title: Run a TEE-attested seller
slug: /provide/tee
sidebar_label: TEE seller
description: Add Intel TDX attestation to an existing seller with the antseed-verifier SDK so buyers can verify your node before they pay.
---

# Run a TEE-attested seller

A seller running on Intel TDX hardware can prove it cryptographically to every buyer, before any payment. This guide takes an existing seller (see [Become a provider](/docs/provide)) and adds TEE attestation with the [`antseed-verifier`](https://github.com/AntSeed/antseed/tree/main/packages/antseed-verifier) SDK, so buyers that require verification will route to you.

## How it works

- Your seller loads the SDK's **prover** at startup and advertises the capability `verifier.antseed-verifier` in its discovery metadata.
- A buyer challenges you on the reserved route `/_antseed/attest/antseed-verifier` with a fresh nonce. The prover mints an Intel TDX quote **bound to that nonce, your peer ID and the encrypted connection the buyer is on**, signs the evidence bundle with your identity key, and returns it.
- The buyer verifies the quote against Intel's DCAP certificate chain locally, and checks that its measurements match an [approved TEE seller build](#approved-seller-builds). Attestation runs before provider matching, payment and metering. It is free and unmetered, and limited to 10 attestations per buyer per minute.

If the prover fails to load at startup, the seller exits rather than advertising a capability it can't answer.

## Prerequisites

- A genuine **Intel TDX** VM, for example a GCP `c3` confidential VM (Ubuntu 24.04) with TDX enabled. The prover mints quotes through `configfs-tsm` (`/sys/kernel/config/tsm/report`), which only exists on real TDX hardware and requires **root**.
- A working seller (`antseed seller start` serving requests) on that VM, reachable by buyers over encrypted TCP (its signaling port). The connection binding is not available over WebRTC.
- Node.js 20+.

## Approved seller builds

Buyers accept a seller node that runs Antseed's official TEE seller image as a dstack (Phala) confidential VM app. The image runs on a distroless runtime with no shell, package manager, runtime plugin installs or dashboard, so its operator has no way into it. From the quote and the evidence the seller sends with it, the buyer checks that:

- MRTD and RTMR0–2 (firmware, VM shape, kernel and boot configuration) are a released dstack production OS listed in the verifier SDK;
- the app compose, which the buyer authenticates against the compose hash replayed from the dstack event log, runs an approved image: one that the **Publish TEE seller image** workflow built from this repository and added to the verifier SDK;
- the compose follows the TEE seller rules: one service, no command or entrypoint override, only the seller data volume and the dstack socket mounted, public logs off, no pre-launch or init scripts, and the seller config inline. Only secrets (the identity key, API keys and the RPC URL) come in as encrypted variables, so every setting that decides where prompts go is readable, and every upstream is HTTPS.

Any seller deploying an approved image this way passes, with no per-seller approval. Buyers also see the upstream hosts the seller config sends prompts to. [`deploy/tee-seller`](https://github.com/AntSeed/antseed/tree/main/deploy/tee-seller) has the image, a compose generator and the deployment steps. Buyers can accept extra OS releases or images locally with `ANTSEED_VERIFIER_NODE_BUILDS` (JSON `{ "os": [{ name, mrtd, rtmr0, rtmr1, rtmr2 }], "images": [{ version, digest }] }`).

## 1. Install the verifier SDK

The CLI resolves the ID `antseed-verifier` to the npm package `@antseed/antseed-verifier` at a pinned version, and installs it into `~/.antseed/plugins` on first use.

To test an unpublished source checkout, install it into the plugins directory from the monorepo package:

```bash
git clone https://github.com/AntSeed/antseed.git
cd antseed
pnpm install
pnpm --filter @antseed/antseed-verifier build
cd packages/antseed-verifier
npm pack
npm install --prefix ~/.antseed/plugins ./antseed-antseed-verifier-*.tgz
```

The loader expects the package at `~/.antseed/plugins/node_modules/@antseed/antseed-verifier`.

## 2. Configure the prover

The prover reads its configuration from the environment only, never from buyer-supplied values:

```bash
# Required: your peer ID (EVM address, without 0x)
export ANTSEED_TEE_PEER_ID=<peerId>

# Recommended: your seller identity key (hex). Enables the seller-bound
# capability: the evidence bundle is signed so buyers can recover your peer ID.
# Disabled automatically if the key's address doesn't match ANTSEED_TEE_PEER_ID.
export ANTSEED_VERIFIER_SIGNING_KEY=<hex-private-key>

# Node quote source. Defaults to configfs; leave unset on a standard TDX VM.
# export ANTSEED_VERIFIER_NODE_TEE=configfs
```

## 3. Start the seller with the verifier

```bash
sudo -E antseed seller start --verifiers antseed-verifier
```

`sudo` is needed because `configfs` quote minting requires root; `-E` keeps your environment.

You can enable the verifier three ways, in precedence order:

1. `--verifiers antseed-verifier` on the command line
2. `ANTSEED_VERIFIER_SDKS=antseed-verifier` in the environment
3. `"verifiers": ["antseed-verifier"]` under `seller` in `~/.antseed/config.json` (the `antseed seller setup` wizard can write this)

The first ID in the list becomes your advertised default. On success the seller prints:

```text
Verifier prover embedded: antseed-verifier
Verifiers advertised: antseed-verifier
```

## 4. Confirm you're advertising

From any other machine:

```bash
antseed network peer <peerId>
```

The output includes `Verifiers:       antseed-verifier (default)`.

`antseed network browse` also shows a `Verifier` column once any peer advertises one.

## 5. Attest your inference provider too (optional)

The two gating capabilities, `seller-node-tee-genuine` and `seller-bound`, cover your **node**. If your downstream inference provider also runs confidential hardware, the prover can relay its evidence so buyers see it. `seller-provider-tee-genuine`, `seller-provider-gpu-cc` (NVIDIA Confidential Computing) and `seller-provider-measured-image` are reported for buyer policy:

```bash
# An endpoint that returns the provider's evidence for a nonce ({nonce} → hex)
export ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL='http://127.0.0.1:9000/evidence?nonce={nonce}'
export ANTSEED_VERIFIER_PROVIDER_TEE_FIELD=quote

# The frozen report_data binding scheme the provider's quote uses:
#   antseed-rd-v1            Antseed's canonical scheme
#   nonce-pubkey-sha256-v1   used by some third-party providers
export ANTSEED_VERIFIER_PROVIDER_BINDING_SCHEME=antseed-rd-v1
export ANTSEED_VERIFIER_PROVIDER_BINDING_PUBKEY_FIELD=e2e_pubkey

# Optional: per-GPU NVIDIA CC evidence field → enables seller-provider-gpu-cc
# export ANTSEED_VERIFIER_PROVIDER_GPU_FIELD=gpu_evidence
```

The SDK is provider-agnostic: no vendor hosts or schemas are built in, so pointing it at a different confidential-inference backend is configuration only. For a worked example against a live third-party TDX provider, see the [SDK's end-to-end guide](https://github.com/AntSeed/antseed/blob/main/packages/antseed-verifier/docs/e2e-report-data-schemes.md).

## 6. Test the full loop as a buyer

From a second machine (no special hardware needed):

```bash
antseed buyer start --verifiers antseed-verifier --require-verifier --peer <peerId>
```

Send any request through the buyer proxy. The buyer log shows `Verified <peerId>... via antseed-verifier`.

If attestation fails under `--require-verifier`, the request is refused with a 502 that names the failed claims. That refusal is the guarantee your buyers rely on.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Seller exits at startup with a verifier load error | SDK not installed in `~/.antseed/plugins`, or its version doesn't match the CLI's pinned version |
| `seller-node-tee-genuine` fails locally | Not a genuine TDX VM, not running as root, or `configfs-tsm` unavailable |
| `seller-bound` missing from verdicts | `ANTSEED_VERIFIER_SIGNING_KEY` unset, or its address doesn't match `ANTSEED_TEE_PEER_ID` |
| Buyer reports TCB failures | Host platform needs microcode/TCB updates; buyers running `ANTSEED_VERIFIER_STRICT_TCB=true` accept only `UpToDate` |

## See also

- [Verify a seller's TEE](/docs/verify-tee): the buyer side of this handshake.
- [AIP-3: Pluggable Verifier SDKs](https://github.com/AntSeed/AIPs/blob/main/AIPS/aip-3.md): the protocol specification.
- [Don't Trust the TEE Label](/blog/dont-trust-the-tee-label): why this exists.
