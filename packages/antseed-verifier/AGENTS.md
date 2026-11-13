# @antseed/antseed-verifier

TEE attestation as one plugin: the default export is the buyer verifier and `prover` is the seller half. Nothing imports it statically. The CLI loads the npm copy at the exact version in `apps/cli/src/plugins/registry.ts`, and the desktop bundles `dist`, so a change without a version bump reaches no user. The CLI's `commands/verifier` is model verification, not this package.

| Rule | Enforced by |
| --- | --- |
| `seller-bound` signs every other cap's evidence, byte for byte. | `src/caps/seller-bound.test.ts` |
| Evidence caps register before `seller-bound`. Evidence set outside the collect loop also sets `evidenceConfigKey`. | review only |
| A `report_data` scheme outside the frozen registry fails. | `src/report-data.test.ts` |
| A claim outside `PROVIDER_CLAIMS_MENU` never passes. | `src/caps/provider-claims.test.ts` |
| With no buyer policy, measured-image reports `ok: false`. Read the verdict's `ok`, not each claim. | `src/verifier.test.ts` |
| A version bump changes `package.json`, `src/verifier.ts`, `src/prover.ts` and the registry pin together. | review only |
| Verifier and claim ids match `packages/node/src/verification/tee-status.ts`. Vendored types match `packages/node/src/interfaces/plugin.ts`. | review only |

**Ask first:** a capability id, the default required caps, the attestation wire format, a `report_data` scheme or the claims menu.

**Prove it:** unit tests stub DCAP and NRAS, so a quote change also needs a real TDX VM run (`docs/e2e-report-data-schemes.md`).
