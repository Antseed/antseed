# @antseed/fingerprints

The KBF measurement contract: prompts, parser, scoring, statistics, verdict rules and reference validation. `apps/cli/src/verifier` and `packages/model-verifier` run the audits; banks, domains and evidence live in the CLI. `verifyKbf` returns a first look, which `apps/cli/src/verifier/close-call.ts` can replace. `docs/protocol/spec/07-model-verification.md` is stale on this package; the code wins.

| Rule | Enforced by |
| --- | --- |
| Prompt variants and `formatRules` are hashed into every reference, so an edit rejects all stored ones. Tests use the live hash and stay green. | `tests/reference.test.ts` (rejection only) |
| `V1` in a name is not the schema version; references are version 2. | `tests/reference.test.ts` |
| `parseKbfAnswers` does not strip `<think>` or refuse cut-off replies. Audit callers do both first. | `apps/cli/src/verifier/model-run.test.ts`, `packages/model-verifier/tests/audit.test.ts` |
| Audits use `KBF_AUDIT_VERIFY_OPTIONS`, not `verifyKbf`'s defaults. | review only |
| Stored audits find their close-call rule by id, so a used rule is never edited. | review only |

**Ask first:** prompt text, `KBF_PARSER_VERSION`, `validateQueryProfile`, `stats.ts` numerics (each can reject every stored reference); scoring and verdict rules.

**Prove it:** consumers read `dist`, so build this package, then run the `@antseed/model-verifier` and `@antseed/cli` tests.
