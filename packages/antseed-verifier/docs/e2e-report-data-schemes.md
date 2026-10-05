# E2E report_data schemes: standard flow and Chutes-provider flow

Both flows use ONE test seller node (a GCP `c3` Intel TDX VM) and ONE buyer. They differ
only in the **provider**. The standard flow uses a provider stand-in that mints the canonical
`antseed-rd-v1` binding. The Chutes flow points the same seller at a live Chutes chute with
the foreign `nonce-pubkey-sha256-v1` binding. Nothing in the SDK is provider-specific. The
only difference is config.

What's verified where:
- `seller-node-tee-genuine`: the seller node's own configfs quote, bound with
  **`antseed-rd-v1` `{peerId}`** (validated on real TDX hardware: the configfs quote's
  report_data equals `antseedRdV1.build(nonce, {peerId})`, DCAP `UpToDate`).
- `seller-bound`: the seller signs the bundle. The buyer recovers peerId.
- `seller-provider-tee-genuine`: the provider quote, verified against its **declared frozen
  scheme** (`antseed-rd-v1` for the stand-in, `nonce-pubkey-sha256-v1` for Chutes). The
  machinery is `src/report-data.ts` and the provider capability binding check.
- `seller-provider-measured-image`: MRTD/RTMR vs a buyer allow-list (env policy, A5).
- `seller-provider-gpu-cc`: NRAS. See the GPU caveat under the Chutes flow.

