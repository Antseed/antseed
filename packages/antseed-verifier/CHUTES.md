# Chutes

Use a Chutes chute as the inference provider. Start the seller with `--verifiers antseed-verifier`.
The Chutes adapter runs in-process (no separate shim). Select it with
`ANTSEED_VERIFIER_PROVIDER_ADAPTER=chutes`.

## Provider config

```bash
export ANTSEED_VERIFIER_PROVIDER_ADAPTER=chutes
export CHUTES_API_KEY=<chutes api key>
export CHUTES_CHUTE=<chute id>
# export CHUTES_API_BASE=https://api.chutes.ai   # override if needed
```

The adapter adds the Bearer auth, joins the Chutes E2E-pubkey and evidence endpoints by
instance, and binds the quote with `nonce-pubkey-sha256-v1`. If GPU CC evidence is present, it
verifies against the scheme's derived NRAS nonce automatically.

## Chutes provider, normal (non-TEE) seller

The seller node does not run in a TEE, so it offers no node quote. Set the identity and the
provider config:

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
# + provider config above
```

The seller proves `seller-provider-tee-genuine` and `seller-bound`. Buyers must require the
provider capability, because the default set requires a node TEE that a normal seller cannot give:

```bash
export ANTSEED_VERIFIER_REQUIRED_CAPS='seller-provider-tee-genuine,seller-bound'
```

## Chutes provider, TEE seller

The seller node runs in a TEE, so it also proves `seller-node-tee-genuine`. Add the node quote
source that matches the seller's TEE:

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
export ANTSEED_VERIFIER_NODE_TEE=configfs   # bare-metal or GCP TDX; use dstack for Phala or dstack CVMs (see PHALA.md)
# + provider config above
```

The seller proves the full chain (node TEE, provider TEE, and seller-bound). Buyers attest with
`--require-verifier` and the default required capabilities.
