# @antseed/model-verifier

The standalone KBF check of any OpenAI- or Anthropic-compatible endpoint. `auditEndpoint` picks probes, runs thinking discovery and sends batches through a `ModelEndpoint`. Verdicts, scoring and thinking strategies live in `@antseed/fingerprints`, its only dependency. This is not the on-chain audit path: `verifier run` uses `apps/cli/src/verifier/model-run.ts`, with its own audit loop and completion parser, so a retry or parsing change usually belongs there too. A verdict here is one look, with no close-call extra sets. `antseed-verify` (`src/cli.ts`) and `antseed verifier check` are separate front ends, so a new flag or protocol goes in both. The CLI owns the publication format that `src/publication.ts` reads (`ipfs-publication.ts`, `model-audit.ts`).

| Rule | Enforced by |
| --- | --- |
| An endpoint that answers no batch raises `AuditNoAnswersError`, never a verdict. | `tests/audit.test.ts` |
| A reference whose content does not match its `referenceId` is refused. | `tests/reference.test.ts` |
| Evidence that does not match the on-chain hash, and paths that escape the CID root, are refused. | `tests/publication.test.ts` |
| `ModelEndpoint.call` returns a failure result. A throw ends the audit with no verdict. | review only |

**Ask first:** a change to the exported `ModelEndpoint` or `AuditResult` shape; a change that moves verdicts, since fingerprints also decides on-chain audits.

**Prove it:** a new protocol also runs `apps/cli/src/cli/commands/verifier/check.test.ts`.
