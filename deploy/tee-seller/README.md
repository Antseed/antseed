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
   CLI pins; open a PR with them. The build ([`check-lock.mjs`](check-lock.mjs)) refuses a lock
   whose verifier can't bind attestations to the buyer's connection, whose provider relay follows
   upstream redirects or that lacks content-free logging.
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

   Add `--rpc-url-secret` to pass `ANTSEED_BASE_RPC_URL` as a secret (or
   `--env ANTSEED_BASE_RPC_URL=<url>` for one without an API key in it, which buyers can read), and
   `--env ANTSEED_VERIFIER_PROVIDER_...=<value>` for provider attestation settings. It prints the
   encrypted variables to allow. [`docker-compose.json`](docker-compose.json) is an example.
3. Deploy it as a dstack app with KMS enabled. Pass the printed secrets as encrypted environment
   variables, allow exactly those, and add no pre-launch script. Public logs may be on (see
   [Logs and data](#logs-and-data)).

Any change to the compose file (image, config, prices) changes the compose hash; buyers
re-check the new one against the same rules, so no approval is needed.

Buyers reach a seller over raw TCP at its announced address and find it through the DHT (UDP).
Phala Cloud exposes CVM ports only through its TLS gateway
(`<app-id>-6882.<cluster>.phala.network:443`), without a public IP or UDP, so give the seller a
public entry point with `antseed seller forward` on any small machine with a public IP:

```bash
antseed seller forward --to <app-id>-6882.<cluster>.phala.network --peer <peer id>
```

It carries buyers' TCP connections over TLS to the gateway and announces the seller on the DHT
at its own address. It sees only ciphertext: buyers verify the seller's signed metadata and
attestation and run their encrypted session end to end with the CVM. In the seller config, set
`seller.publicAddress` to the forwarder's `<ip>:6882`, and raise
`seller.maxInboundConnectionsPerIp` (default 64), since every buyer arrives from the gateway's
address. For the same reason `seller.restrictedCountries` sees the gateway's location, not the
buyer's.

## Run a TEE seller on Google Confidential Space

The image's launcher (`launch.mjs`) detects Confidential Space, writes the seller config from
`ANTSEED_SELLER_CONFIG_JSON`, and fetches the secrets named in `ANTSEED_GCP_SECRETS` from Secret
Manager with the workload's own attestation. Google's token shows every env override to buyers,
so secret values never go in env overrides. The image's launch policy lets the operator set only
its listed env variables and never replace its command. Its logs may go to Cloud Logging
(`tee-container-log-redirect=true`; see [Logs and data](#logs-and-data)).

1. Write the seller config as for dstack (same rules), and store each secret in Secret Manager:
   `ANTSEED_IDENTITY_HEX`, the API keys the config names, and optionally `ANTSEED_BASE_RPC_URL`
   (or set it as an env override, which buyers can read, if it holds no API key).
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

   Confidential Space keeps no data across a VM restart (its only mounts are memory-backed), so
   give the seller a private bucket for its payment channels and metering, which it needs to
   settle with buyers after a restart (the image refuses to start without one):

   ```bash
   gcloud storage buckets create gs://<bucket> --location=<region> --uniform-bucket-level-access
   gcloud storage buckets add-iam-policy-binding gs://<bucket> --role=roles/storage.objectUser \
     --member="principalSet://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/antseed-tee/*"
   ```

3. Write where the secrets live to `secrets.json`:

   ```json
   {
     "audience": "//iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/antseed-tee/providers/attestation",
     "secrets": {
       "ANTSEED_IDENTITY_HEX": "projects/<project>/secrets/<identity>/versions/latest",
       "<NAME>_API_KEY": "projects/<project>/secrets/<key>/versions/latest"
     }
   }
   ```

4. Start a TDX VM on the Confidential Space production image (its service account needs
   `roles/confidentialcomputing.workloadUser`), and open the signaling (TCP) and DHT (UDP) ports:

   ```bash
   gcloud compute instances create antseed-tee-seller --zone=<zone> \
     --machine-type=c3-standard-4 --confidential-compute-type=TDX --maintenance-policy=TERMINATE \
     --shielded-secure-boot --image-project=confidential-space-images --image-family=confidential-space \
     --service-account=<service account> --scopes=cloud-platform \
     --metadata-from-file=tee-env-ANTSEED_SELLER_CONFIG_JSON=config.json,tee-env-ANTSEED_GCP_SECRETS=secrets.json \
     --metadata='tee-image-reference=ghcr.io/antseed/tee-seller@sha256:<digest>,tee-restart-policy=Always,tee-env-ANTSEED_TEE_PEER_ID=<peer id>,tee-env-ANTSEED_GCP_STATE=gs://<bucket>/<seller name>'
   gcloud compute firewall-rules create antseed-tee-seller --allow=tcp:6882,udp:6881
   ```

With `ANTSEED_GCP_STATE`, which it requires, the image restores the seller's payment and metering databases
from objects under that prefix on boot, and saves them while they change: payment channels every
30 seconds, metering every 5 minutes, and both once more after the seller stops. Snapshots are
encrypted with a key derived from the seller identity and, like the seller's logs, hold no prompts
or responses (see [Logs and data](#logs-and-data)). Metering keeps free-tier usage, pending
resource charges and the last 7 days of request log. An abrupt VM loss can drop the last 30
seconds of payment updates; the last save, after the seller stops, is retried with backoff.

One VM serves at a time: a seller holds a lease (`<prefix>/lease`) before it restores its state,
renews it every 20 seconds and releases it after its last save. A replacement VM waits until the
old one releases it, or for up to 2 minutes if the old one died. A watchdog stops a seller whose
lease hasn't been renewed for a minute, even while a renewal hangs, and kills it if it hasn't
stopped 30 seconds later; every request to Google has a time limit. A state write must finish
within the minute the seller surely holds the lease, so one that lost its lease, even while
shutting down, never writes over the state its replacement restored. Each save is also written only over the version the seller last saw, so a
second writer is caught even then.

To move an existing seller onto the image, or to upgrade to a new image (on Confidential Space the
workload identity condition must allow the new digest first), see
[Run a TEE-attested seller](../../apps/website/docs/provide/tee.md#move-an-existing-seller-to-the-tee-image).

## Logs and data

The image runs the seller in content-free mode (`ANTSEED_CONTENT_FREE_LOGS=1`, set by the
launcher, which the operator can't override), so its logs and databases may be read by the
operator, or by anyone when dstack logs are public:

- nothing the seller logs or stores holds a prompt, an answer or an upstream's error text, which
  can quote the request: failed requests keep only their status and the upstream's error code,
  and failed video jobs are logged without the upstream's reason (out-of-credit notices and alerts
  keep the upstream's billing message, which is about the account, not the request: only its
  error message when that names the account's credit, else its error code);
- debug logging, which prints more, stays off: buyers reject a seller that sets `ANTSEED_DEBUG`.

They do hold metadata the operator also sees on the network or on-chain: buyer peer IDs, the IPs of
free-tier buyers, token counts, timings and payments. `e2e/tests/seller-content-leak.test.ts`
sends marked prompts and answers, including short streams and upstream errors that quote the
request, through a seller and fails if a marker reaches its logs or data directory.

## Approving a dstack OS release

Add the release's MRTD and RTMR0-2 to `APPROVED_DSTACK_OS` in
`approved-node-measurements.ts`, one entry per VM shape (RTMR0 depends on the vCPU and memory
size). Use a production (non-dev) dstack image, and recompute the values from the release
artifacts rather than copying them from a running CVM.

The approved release is dstack 0.6.1 on Phala Cloud's CPU instance types (`tdx.small` to
`tdx.8xlarge`). To compute a release's values, take its `os_image_hash` (Phala Cloud lists them
at `https://cloud-api.phala.com/api/v1/os-images`), build `dstack-mr` from the same dstack
release, and measure each shape:

```bash
curl -LO https://download.dstack.org/os-images/mr_<os_image_hash>.tar.gz
tar xzf mr_<os_image_hash>.tar.gz && shasum -a 256 -c sha256sum.txt
test "$(shasum -a 256 sha256sum.txt | cut -d' ' -f1)" = <os_image_hash>
cargo build --release --manifest-path dstack/Cargo.toml -p dstack-mr-cli   # in the dstack checkout
dstack-mr measure -c <vCPUs> -m <memory>G --qemu-version 8.2.2 --hotplug-off false metadata.json
```

The QEMU version and hotplug setting are the hosts' (Phala Cloud's run QEMU 8.2.2 with hotplug
on), and change MRTD and RTMR0, so recompute when the provider changes them. Check one shape
against a real CVM's quote before approving the release.
