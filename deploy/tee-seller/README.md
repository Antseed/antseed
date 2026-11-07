# Antseed TEE seller image

The official image for running an Antseed seller in a dstack (Phala) confidential VM or on Google
Confidential Space so that buyers' TEE check passes: the seller node proves to every buyer, before payment, that it runs an
approved Antseed image whose operator cannot read prompts, and which upstreams it sends them to.

## What a buyer checks

The `seller-node-tee-genuine` claim of `@antseed/antseed-verifier` passes, on dstack, only when the
seller's Intel TDX quote:

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

On Google Confidential Space the seller sends Google's signed attestation token instead of a
quote. It passes only when the token ([`confidential-space.ts`](../../packages/antseed-verifier/src/confidential-space.ts)):

- is signed by Google's Confidential Space attestation service, for the `antseed-verifier`
  audience, and carries the nonce bound to the buyer's round, the seller's peer ID and the buyer's
  connection;
- shows Intel TDX, a supported production Confidential Space image with debugging off since boot,
  and Secure Boot;
- names an approved image digest, and env overrides limited to the seller config
  (`ANTSEED_SELLER_CONFIG_JSON`), where its secrets live (`ANTSEED_GCP_SECRETS`) and the open
  settings dstack allows, all checked against the same rules
  ([`seller-config-rules.ts`](../../packages/antseed-verifier/src/seller-config-rules.ts)).

Here buyers rely on Google's attestation service and Google's Confidential Space OS, where on
dstack they check the Intel quote and the OS measurements themselves.

## The image

[`Dockerfile`](Dockerfile) installs the npm-published `@antseed/cli`, the provider plugins a TEE
seller may use and the verifier prover exactly as locked in `package-lock.json` (`npm ci`), on a distroless runtime: no shell, no package manager, no runtime plugin installs or
updates. The seller dashboard is off, so settings can't change at runtime. A commit therefore
determines all the code in the image: rebuild it from that commit to check a digest's contents.

To release an image after a CLI release:

1. `node deploy/tee-seller/update-lock.mjs <cli version>` writes `package.json` and
   `package-lock.json` pinning that CLI, the current plugin releases and the verifier version the
   CLI pins; open a PR with them. There is no lock until the first release with these checks. The
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
   `baseUrl` is HTTPS. Settings that load code or configure another role (`seller.agentDir`,
   `plugins`, `buyer`, `verifier`, `relayer`) are rejected. Don't put a key in a URL: buyers read the
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

Buyers reach a seller over raw TCP at its announced address and find it through the DHT (UDP).
Phala Cloud exposes CVM ports only through its TLS gateway, without a public IP or UDP, so
buyers can't reach a seller there yet; run dstack on a TDX host with a public IP.

## Run a TEE seller on Google Confidential Space

The image's launcher (`launch.mjs`) detects Confidential Space, writes the seller config from
`ANTSEED_SELLER_CONFIG_JSON`, and fetches the secrets named in `ANTSEED_GCP_SECRETS` from Secret
Manager with the workload's own attestation. Google's token shows every env override to buyers,
so secret values never go in env overrides. The image's launch policy lets the operator set only
its listed env variables, and never replace its command or stream its logs from a production
image.

1. Write the seller config as for dstack (same rules), and store each secret in Secret Manager:
   `ANTSEED_IDENTITY_HEX`, the API keys the config names, and optionally `ANTSEED_BASE_RPC_URL`.
2. Release the secrets only to the attested image, through a workload identity pool that trusts
   Google's attestation:

   ```bash
   gcloud iam workload-identity-pools create antseed-tee --location=global
   gcloud iam workload-identity-pools providers create-oidc attestation --location=global \
     --workload-identity-pool=antseed-tee \
     --issuer-uri=https://confidentialcomputing.googleapis.com/ \
     --allowed-audiences=https://sts.googleapis.com \
     --attribute-mapping="google.subject='assertion.sub'" \
     --attribute-condition="assertion.swname == 'CONFIDENTIAL_SPACE' && 'STABLE' in assertion.submods.confidential_space.support_attributes && assertion.submods.container.image_digest == 'sha256:<digest>'"
   gcloud secrets add-iam-policy-binding <secret> --role=roles/secretmanager.secretAccessor \
     --member="principalSet://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/antseed-tee/*"
   ```

3. Start a TDX VM on the Confidential Space production image (its service account needs
   `roles/confidentialcomputing.workloadUser`), and open the signaling (TCP) and DHT (UDP) ports:

   ```bash
   gcloud compute instances create antseed-tee-seller --zone=<zone> \
     --machine-type=c3-standard-4 --confidential-compute-type=TDX --maintenance-policy=TERMINATE \
     --shielded-secure-boot --image-project=confidential-space-images --image-family=confidential-space \
     --service-account=<service account> --scopes=cloud-platform \
     --metadata-from-file=tee-env-ANTSEED_SELLER_CONFIG_JSON=config.json \
     --metadata=^~^tee-image-reference=ghcr.io/antseed/tee-seller@sha256:<digest>~tee-restart-policy=Always~tee-env-ANTSEED_TEE_PEER_ID=<peer id>~tee-env-ANTSEED_GCP_SECRETS={"audience":"//iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/antseed-tee/providers/attestation","secrets":{"ANTSEED_IDENTITY_HEX":"projects/<project>/secrets/<identity>/versions/latest","<NAME>_API_KEY":"projects/<project>/secrets/<key>/versions/latest"}}
   gcloud compute firewall-rules create antseed-tee-seller --allow=tcp:6882,udp:6881
   ```

Confidential Space keeps no data across a VM restart (its only mounts are memory-backed), so the
seller's channel and metering database starts empty after one. Before a planned restart, stop
taking new buyers and let open channels settle.

## Approving a dstack OS release

Add the release's MRTD and RTMR0-2 to `APPROVED_DSTACK_OS` in
`approved-node-measurements.ts`, one entry per VM shape (RTMR0 depends on the vCPU and memory
size). Use a production (non-dev) dstack image, and recompute the values from the release
artifacts rather than copying them from a running CVM.
