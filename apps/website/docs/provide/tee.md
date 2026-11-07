---
title: Run a TEE-attested seller
slug: /provide/tee
sidebar_label: TEE seller
description: Run your seller as Antseed's TEE seller image on a dstack confidential VM so buyers can verify your node before they pay.
---

# Run a TEE-attested seller

A seller running on Intel TDX hardware can prove it cryptographically to every buyer, before any payment. This guide takes your seller config (see [Become a provider](/docs/provide)) and runs it as Antseed's TEE seller image on a dstack (Phala) confidential VM, with attestation by the [`antseed-verifier`](https://github.com/AntSeed/antseed/tree/main/packages/antseed-verifier) SDK, so buyers that require verification will route to you.

## How it works

- Your seller loads the SDK's **prover** at startup and advertises the capability `verifier.antseed-verifier` in its discovery metadata.
- A buyer challenges you on the reserved route `/_antseed/attest/antseed-verifier` with a fresh nonce. The prover mints an Intel TDX quote **bound to that nonce, your peer ID and the encrypted connection the buyer is on**, signs the evidence bundle with your identity key, and returns it.
- The buyer verifies the quote against Intel's DCAP certificate chain locally, and checks that its measurements match an [approved TEE seller build](#approved-seller-builds). Attestation runs before provider matching, payment and metering. It is free and unmetered, and limited to 10 attestations per buyer per minute.

If the prover fails to load at startup, the seller exits rather than advertising a capability it can't answer.

## Prerequisites

