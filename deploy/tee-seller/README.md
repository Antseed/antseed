# Antseed TEE seller image

The official image for running an Antseed seller in a dstack (Phala) confidential VM so that
buyers' TEE check passes: the seller node proves to every buyer, before payment, that it runs an
approved build whose operator cannot read prompts.

## What a buyer checks

The `seller-node-tee-genuine` claim of `@antseed/antseed-verifier` passes only when the seller's
Intel TDX quote:

- is genuine (Intel DCAP, acceptable TCB, debug off);
- is bound to the buyer's nonce, the seller's peer ID and the buyer's own encrypted connection;
- matches an entry in [`approved-node-measurements.ts`](../../packages/antseed-verifier/src/approved-node-measurements.ts):
  the dstack OS measurements (MRTD, RTMR0-2) and the app compose hash, which the buyer replays
  from the dstack event log. A VM that ran init scripts outside the compose file does not match.

## The image

[`Dockerfile`](Dockerfile) installs the npm-published `@antseed/cli`, every provider plugin and
the verifier prover exactly as locked in [`package-lock.json`](package-lock.json) (`npm ci`), on a
distroless runtime: no shell, no package manager, no runtime plugin installs or updates. The
seller dashboard is off, so settings can't change at runtime. A commit therefore determines all
the code in the image: rebuild it from that commit to check a digest's contents.

To release an image after a CLI release:

1. `node deploy/tee-seller/update-lock.mjs <cli version>` pins that CLI, the current plugin
   releases and the verifier version the CLI pins; open a PR with the regenerated files.
2. After it merges, run the **Publish TEE seller image** workflow
   ([`.github/workflows/tee-seller-image.yml`](../../.github/workflows/tee-seller-image.yml)). It
   pushes `ghcr.io/antseed/tee-seller:<cli version>` with an SBOM and a signed build provenance
   attestation, so anyone can check which commit and workflow produced a digest:

```bash
gh attestation verify oci://ghcr.io/antseed/tee-seller@sha256:<digest> --repo AntSeed/antseed
```

## Run a TEE seller on Phala

1. Copy [`docker-compose.yml`](docker-compose.yml) and fill in every `<...>`: the release image
   digest, your peer ID and your seller config, with upstream URLs written out.
2. Deploy it as a dstack app with KMS enabled. Pass only secrets as encrypted environment
   variables (`ANTSEED_IDENTITY_HEX` and your provider API keys), and allow exactly those.
   Keep public logs off.
3. Read the app compose hash and the OS measurements (MRTD, RTMR0-2) from the deployment's
   attestation.
4. Open a pull request adding an entry to `approved-node-measurements.ts`:

   ```ts
   { name: '<seller name> <image version>', mrtd: '…', rtmr0: '…', rtmr1: '…', rtmr2: '…', composeHash: '…' }
   ```

   with your `app-compose.json` attached so reviewers can recompute the hash. Before it is
   listed, buyers can test it with `ANTSEED_VERIFIER_NODE_MEASUREMENTS`.

Any change to the compose file (image, config, prices) changes the compose hash and needs a new
entry.

## Review checklist for an approval

- `image` is an official release digest with a valid provenance attestation.
- One service; ports are only the signaling (TCP) and DHT (UDP) ports; volumes are only the
  seller data volume and `/var/run/dstack.sock`; no `privileged`, capabilities, devices or
  host namespaces.
- `${...}` appears only for secrets (identity key, provider API keys). Upstream URLs, extra
  headers, body injection, proxy settings (`*_PROXY`), `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`
  and debug flags (`ANTSEED_DEBUG`, `--verbose`) are absent or literal and acceptable.
- The app allows only those secret variables, has public logs off, and runs no init scripts.
- The OS measurements are a released dstack production image, not a dev image.
