# Antseed TEE seller image

The official image for running an Antseed seller in a dstack (Phala) confidential VM so that
buyers' TEE check passes: the seller node proves to every buyer, before payment, that it runs an
approved Antseed image whose operator cannot read prompts, and which upstreams it sends them to.

## What a buyer checks

The `seller-node-tee-genuine` claim of `@antseed/antseed-verifier` passes only when the seller's
Intel TDX quote:

- is genuine (Intel DCAP, acceptable TCB, debug off);
- is bound to the buyer's nonce, the seller's peer ID and the buyer's own encrypted connection;
- shows a released dstack production OS (MRTD and RTMR0-2) listed in
  [`approved-node-measurements.ts`](../../packages/antseed-verifier/src/approved-node-measurements.ts);
- measured (RTMR3, replayed from the dstack event log) an app compose that runs an image listed in
  [`approved-seller-images.ts`](../../packages/antseed-verifier/src/approved-seller-images.ts)
  and follows the rules in [`dstack-app-compose.ts`](../../packages/antseed-verifier/src/dstack-app-compose.ts).
  A CVM that ran init scripts outside the compose file does not pass.

The seller sends its `app-compose.json` with the quote, so the buyer reads the seller config
itself and reports the upstreams it sends prompts to (`seller-node-upstreams`).

## The image

[`Dockerfile`](Dockerfile) installs the npm-published `@antseed/cli`, the provider plugins a TEE
seller may use and the verifier prover exactly as locked in [`package-lock.json`](package-lock.json)
(`npm ci`), on a distroless runtime: no shell, no package manager, no runtime plugin installs or
updates. The seller dashboard is off, so settings can't change at runtime. A commit therefore
determines all the code in the image: rebuild it from that commit to check a digest's contents.

To release an image after a CLI release:

1. `node deploy/tee-seller/update-lock.mjs <cli version>` pins that CLI, the current plugin
   releases and the verifier version the CLI pins; open a PR with the regenerated files. The
   build ([`check-lock.mjs`](check-lock.mjs)) refuses a lock whose verifier can't bind
   attestations to the buyer's connection or whose provider relay follows upstream redirects, so
   the first image comes from the release that ships `@antseed/antseed-verifier` 0.1.1 and the
   redirect-refusing `@antseed/provider-core`.
2. After it merges, run the **Publish TEE seller image** workflow
   ([`.github/workflows/tee-seller-image.yml`](../../.github/workflows/tee-seller-image.yml)). It
   pushes `ghcr.io/antseed/tee-seller:<cli version>` with an SBOM and a signed build provenance
   attestation, and opens a pull request adding the image's digest to the approved images
   (`approve-image.mjs`). Anyone can check which commit and workflow produced a digest:

   ```bash
   gh attestation verify oci://ghcr.io/antseed/tee-seller@sha256:<digest> --repo AntSeed/antseed
   ```

3. Merge that pull request. Buyers accept sellers running the image from the verifier release
   that includes it.

## Run a TEE seller on Phala

1. Write your seller config (`config.json`). Each provider sets `apiKeyEnv` to a variable name
   ending in `_API_KEY` (not starting with `ANTSEED_`, `POSTHOG_` or `CDP_`), and every
   `baseUrl` is HTTPS. Don't put a key in a URL: buyers read the
   whole config. Allowed plugins: `openai`, `anthropic`, `typesafe`, `venice-video`,
   `alibaba-video`.
2. Generate the compose file (JSON, which is valid compose YAML and what buyers parse):

   ```bash
   node deploy/tee-seller/compose.mjs --image ghcr.io/antseed/tee-seller@sha256:<digest> \
     --peer <peer id, 40 hex> --config config.json > docker-compose.json
   ```

   Add `--rpc-url-secret` to pass `ANTSEED_BASE_RPC_URL` as a secret, and
   `--env ANTSEED_VERIFIER_PROVIDER_...=<value>` for provider attestation settings. It prints the
   encrypted variables to allow. [`docker-compose.json`](docker-compose.json) is an example.
3. Deploy it as a dstack app with KMS enabled. Pass the printed secrets as encrypted environment
   variables, allow exactly those, keep public logs off, and add no pre-launch script.

Any change to the compose file (image, config, prices) changes the compose hash; buyers
re-check the new one against the same rules, so no approval is needed.

## Approving a dstack OS release

Add the release's MRTD and RTMR0-2 to `APPROVED_DSTACK_OS` in
`approved-node-measurements.ts`, one entry per VM shape (RTMR0 depends on the vCPU and memory
size). Use a production (non-dev) dstack image, and recompute the values from the release
artifacts rather than copying them from a running CVM.
