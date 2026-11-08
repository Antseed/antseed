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

- A dstack confidential VM host with Intel TDX where you can deploy an app with KMS and encrypted environment variables, such as Phala Cloud. Phala Cloud exposes app ports only through its TLS gateway, without a public IP or UDP, so the seller also needs a public entry point: run `antseed seller forward --to <app-id>-6882.<cluster>.phala.network --peer <peerId>` on any small machine with a public IP, set `seller.publicAddress` to its `<ip>:6882`, and raise `seller.maxInboundConnectionsPerIp`, since every buyer then arrives from the gateway's address. The forwarder sees only ciphertext. To run on Google Cloud instead, see [Google Confidential Space](#google-confidential-space).
- Your seller's identity key and peer ID, and API keys for its upstreams.
- The signaling (TCP) and DHT (UDP) ports reachable from the internet at the same port numbers as in the container. Buyers attest over encrypted TCP; the connection binding is not available over WebRTC.
- Node.js 20+ and a checkout of the [Antseed repository](https://github.com/AntSeed/antseed) on your own machine, to generate the compose file.

## Approved seller builds

Buyers accept a seller node that runs Antseed's official TEE seller image as a dstack (Phala) confidential VM app. The image runs on a distroless runtime with no shell, package manager, runtime plugin installs or dashboard, so its operator has no way into it. From the quote and the evidence the seller sends with it, the buyer checks that:

- MRTD and RTMR0–2 (firmware, VM shape, kernel and boot configuration) are a released dstack production OS listed in the verifier SDK;
- the app compose, which the buyer authenticates against the compose hash replayed from the dstack event log, runs an approved image: one that the **Publish TEE seller image** workflow built from this repository and added to the verifier SDK;
- the compose follows the TEE seller rules: one service, no command or entrypoint override, only the seller data volume and the dstack socket mounted, no pre-launch or init scripts, and the seller config inline. Only secrets (the identity key, API keys and optionally the RPC URL) come in as encrypted variables, so every setting that decides where prompts go is readable, and every upstream is HTTPS, with path rewrites that stay on it.

Any seller deploying an approved image this way passes, with no per-seller approval. Buyers also see the upstream hosts the seller config sends prompts to. [`deploy/tee-seller`](https://github.com/AntSeed/antseed/tree/main/deploy/tee-seller) has the image, a compose generator and the deployment steps. Buyers can accept extra OS releases or images locally with `ANTSEED_VERIFIER_NODE_BUILDS` (JSON `{ "os": [{ name, mrtd, rtmr0, rtmr1, rtmr2 }], "images": [{ version, digest }] }`).

## 1. Write your seller config

Write the seller config as for any seller (see [Seller configuration](/docs/provide/config)), with these limits so buyers accept it:

- providers use the `openai`, `anthropic`, `typesafe`, `venice-video` or `alibaba-video` plugin;
- every `baseUrl` is HTTPS, and every `pathRewrite` value is a path on that upstream (starting with `/`);
- each provider sets `apiKeyEnv` to a variable name ending in `_API_KEY` (not starting with `ANTSEED_`, `POSTHOG_` or `CDP_`);
- no setting that loads code or configures another role: `seller.agentDir` (agent tool modules), `plugins`, `buyer`, `verifier` and `relayer` are rejected.

Buyers read the whole config, so don't put keys in URLs.

## 2. Generate the compose file

Use an image digest listed in the verifier's [approved images](https://github.com/AntSeed/antseed/blob/main/packages/antseed-verifier/src/approved-seller-images.ts) (buyers accept only those, from the verifier release that added them), then:

```bash
node deploy/tee-seller/compose.mjs \
  --image ghcr.io/antseed/tee-seller@sha256:<digest> \
  --peer <peerId, without 0x> \
  --config config.json > docker-compose.json
```

It writes a compose file (JSON, which compose also reads) with the image pinned by digest, your config inline, and each secret as an encrypted variable, and it prints the encrypted variables to allow. Add `--rpc-url-secret` to pass `ANTSEED_BASE_RPC_URL` as a secret.

## 3. Deploy it on dstack

Deploy `docker-compose.json` as a dstack app with KMS enabled, on the dstack 0.6.1 OS image and a CPU instance type (`tdx.small` to `tdx.8xlarge` on Phala Cloud), the OS releases and VM shapes buyers accept:

- set the printed variables as encrypted environment variables: `ANTSEED_IDENTITY_HEX` (your identity key, hex) and your API keys, and allow exactly those;
- add no pre-launch script. Public logs may be on: the image runs the seller in content-free mode, so its logs and databases hold no prompts or answers, nor upstream error text about a request, only metadata such as status codes, token counts and buyer peer IDs.

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

## Move an existing seller to the TEE image

Buyers on the current verifier accept only the approved image, deployed as above. A seller that attests from its own build or a plain TDX VM (see [Developing the prover outside dstack](#developing-the-prover-outside-dstack)), or from a dstack compose that breaks the rules, fails `seller-node-tee-genuine` for them; older buyers accept it until they update. To move it:

1. **Keep your identity.** Deploy with the same identity key (`ANTSEED_IDENTITY_HEX`, or the 64 hex characters in `identity.key` in your data directory, if you didn't encrypt it) and set `ANTSEED_TEE_PEER_ID` to the same peer ID. Your registration, stake, reputation and earnings stay with it.
2. **Bring your config within the rules** of [step 1](#1-write-your-seller-config): move every key out of URLs into an `_API_KEY` secret, drop `seller.agentDir`, `plugins` and any `buyer`, `verifier` or `relayer` section, and stop setting `ANTSEED_DEBUG`, which buyers reject. Set `seller.publicAddress` to the new address (on Phala, the forwarder's); buyers find the seller there through the DHT.
3. **Settle before you switch.** The image starts with an empty data directory, and nothing can be copied into it: on Google, the state bucket only takes snapshots the image wrote. A buyer that comes back resumes its channel with the new node, since its next payment authorization covers all it owes. What a buyer that doesn't come back still owes is collected only if the old node settled it, and a node doesn't settle when it stops. So a day ahead, restart the old node with `ANTSEED_SETTLEMENT_IDLE_MS=60000`, so that it settles each channel a minute after its last request (amounts below `payments.minSettleDelta` are skipped), then stop it at a quiet time.
4. **Stop the old node before the new one starts.** Two nodes with one identity would both serve its buyers' channels.
5. Check the new node as in [step 4](#4-confirm-youre-advertising) and [step 6](#6-test-the-full-loop-as-a-buyer).

## Upgrade to a new image

Each image release is added to the verifier's approved images, and buyers accept it from the verifier release that includes it. To move to a new one:

- **dstack:** regenerate the compose file with the new digest and update the existing app in place, keeping its app ID, so that its data volume and encrypted variables stay. Redeploying needs no approval.
- **Google Confidential Space:** the workload identity provider releases secrets and the state bucket only to the image digest in its condition, so allow the new digest first, then restart the VM on it:

  ```bash
  gcloud iam workload-identity-pools providers update-oidc attestation --location=global \
    --workload-identity-pool=antseed-tee \
    --attribute-condition="assertion.swname == 'CONFIDENTIAL_SPACE' && 'STABLE' in assertion.submods.confidential_space.support_attributes && assertion.submods.container.image_digest in ['sha256:<old digest>', 'sha256:<new digest>']"
  gcloud compute instances add-metadata antseed-tee-seller --zone=<zone> \
    --metadata=tee-image-reference=ghcr.io/antseed/tee-seller@sha256:<new digest>
  gcloud compute instances stop antseed-tee-seller --zone=<zone>
  gcloud compute instances start antseed-tee-seller --zone=<zone>
  ```

  The new image restores the state the old one saved. If the old one stopped without its last save, the new one waits up to 2 minutes for its lease, and at most the last 30 seconds of payment updates are lost. Once it serves, remove the old digest from the condition.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `seller-node-tee-genuine` fails with "not an approved TEE seller build" | The detail names the reason: an OS or image the verifier doesn't list (use a released image; a new dstack release needs adding to the verifier), or a compose rule the file breaks (regenerate it with `compose.mjs`) |
| `seller-node-tee-genuine` fails with "no connection binding" | The buyer reached the seller over WebRTC; make the signaling TCP port reachable |
| `seller-bound` missing from verdicts | `ANTSEED_VERIFIER_SIGNING_KEY` unset, or its address doesn't match `ANTSEED_TEE_PEER_ID` |
| Buyer reports TCB failures | Host platform needs microcode/TCB updates; buyers running `ANTSEED_VERIFIER_STRICT_TCB=true` accept only `UpToDate` |

On Google Confidential Space, the seller's startup lines (prefixed `[tee-seller]`, in Cloud Logging) name the problem:

| Log line | Cause |
|---|---|
| `set ANTSEED_GCP_STATE to the gs://<bucket>/<prefix> …` | No state location; the image doesn't start without one |
| `bucket listing answered HTTP 404` | The bucket in `ANTSEED_GCP_STATE` doesn't exist |
| `sts.googleapis.com answered HTTP …`, or HTTP 403 from Secret Manager or Cloud Storage | The workload identity provider's condition doesn't name the running image's digest (see [Upgrade to a new image](#upgrade-to-a-new-image)), or the pool lacks access to that secret or bucket |
| `another seller instance holds …/lease until …; waiting` | Another VM serves this seller, or the previous one stopped without releasing its lease; this one starts when it is released or expires, within 2 minutes |
| `… was not written by this seller identity` | The state prefix holds another seller's state; give each seller its own prefix |

## Google Confidential Space

The same image also runs on Google Confidential Space: a Google-built OS that runs one container on an Intel TDX VM with no operator access. There the seller sends Google's signed attestation token instead of a quote, and buyers check that it shows Intel TDX, a production image with debugging off, an approved image digest and this round's binding. The operator's settings appear in the token, so buyers check the seller config and its upstreams against the same rules; secrets come from Secret Manager, released only to the attested image. Buyers rely on Google's attestation service here, where on dstack they check the Intel quote themselves.

Confidential Space keeps no data across a VM restart, so the image keeps the seller's payment channels and metering in Cloud Storage under a location you must name (`ANTSEED_GCP_STATE`): restored on boot, saved while they change (payments every 30 seconds, metering every 5 minutes) and once more when the seller stops, encrypted with a key derived from the seller identity. Like its logs, which may go to Cloud Logging, they hold no prompts or responses. The setup steps are in [`deploy/tee-seller`](https://github.com/AntSeed/antseed/tree/main/deploy/tee-seller#run-a-tee-seller-on-google-confidential-space).

## Developing the prover outside dstack

To work on the prover itself, you can run it on any Intel TDX VM (for example a GCP `c3` confidential VM): install the SDK into `~/.antseed/plugins` from a source checkout (`pnpm --filter @antseed/antseed-verifier build`, then `npm pack` and `npm install --prefix ~/.antseed/plugins` the tarball), set `ANTSEED_TEE_PEER_ID` and `ANTSEED_VERIFIER_SIGNING_KEY`, and start `sudo -E antseed seller start --verifiers antseed-verifier` (quotes come from `configfs-tsm`, which needs root). Buyers see a genuine quote but don't accept such a node: it is not an approved image under the compose rules.

## See also

- [Verify a seller's TEE](/docs/verify-tee): the buyer side of this handshake.
- [AIP-3: Pluggable Verifier SDKs](https://github.com/AntSeed/AIPs/blob/main/AIPS/aip-3.md): the protocol specification.
- [Don't Trust the TEE Label](/blog/dont-trust-the-tee-label): why this exists.
