# @antseed/fingerprints

The KBF measurement contract: prompts, parser, scoring, statistics, verdict rules and reference validation. `apps/cli/src/verifier` and `packages/model-verifier` run the audits; banks, domains and evidence live in the CLI. `verifyKbf` returns a first look, which `apps/cli/src/verifier/close-call.ts` can replace. `docs/protocol/spec/07-model-verification.md` is stale on this package; the code wins.

Published, Node only, no dependencies, no network or storage.

## Inside

- `src/verifiers/kbf/` — one module per step: `prompts.ts`, `parser.ts`, `scoring.ts`, `stats.ts`, `verdict.ts`, `reference.ts`, `thinking-discovery.ts`. `index.ts` has `verifyKbf` and `KBF_AUDIT_VERIFY_OPTIONS`.
- `src/canonical-json.ts` — canonical JSON and the hashes the CLI also uses for on-chain ids. `src/types.ts` — probe, reference and verdict types.
- A new close-call rule is a new frozen `KbfExtensionRule` with a new id in `kbfExtensionRuleById`; `KBF_EXTENSION_RULE` points new audits at it.

| Rule | Enforced by |
| --- | --- |
| Prompt variants and `formatRules` are hashed into every reference, so an edit rejects all stored ones. Tests use the live hash and stay green. | `tests/reference.test.ts` (rejection only) |
| `V1` in a name is not the schema version; references are version 2. | `tests/reference.test.ts` |
| `parseKbfAnswers` does not strip `<think>` or refuse cut-off replies. Audit callers do both first. | `apps/cli/src/verifier/model-run.test.ts`, `packages/model-verifier/tests/audit.test.ts` |
| Audits use `KBF_AUDIT_VERIFY_OPTIONS`, not `verifyKbf`'s defaults. | review only |
| Stored audits find their close-call rule by id, so a used rule is never edited. | review only |
| A missing, non-finite or out-of-range answer is null (unscored), not a mismatch. A match vector holding anything but 1, 0 or null gives UNKNOWN. | `tests/scoring.test.ts`, `tests/verdict.test.ts` |
| A DIFF needs `minDiffCoverage`; a SAME needs only `minCoverage`. Below `minCoverage` the verdict is UNDETERMINED. | `tests/verdict.test.ts` |
| A reference that is `imported` without `trustImported`, under-powered, or disagrees with its own data or `referenceId` is refused. | `tests/reference.test.ts` |
| Worst-case false-DIFF over all looks of a close-call rule stays under the single-look 5%. | `tests/extension.test.ts` |

## Connections

- No internal dependencies. Build tier 0. Pinned by `@antseed/cli` and `@antseed/model-verifier`.
- A change ships only through a new CLI release, and `verifier run` and `submit` refuse a CLI older than the latest on npm, so a scoring change moves every auditor at once.
- "The KBF reference code" in comments is `kbf_common.py`; comments say where this package matches it and where it is stricter.

## Traps

- cli 0.1.221 imported an export only the unreleased fingerprints had and failed at startup. When the CLI uses a change here, say so in the PR so the release bumps this package too.
- Some upstreams switch thinking off but reason in the reply. Discovery also needs an answers-only reply under the token limit (`isKbfAnswersOnlyReply`); honest sellers were marked DIFF before this.
- A line's answer is its last number that is not part of a unit; add a parser test for each new reply shape. Models copy bare `N.`/`QN:` placeholders literally (`formatExample`).
- `isLowCoverageKbfBatch` is the reference-build rule; seller audits re-ask on any missing answer (`hasMissingKbfAnswers`). Keep them apart.
- A temperature error demanding another value is not a rejection: that model samples randomly. Audits never send `top_p`.
- Reference-endpoint settings live in `generator.params.referenceEndpointRequest`; `referenceCompatibilityProfileHash` keeps old banks compatible, and having both fails validation.
- `FINGERPRINTS_PACKAGE_VERSION` is fixed, not the `package.json` version. `computeReferenceId` hashes every field but `referenceId`, so pass machine-local fields in `localOnlyFields`.

**Ask first:** prompt text, `KBF_PARSER_VERSION`, `validateQueryProfile`, `stats.ts` numerics (each can reject every stored reference); scoring and verdict rules.

**Prove it:** consumers read `dist`, so build this package, then run the `@antseed/model-verifier` and `@antseed/cli` tests. Here: `pnpm --filter @antseed/fingerprints test` and `typecheck`.