Provision and stage the seller and buyer the usual way (a c3 Intel TDX VM, `npm pack` the SDK into
the seller's `~/.antseed/plugins`, run the seller as root so `configfs` quote minting works).
This document covers only the provider wiring.

---

## Standard flow: provider stand-in minting `antseed-rd-v1`

A small provider generates a key inside the (same) TDX VM. It mints a quote bound to
`antseed-rd-v1 {e2ePubkey}`. It serves `{quote, e2e_pubkey}`. Run it on the seller VM
(`:9000`). It imports the SDK's own exports so the bytes match the buyer's recompute exactly:

```js
// provider-standin.mjs  (run with:  sudo node provider-standin.mjs   -- configfs needs root)
import { createServer } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { antseedRdV1, generateTdxQuote } from '@antseed/antseed-verifier'

// One TEE-generated key for this instance; its pubkey is bound into report_data.
const { publicKey } = generateKeyPairSync('ed25519')
const e2ePubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

createServer((req, res) => {
  const nonceHex = new URL(req.url, 'http://x').searchParams.get('nonce')
  const nonce = Buffer.from(nonceHex, 'hex')
  const reportData = antseedRdV1.build(nonce, { e2ePubkey })   // SAME builder the buyer uses
  const quote = generateTdxQuote(reportData)                    // configfs-tsm, 64-byte report_data
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ quote: Buffer.from(quote).toString('base64'), e2e_pubkey: e2ePubkey }))
}).listen(9000)
```

Seller env (add two lines to the seller config):

```bash
export ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL='http://127.0.0.1:9000/evidence?nonce={nonce}'
export ANTSEED_VERIFIER_PROVIDER_TEE_FIELD=quote
export ANTSEED_VERIFIER_PROVIDER_BINDING_SCHEME=antseed-rd-v1          # NEW: declare the scheme
export ANTSEED_VERIFIER_PROVIDER_BINDING_PUBKEY_FIELD=e2e_pubkey       # NEW: the pubkey ingredient
```

Run the buyer (`--require-verifier --verifiers antseed-verifier --peer <SELLER_PEER_ID>`).
Expected verdict:
- `seller-node-tee-genuine` PASS. The antseed-rd-v1 `{peerId}` binding matches this round.
- `seller-bound` PASS.
- `seller-provider-tee-genuine` PASS. The provider quote's report_data equals
  `antseed-rd-v1 {e2ePubkey}` for this nonce. Flip one byte of the stand-in's pubkey and it
  must fail with `report_data does not match scheme "antseed-rd-v1"`.

---

## Chutes flow: a live Chutes chute as the provider

The Chutes evidence endpoint is Bearer-authed. It returns an **array** of instances. It binds
`report_data[0:32] = SHA-256(nonce_hex ‖ e2e_pubkey_b64)`, the frozen
`nonce-pubkey-sha256-v1` scheme (verified from the `chutes-api` docs and code). A small local
shim handles two prerequisites that the SDK does not do itself (no SDK change, no Chutes code):

1. **Auth and instance selection.** Run a local reverse proxy on `:9000`. The proxy adds
   `Authorization: Bearer $CHUTES_API_KEY`, forwards `?nonce=` to
   `GET https://api.chutes.ai/chutes/{chute}/evidence?nonce={nonce}`, and returns **one**
   instance object (for example, `body[0]`) flattened to `{quote, e2e_pubkey}`. The proxy is
   about 20 lines of Node.
2. **GPU nonce (only if you test gpu-cc).** See the caveat below. It needs one probe first.

Seller env (identical shape to the standard flow, only the scheme id and URL differ):

```bash
export ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL='http://127.0.0.1:9000/evidence?nonce={nonce}'  # local shim → Chutes
export ANTSEED_VERIFIER_PROVIDER_TEE_FIELD=quote
export ANTSEED_VERIFIER_PROVIDER_BINDING_SCHEME=nonce-pubkey-sha256-v1   # the ONLY real difference
export ANTSEED_VERIFIER_PROVIDER_BINDING_PUBKEY_FIELD=e2e_pubkey
```

Run the buyer as before. Expected:
- `seller-node-tee-genuine`, `seller-bound` PASS (unchanged, this is the seller node).
- `seller-provider-tee-genuine` PASS. The **Chutes** quote's report_data equals
  `SHA-256(nonce_hex ‖ e2e_pubkey_b64)` for this round. This proves, in a generic way, that the
  Chutes instance minted a fresh quote for the nonce and that its E2E pubkey is enclave-born.
- `seller-provider-measured-image`: set `ANTSEED_VERIFIER_MEASURED_IMAGE_POLICY` to the Chutes
  published reference measurements to PASS. Otherwise it reports "no approved measurement set".

The seller config is byte-for-byte the standard flow except `BINDING_SCHEME` and the URL.
This is the point: you swap providers with config only. Each provider's binding is a frozen
registry entry that the buyer verifies, not provider-specific SDK code.

### GPU-CC nonce (confirmed against live Chutes)

`seller-provider-gpu-cc` submits an NRAS nonce and checks `eat_nonce`. A live Chutes Blackwell
instance confirms this: the GPU evidence binds the **derived**
`SHA-256(nonce_hex ‖ pubkey_b64)` (= `noncePubkeySha256V1.gpuNonce`), NOT the raw nonce.
NRAS returns `x-nvidia-overall-att-result: true` for the derived value and `false` for the
raw one. The remaining work is only mechanical wiring:
1. Reshape the Chutes `gpu_evidence` (a flat `[{arch, evidence, certificate}]`) into the SDK's
   `{arch, evidence_list: [{evidence, certificate}]}`. This is the shim's job, with the auth and
   instance join that it already does.
2. Wire `gpu-cc` to submit `scheme.gpuNonce(nonce, {e2ePubkey})` when a provider binding
   scheme is configured. It submits the raw nonce by default.

Both tasks are small. The nonce derivation itself is proven.

---

## What's verified

- **Unit (141 tests):** the `report-data.ts` schemes, node convergence to
  `antseed-rd-v1 {peerId}`, and the provider capability's scheme-binding check (pass and fail-closed).
- **Live Chutes (`Qwen/Qwen3-32B-TEE`), through the real SDK code path:** a fetched provider quote
  DCAP-verifies `UpToDate` (genuine TD10, debug off). Its `report_data[0:32]` matches
  `nonce-pubkey-sha256-v1` for a buyer-chosen nonce (5/5 joined instances). The
  `seller-provider-tee-genuine` capability returns `ok: true, "bound to this round"` through the
  actual collector, `verifyTdxEvidence`, and provider-capability path. GPUs are Blackwell in CC mode.
  The derived GPU nonce verifies at NRAS (`overall-att-result: true`).
- **Hardware (GCP TDX):** the node configfs quote's report_data equals the computed bytes and
  DCAP-verifies.
