# @antseed/antseed-verifier

TEE attestation as one plugin: the default export is the buyer verifier and `prover` is the seller half. Nothing imports it statically. The CLI loads the npm copy at the exact version in `apps/cli/src/plugins/registry.ts`, and the desktop bundles `dist`, so a change without a version bump reaches no user. The CLI's `commands/verifier` is model verification, not this package.

## Inside

- `src/verifier.ts` (buyer: verify each cap, compute `ok` from the required caps) and `src/prover.ts` (seller: config from env only, collect caps in registry order).
- `src/caps/index.ts` — the registry; registration order is menu, collect and verify order. A new capability is a module in `src/caps/` registered there.
- `src/seller-config-rules.ts` + `src/tee-provider-plugins.json` — what a TEE seller may run; `dstack-app-compose.ts` and `confidential-space.ts` apply them per platform.
- `src/approved-node-measurements.ts`, `approved-seller-images.ts`, `image-provenance.ts` — which OS releases and images pass. `src/report-data.ts` — the frozen schemes.
- `README.md` lists the env vars; `docs/e2e-report-data-schemes.md` is the real-VM run.

| Rule | Enforced by |
| --- | --- |
| `seller-bound` signs every other cap's evidence, byte for byte. | `src/caps/seller-bound.test.ts` |
| Evidence caps register before `seller-bound`. Evidence set outside the collect loop also sets `evidenceConfigKey`. | review only |
| A `report_data` scheme outside the frozen registry fails. | `src/report-data.test.ts` |
| A claim outside `PROVIDER_CLAIMS_MENU` never passes. | `src/caps/provider-claims.test.ts` |
| With no buyer policy, measured-image reports `ok: false`. Read the verdict's `ok`, not each claim. | `src/verifier.test.ts` |
| A version bump changes `package.json`, `src/verifier.ts`, `src/prover.ts` and the registry pin together. | review only |
| Verifier and claim ids match `packages/node/src/verification/tee-status.ts`. Vendored types match `packages/node/src/interfaces/plugin.ts`. | review only |
| The node quote binds the buyer's own connection; no binding (WebRTC) or another session's quote fails. The prover omits the node cap rather than mint it unbound. | `src/caps/tee-tdx.test.ts`, `src/prover-binding.test.ts` |
| A provider quote counts only when fetched from the one upstream the measured seller config sends prompts to. Evidence fetches refuse redirects. | `src/caps/tee-tdx.test.ts`, `src/verifier.test.ts`, `src/adapters/adapters.test.ts` |
| The compose is rejected for anything not on its allow-list (scripts, extra services, code-loading settings, http upstreams, ...). The seller config is named by its content hash, so a change recreates the container. | `src/dstack-app-compose.test.ts`, `src/confidential-space.test.ts` |
| A build record approves an image only if this repo's `tee-seller-image.yml` on main signed it after `IMAGES_BUILT_AFTER`, dated by its signing certificate. | `src/image-provenance.test.ts` |
| A failing or throwing cap yields `ok: false` for that claim, never a thrown verify. | `src/caps/tee-tdx.test.ts`, `src/verifier.test.ts` |

## Connections

- No internal dependencies (vendored types in `src/antseed-node-types.ts`). Build tier 1. The desktop copies `dist` to `bundled-plugins` (`apps/desktop/electron-builder.yml`).
- Buyer side gates routing in `apps/cli/src/proxy/tee-verification.ts`; seller side loads through `apps/cli/src/plugins/verifier.ts`. The attest path sits under `ANTSEED_ATTEST_PATH` in `packages/node/src/interfaces/plugin.ts`.
- TEE seller image: `deploy/tee-seller/update-lock.mjs` reads `tee-provider-plugins.json` and the CLI's pinned version. The Dockerfile's `tee.launch_policy.allow_env_override` stays inside what `confidential-space.ts` accepts.

## Traps

- Old buyers stay on the verifier their CLI pins: a new image or compose rule is accepted only by buyers on the new version, and `IMAGES_BUILT_AFTER` retires images for new buyers only.
- Phala Cloud's CLI always writes an empty `init_script`; the compose rules accept only the empty one.
- `fal-video` is not a TEE plugin: it uploads buyer media to a host named at runtime.
- Sigstore log entry times are not all signed; builds are dated by the Fulcio certificate's `validFrom`.
- A provider adapter failure only omits the provider caps and logs to stderr.
- An `ANTSEED_VERIFIER_SIGNING_KEY` whose address differs from `ANTSEED_TEE_PEER_ID` silently disables `seller-bound`, and every buyer's default verdict then fails.
- The README footer version is stale; `package.json` is the version.

**Ask first:** a capability id, the default required caps, the attestation wire format, a `report_data` scheme or the claims menu; the compose or seller-config allow-lists, the approved OS or image lists, `IMAGES_BUILT_AFTER` or the trusted build workflow (each decides which sellers pass for every buyer).

**Prove it:** `pnpm --filter @antseed/antseed-verifier test` and `typecheck`. Unit tests stub DCAP and NRAS, so a quote change also needs a real TDX VM run (`docs/e2e-report-data-schemes.md`).

**Maintainers:** a version bump also runs `pnpm --filter @antseed/cli test` (`loader.test.ts` asserts the pin) and usually updates `apps/website/docs/provide/tee.md`, `deploy/tee-seller/README.md` and `CHANGELOG.md`.
