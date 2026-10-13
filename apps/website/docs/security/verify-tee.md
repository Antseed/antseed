---
slug: /verify-tee
title: Verify a seller's TEE
description: How your buyer checks that a seller runs in a genuine Intel TDX enclave, and how to require it in the CLI, the Gateway Console and the desktop app.
hide_title: true
---

# Verify a seller's TEE

Before paying a seller, your buyer can check that the seller node runs inside a genuine Intel TDX enclave. The check runs on your machine, against Intel's certificate chain, with no third party in between and no special hardware on your side. This page covers what the check proves, how each Antseed interface shows it, and how to make it mandatory.

## How verification works by default

Verification is on and best-effort by default:

- Sellers that advertise a trusted verifier are checked before a request is routed to them.
- The verdict is logged, but requests route whether or not the check passes.

To refuse sellers that do not pass, turn on required verification in the [CLI](#cli), the [Gateway Console](#gateway-console) or a routing policy.

## What a passing check proves

With the [`antseed-verifier`](https://github.com/AntSeed/antseed/tree/main/packages/antseed-verifier) SDK, a seller passes only when both of these hold:

| Claim | Proves |
|---|---|
| `seller-node-tee-genuine` | The seller node runs in a genuine Intel TDX enclave: the quote checks out against Intel's DCAP certificate chain with an acceptable TCB and debug off, and it was created for your nonce and bound to the seller's peer id. Replayed quotes and non-TDX machines fail. |
| `seller-bound` | The seller's identity key signed the whole evidence bundle, so the enclave belongs to the peer you are paying. |

Four more claims are reported for your own policy but do not decide the verdict:

| Claim | Reports |
|---|---|
| `seller-provider-tee-genuine` | The downstream inference provider's TEE quote is genuine TDX, and bound to this round when the provider declares a binding scheme. |
| `seller-provider-gpu-cc` | The provider's GPUs run NVIDIA Confidential Computing, checked against NVIDIA's attestation service. |
| `seller-provider-measured-image` | The provider quote's measurements match an allow list you control. |
| `seller-provider-claims` | Named provider claims, each marked self-vouched or TEE-attested. |

A passing seller-node check **does not guarantee that downstream inference runs inside a TEE**; provider, GPU, and measured-image claims are not guaranteed by the badge. Whether the model is what the provider claims is a separate check, done by [fingerprinting](/blog/model-verification-fingerprint-swarm).

## CLI

`antseed buyer start` takes three flags:

```bash
# Default: verify sellers that advertise a trusted verifier, route either way.
antseed buyer start

# Required: refuse to route unless the seller passes.
antseed buyer start --verifiers antseed-verifier --require-verifier

# Off: skip verification.
antseed buyer start --no-verifier
```

- `--verifiers <ids>`: an ordered, comma-separated list of verifier ids. Without it, the buyer uses the seller's advertised default if that id is trusted.
- `--require-verifier`: a failed or missing verification blocks the seller. Automatic routing may try another eligible seller; a pinned seller returns `502` with the failed claims.
- `--no-verifier`: turns verification off. Combining it with the other two flags is rejected.

To keep the policy across restarts, set it in the [buyer config](/docs/buyer-config):

```json
{
  "buyer": {
    "verifier": { "enabled": true, "prefer": ["antseed-verifier"], "require": true }
  }
}
```

Flags replace the config's policy for that run. The startup banner shows the active policy, for example `Verifier: antseed-verifier (required)`.

To see which sellers advertise a verifier:

```bash
antseed network browse            # shows a Verifier column when peers advertise one
antseed network peer <peerId>     # lists the peer's verifiers
antseed network browse --tag tee  # sellers that tag their services as TEE
```

Advertised support is not a verdict. Only your own node produces the verdict, at request time.

### Policy settings

These environment variables tune the `antseed-verifier` SDK on the buyer:

| Variable | Effect |
|---|---|
| `ANTSEED_VERIFIER_STRICT_TCB` | `true` accepts only TCB status `UpToDate`. By default `SWHardeningNeeded` is also accepted. |
| `ANTSEED_VERIFIER_MEASURED_IMAGE_POLICY` | Allow list for `seller-provider-measured-image`, as inline JSON or `@/path/to/policy.json`. |
| `ANTSEED_VERIFIER_NRAS_URL`, `ANTSEED_VERIFIER_NRAS_JWKS_URL` | Override NVIDIA attestation service endpoints for `seller-provider-gpu-cc`. |

## Gateway Console

The gateway's buyer uses the same verifier settings.

- **Settings → Buyer → Verification** has **Verify sellers**, **Require verification** and **Verifiers**. They write the `buyer.verifier` config above. On the command line, `antseed gateway settings set-buyer --require-verifier on` does the same.
- In a routing policy, **TEE sellers only** limits routing to sellers that advertise the TEE verifier, and **Verified sellers only** makes verification mandatory for requests under that policy. Policies can be set for the whole gateway, a workspace, a member, a key or a preset; see [Routing policies](/docs/gateway/routing).
- The **TEE** badge on the **Models** and **Providers** pages marks sellers that advertise TEE attestation. See [Models and providers](/docs/gateway/models).

## Desktop app

The desktop app has no verification setting of its own. Its buyer uses the default best-effort policy unless you set `buyer.verifier` in the config.

- In **Models**, the **TEE advertised** seller filter shows only sellers that advertise support for `antseed-verifier`. It is a browsing filter and does not change routing, pins or policy. **Show all sellers** clears it.
- On a model's seller list, a **TEE** badge appears when the verifier passed both required claims for that seller. Its tooltip reads "We use TEEs to enhance user privacy." No badge means the check is missing, expired, failed, unavailable or in progress, not that the seller has no TEE.

### How the desktop checks sellers

- After discovery, the app checks advertising sellers in the background, one at a time, while its window is visible. There is no check button.
- A passing result shows the badge for up to 24 hours from the check. Viewing it does not extend that time. A newer failed or unavailable check removes the badge.
- Unavailable checks retry with backoff from 30 seconds up to five minutes.
- Results are kept in memory and are cleared when the buyer restarts.
- The app reads results from the buyer through loopback-only endpoints protected by a per-buyer credential file in the buyer data directory, `buyer-verification-<port>.json`. If you attach the app to a buyer started with a custom `--data-dir`, set `ANTSEED_DESKTOP_CONNECT_DATA_DIR` to that directory before launching the app. A missing credential hides the badge; it does not mean the seller failed.

## What happens at request time

1. After a seller is selected and before any payment negotiation, the buyer challenges it on the reserved route `/_antseed/attest/<verifier-id>` over the existing encrypted connection. Attestation is never metered or charged.
2. The check has a 30-second timeout.
3. Routing reuses a seller's evidence for at most five minutes. The desktop's 24-hour badge never extends this. Failures are not cached as routing verdicts.
4. On failure, best-effort mode routes anyway and logs `did not pass ... (optional — routing anyway)`. Required mode fails the request with `502` and the failed claims.

## The trust boundary

Your node only runs verifier code from a built-in, version-pinned set that maps each verifier id to an exact npm package and version (`antseed-verifier` → `@antseed/antseed-verifier`). A version mismatch is an error and nothing upgrades automatically. A seller can advertise any id; ids outside the set are never loaded.

:::note Three kinds of "verified"
1. Verifier SDKs (this page): TEE attestation of a seller, run by your node.
2. The **Verified** column in `antseed network browse`: domain and GitHub ownership proofs a seller publishes. See [Verified identity](/docs/provide/verified-identity).
3. Model verification: fingerprinting the model behind a service.
:::

## See also

- [Run a TEE seller](/docs/provide/tee)
- [AIP-3: Pluggable verifier SDKs](https://github.com/AntSeed/AIPs/blob/main/AIPS/aip-3.md)
- [Security](/docs/security)
