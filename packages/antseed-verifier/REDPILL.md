# RedPill (ACI)

Start the seller with `--verifiers antseed-verifier`. The ACI adapter runs in-process. There is
no separate shim. Select it with `ANTSEED_VERIFIER_PROVIDER_ADAPTER=aci`.

## Provider config

```bash
export ANTSEED_VERIFIER_PROVIDER_ADAPTER=aci
export ANTSEED_VERIFIER_PROVIDER_ACI_URL=https://<gateway>/v1/aci/attestation
# export ACI_API_KEY=<bearer token>   # if the gateway requires auth
```

`ANTSEED_VERIFIER_PROVIDER_ACI_URL` takes precedence over the legacy `ACI_ATTESTATION_URL`,
which remains supported as a fallback. Use the new name with the official TEE seller image:
its compose rules allow it as a literal provider setting, but reject the legacy name.
Use a keyless attestation endpoint with that image: a separate hidden `ACI_API_KEY` is rejected
unless the seller config also names it as a provider's `apiKeyEnv`. See the
[TEE seller setup](../../apps/website/docs/provide/tee.md#5-attest-your-inference-provider-too-optional).

The adapter fetches the nonce-bound ACI report. It extracts the TDX quote. It binds the quote with
`aci-keyset-v1` (`report_data = workload_keyset_digest ‖ nonce`).

## RedPill provider

Identity + provider config, no node quote:

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
# + provider config above
```

Buyers must require the provider capability:

```bash
export ANTSEED_VERIFIER_REQUIRED_CAPS='seller-provider-tee-genuine,seller-bound'
```

## Seller node in the ACI dstack CVM + RedPill provider

Run the seller inside the gateway's dstack CVM. Mint the node quote with the dstack source:

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
export ANTSEED_VERIFIER_NODE_TEE=dstack        # see PHALA.md
# + provider config above
```

Buyers attest with `--require-verifier` (default required capabilities).