- A dstack confidential VM host with Intel TDX, such as Phala Cloud, where you can deploy an app with KMS and encrypted environment variables.
- Your seller's identity key and peer ID, and API keys for its upstreams.
- The signaling (TCP) and DHT (UDP) ports reachable from the internet at the same port numbers as in the container. Buyers attest over encrypted TCP; the connection binding is not available over WebRTC.
- Node.js 20+ and a checkout of the [Antseed repository](https://github.com/AntSeed/antseed) on your own machine, to generate the compose file.

## Approved seller builds

Buyers accept a seller node that runs Antseed's official TEE seller image as a dstack (Phala) confidential VM app. The image runs on a distroless runtime with no shell, package manager, runtime plugin installs or dashboard, so its operator has no way into it. From the quote and the evidence the seller sends with it, the buyer checks that:

- MRTD and RTMR0–2 (firmware, VM shape, kernel and boot configuration) are a released dstack production OS listed in the verifier SDK;
- the app compose, which the buyer authenticates against the compose hash replayed from the dstack event log, runs an approved image: one that the **Publish TEE seller image** workflow built from this repository and added to the verifier SDK;
- the compose follows the TEE seller rules: one service, no command or entrypoint override, only the seller data volume and the dstack socket mounted, public logs off, no pre-launch or init scripts, and the seller config inline. Only secrets (the identity key, API keys and the RPC URL) come in as encrypted variables, so every setting that decides where prompts go is readable, and every upstream is HTTPS, with path rewrites that stay on it.

Any seller deploying an approved image this way passes, with no per-seller approval. Buyers also see the upstream hosts the seller config sends prompts to. [`deploy/tee-seller`](https://github.com/AntSeed/antseed/tree/main/deploy/tee-seller) has the image, a compose generator and the deployment steps. Buyers can accept extra OS releases or images locally with `ANTSEED_VERIFIER_NODE_BUILDS` (JSON `{ "os": [{ name, mrtd, rtmr0, rtmr1, rtmr2 }], "images": [{ version, digest }] }`).

## 1. Write your seller config

Write the seller config as for any seller (see [Seller configuration](/docs/provide/config)), with these limits so buyers accept it:

- providers use the `openai`, `anthropic`, `typesafe`, `venice-video` or `alibaba-video` plugin;
- every `baseUrl` is HTTPS, and every `pathRewrite` value is a path on that upstream (starting with `/`);
- each provider sets `apiKeyEnv` to a variable name ending in `_API_KEY` (not starting with `ANTSEED_`, `POSTHOG_` or `CDP_`);
- no setting that loads code or configures another role: `seller.agentDir` (agent tool modules), `plugins`, `buyer`, `verifier` and `relayer` are rejected.

Buyers read the whole config, so don't put keys in URLs.

## 2. Generate the compose file

Pick the release digest from the **Publish TEE seller image** run (or `ghcr.io/antseed/tee-seller` on GitHub), then:

```bash
node deploy/tee-seller/compose.mjs \
  --image ghcr.io/antseed/tee-seller@sha256:<digest> \
  --peer <peerId, without 0x> \
  --config config.json > docker-compose.json
```

It writes a compose file (JSON, which compose also reads) with the image pinned by digest, your config inline, and each secret as an encrypted variable, and it prints the encrypted variables to allow. Add `--rpc-url-secret` to pass `ANTSEED_BASE_RPC_URL` as a secret.

## 3. Deploy it on dstack

Deploy `docker-compose.json` as a dstack app with KMS enabled:

- set the printed variables as encrypted environment variables: `ANTSEED_IDENTITY_HEX` (your identity key, hex) and your API keys, and allow exactly those;
- keep public logs off and add no pre-launch script.

The image starts `antseed seller start` with the verifier's prover, which mints its quotes through the dstack guest agent. Any change to the compose file (image, config, prices) gives a new compose hash, which buyers check against the same rules, so redeploying needs no approval.

## 4. Confirm you're advertising

From any other machine:

```bash
antseed network peer <peerId>
```

The output includes `Verifiers:       antseed-verifier (default)`.

`antseed network browse` also shows a `Verifier` column once any peer advertises one.

## 5. Attest your inference provider too (optional)

The two gating capabilities, `seller-node-tee-genuine` and `seller-bound`, cover your **node**. If your downstream inference provider also runs confidential hardware, the prover can relay its evidence so buyers see it. `seller-provider-tee-genuine`, `seller-provider-gpu-cc` (NVIDIA Confidential Computing) and `seller-provider-measured-image` are reported for buyer policy.

Pass the settings to `compose.mjs` with `--env`, which writes them into the compose file where buyers can read them:

- `ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL`: an endpoint that returns the provider's evidence for a nonce (`{nonce}` → hex);
- `ANTSEED_VERIFIER_PROVIDER_TEE_FIELD`: the JSON field holding the provider's quote;
- `ANTSEED_VERIFIER_PROVIDER_BINDING_SCHEME`: the frozen report_data binding scheme the provider's quote uses, `antseed-rd-v1` (Antseed's canonical scheme) or `nonce-pubkey-sha256-v1` (used by some third-party providers), with `ANTSEED_VERIFIER_PROVIDER_BINDING_PUBKEY_FIELD` naming the field that holds its pubkey;
- optionally `ANTSEED_VERIFIER_PROVIDER_GPU_FIELD`: the per-GPU NVIDIA CC evidence field, which enables `seller-provider-gpu-cc`.

```bash
node deploy/tee-seller/compose.mjs --image ghcr.io/antseed/tee-seller@sha256:<digest> \
  --peer <peerId> --config config.json \
  --env 'ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL=https://provider.example/evidence?nonce={nonce}' \
  --env ANTSEED_VERIFIER_PROVIDER_TEE_FIELD=quote \
  --env ANTSEED_VERIFIER_PROVIDER_BINDING_SCHEME=antseed-rd-v1 \
  --env ANTSEED_VERIFIER_PROVIDER_BINDING_PUBKEY_FIELD=e2e_pubkey > docker-compose.json
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
| `seller-node-tee-genuine` fails with "not an approved TEE seller build" | The detail names the reason: an OS or image the verifier doesn't list (use a released image; a new dstack release needs adding to the verifier), or a compose rule the file breaks (regenerate it with `compose.mjs`) |
| `seller-node-tee-genuine` fails with "no connection binding" | The buyer reached the seller over WebRTC; make the signaling TCP port reachable |
| `seller-bound` missing from verdicts | `ANTSEED_VERIFIER_SIGNING_KEY` unset, or its address doesn't match `ANTSEED_TEE_PEER_ID` |
| Buyer reports TCB failures | Host platform needs microcode/TCB updates; buyers running `ANTSEED_VERIFIER_STRICT_TCB=true` accept only `UpToDate` |

## Developing the prover outside dstack

To work on the prover itself, you can run it on any Intel TDX VM (for example a GCP `c3` confidential VM): install the SDK into `~/.antseed/plugins` from a source checkout (`pnpm --filter @antseed/antseed-verifier build`, then `npm pack` and `npm install --prefix ~/.antseed/plugins` the tarball), set `ANTSEED_TEE_PEER_ID` and `ANTSEED_VERIFIER_SIGNING_KEY`, and start `sudo -E antseed seller start --verifiers antseed-verifier` (quotes come from `configfs-tsm`, which needs root). Buyers see a genuine quote but don't accept such a node: it is not an approved image under the compose rules.

## See also

- [Verify a seller's TEE](/docs/verify-tee): the buyer side of this handshake.
- [AIP-3: Pluggable Verifier SDKs](https://github.com/AntSeed/AIPs/blob/main/AIPS/aip-3.md): the protocol specification.
- [Don't Trust the TEE Label](/blog/dont-trust-the-tee-label): why this exists.
