# RedPill (ACI)

Start the seller with `--verifiers antseed-verifier`. The ACI adapter runs in-process. There is
no separate shim. Select it with `ANTSEED_VERIFIER_PROVIDER_ADAPTER=aci`.

## Provider config

```bash
export ANTSEED_VERIFIER_PROVIDER_ADAPTER=aci
export ACI_ATTESTATION_URL=https://<gateway>/v1/aci/attestation
# export ACI_API_KEY=<bearer token>   # if the gateway requires auth
```

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
