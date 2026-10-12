# @antseed/antseed-verifier

Verifier SDK for AntSeed's pluggable verifier system (AIP-3). One package has two halves. A
**buyer verifier** (default export) challenges a seller. It checks the seller's Intel TDX
attestation before it routes paid requests. An embedded **seller prover** (`prover` export,
loaded with `--verifiers antseed-verifier`) answers those challenges before provider
matching and payment.

```ts
import verifier, { prover } from '@antseed/antseed-verifier'
// verifier → default export (type:'verifier', buyer half)
// prover   → named export   (type:'prover',  seller half)
```

It attests a menu of independent **capabilities**. Each capability is one claim, namespaced
`antseed-verifier:<capability>`. The seller offers only the capabilities that its infrastructure
supports. The buyer's verdict gates on two capabilities and reports the others for policy.
Provider differences are config only (generic `configfs` or `http` collectors). The SDK carries
no provider-specific hosts or schemas, and it is self-contained (no peer dependencies).

## Capabilities

| Capability | Proves | Verdict |
|---|---|---|
| `seller-node-tee-genuine` | the seller **node** runs in a genuine Intel TDX enclave (DCAP: PCK chain to Intel's root, acceptable TCB, TD10, debug off). The quote binds to this nonce + peerId | **required** |
| `seller-bound` | the seller's identity key signs the whole evidence bundle for this fresh nonce (the signer recovers to peerId) | **required** |
| `seller-provider-tee-genuine` | the downstream inference **provider's** TEE is genuine TDX. It is also round-bound when the seller declares a `report_data` scheme | informational |
| `seller-provider-gpu-cc` | the provider's GPUs run NVIDIA Confidential Computing (NVIDIA NRAS verifies it, nonce-bound) | informational |
| `seller-provider-measured-image` | the provider quote's MRTD/RTMR match a buyer allow-list | informational |
| `seller-provider-claims` | named provider claims against a frozen SDK menu. Each claim is `asserted` (self-vouched) or `tdx-quote` (TEE-attested) | informational |

The two required capabilities together prove one thing: *a genuine Intel TDX seller node,
minted fresh this round and cryptographically tied to the seller's marketplace identity.*

## Params

The **prover** (seller) reads its config from the environment, never from buyer-supplied values:

| Variable | Purpose |
|---|---|
| `ANTSEED_TEE_PEER_ID` | the seller's peer id (EVM address, no `0x`) |
| `ANTSEED_VERIFIER_SIGNING_KEY` | seller identity key (hex) for `seller-bound`. Disabled if its address ≠ peerId |
| `ANTSEED_VERIFIER_NODE_TEE` | node quote source: `configfs` (default, bare-metal/GCP TDX), `dstack` (Phala and other dstack CVMs), or `http` |
| `ANTSEED_VERIFIER_DSTACK_SOCKET` | override the dstack guest-agent socket path (default `/var/run/dstack.sock`) |
| `ANTSEED_VERIFIER_PROVIDER_ADAPTER` | in-process provider adapter id (`chutes`, `aci`). It fetches provider evidence directly, no shim. See [CHUTES.md](./CHUTES.md) or [REDPILL.md](./REDPILL.md) |
| `ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL` | generic provider evidence route (`{nonce}` → hex nonce). The manual alternative to an adapter |
| `ANTSEED_VERIFIER_PROVIDER_TEE_FIELD` | JSON field with the base64 provider quote (default `quote`) |
| `ANTSEED_VERIFIER_PROVIDER_GPU_FIELD` | JSON field with per-GPU NVIDIA CC evidence → enables `seller-provider-gpu-cc` |
| `ANTSEED_VERIFIER_PROVIDER_CLAIMS_FIELD` | JSON field with the base64 claims doc → enables `seller-provider-claims` |
| `ANTSEED_VERIFIER_PROVIDER_BINDING_SCHEME` | frozen `report_data` scheme the provider quote uses (`antseed-rd-v1` \| `nonce-pubkey-sha256-v1`) |
| `ANTSEED_VERIFIER_PROVIDER_BINDING_PUBKEY_FIELD` | JSON field with the provider's base64 E2E pubkey (the scheme's ingredient) |

The **buyer** needs no special hardware. Optional policy knobs:

| Variable | Purpose |
|---|---|
| `ANTSEED_VERIFIER_REQUIRED_CAPS` | comma-separated capabilities that gate the overall `ok` (default `seller-node-tee-genuine,seller-bound`). For example, a provenance buyer sets `seller-provider-tee-genuine,seller-bound` to require the downstream provider's TEE |
| `ANTSEED_VERIFIER_MEASURED_IMAGE_POLICY` | approved-measurement allow-list (inline JSON or `@/path.json`) for `measured-image` |
| `ANTSEED_VERIFIER_STRICT_TCB` | `true` requires TCB exactly `UpToDate` (default also accepts `SWHardeningNeeded`) |
| `ANTSEED_VERIFIER_NRAS_URL` / `_NRAS_JWKS_URL` | override NVIDIA NRAS endpoints for `gpu-cc` |

`seller-node-tee-genuine` runs only on a real Intel TDX VM. `configfs` mints via
`/sys/kernel/config/tsm/report` (needs root). `dstack` mints via the guest-agent socket
(Phala and other dstack CVMs, where configfs-tsm is absent). Both bind the same `antseed-rd-v1`
report_data, so the buyer verifies them identically.

## Appendix: provider adapters

An **in-process adapter** bridges a provider whose evidence API does not match the generic route
(auth, a different response shape). Select the adapter with `ANTSEED_VERIFIER_PROVIDER_ADAPTER`.
There is no separate process. The SDK core stays provider-neutral. Each adapter is an isolated
module that loads lazily. Two adapters are available:

```bash
export ANTSEED_VERIFIER_PROVIDER_ADAPTER=chutes   # + CHUTES_API_KEY, CHUTES_CHUTE
export ANTSEED_VERIFIER_PROVIDER_ADAPTER=aci      # + ACI_ATTESTATION_URL (RedPill / dstack ACI)
```

The adapter fetches the provider's fresh, nonce-bound quote. It declares its frozen `report_data`
scheme (`nonce-pubkey-sha256-v1` for Chutes, `aci-keyset-v1` for ACI). The buyer verifies the
scheme unchanged. Full setup: [CHUTES.md](./CHUTES.md) · [REDPILL.md](./REDPILL.md) · [PHALA.md](./PHALA.md)
(run the seller node in a dstack TDX CVM).

---

`v0.1.0` · GPL-3.0
