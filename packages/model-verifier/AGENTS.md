# @antseed/model-verifier

The standalone KBF check of any OpenAI- or Anthropic-compatible endpoint. `auditEndpoint` picks probes, runs thinking discovery and sends batches through a `ModelEndpoint`. Verdicts, scoring and thinking strategies live in `@antseed/fingerprints`, its only dependency. This is not the on-chain audit path: `verifier run` uses `apps/cli/src/verifier/model-run.ts`, with its own audit loop and completion parser, so a retry or parsing change usually belongs there too. A verdict here is one look, with no close-call extra sets. `antseed-verify` (`src/cli.ts`) and `antseed verifier check` are separate front ends, so a new flag or protocol goes in both. The CLI owns the publication format that `src/publication.ts` reads (`ipfs-publication.ts`, `model-audit.ts`).

Published to npm, Node only, with the `antseed-verify` bin.

## Inside

- `src/audit.ts` — `auditEndpoint` and the per-batch retry loop (`runBatch`).
- `src/endpoint.ts` — the `ModelEndpoint` seam; an endpoint never scores. Transports are in `src/endpoints/`.
- `src/reference.ts`, `publication.ts`, `ipfs.ts` — loading references and published audits. `src/report.ts` — output and exit codes.
- A new transport: a `ModelEndpoint` class in `src/endpoints/`, exported from `src/index.ts`, wired into `createEndpoint` in `src/cli.ts` and `createCheckEndpoint` in `apps/cli/src/cli/commands/verifier/check.ts`.

| Rule | Enforced by |
| --- | --- |
| An endpoint that answers no batch raises `AuditNoAnswersError`, never a verdict. | `tests/audit.test.ts` |
| A reference whose content does not match its `referenceId` is refused. | `tests/reference.test.ts` |
| Evidence that does not match the on-chain hash, and paths that escape the CID root, are refused. | `tests/publication.test.ts` |
| `ModelEndpoint.call` returns a failure result. A throw ends the audit with no verdict. | review only |
| A batch that never returned counts as missing (null). A reply stopped at the token limit is not scored and is asked again; `<think>` is stripped before parsing. | `tests/audit.test.ts` |
| Batches send no `top_p`. A refused `temperature` or thinking suppression is dropped for that batch and recorded. | `tests/audit.test.ts` |
| Thinking discovery calls an endpoint down only after two strategies in a row fail every try. | `tests/audit.test.ts` |
| `AnthropicMessagesEndpoint` forwards only `thinking` from `extraBody` and reports `supportsPrefill = false`. | `tests/audit.test.ts` (the skip, with a fake endpoint) |

## Connections

- Depends on `@antseed/fingerprints`. Build tier 1. Only `apps/cli` imports it (`src/cli/commands/verifier/check.ts`).
- A fingerprints change this package uses needs a fingerprints bump in the same release (`scripts/npm-publish-plan.mjs`).
- The batch loop is not shared: `runBatch` here and `model-run.ts` in the CLI each implement retries, truncation and sampling-field drops.
- `resolveAuditReference` reads the CLI's `publication.json` and evidence by their `kind`; renaming either breaks every published audit.

## Traps

- A reasoning model can reason inside its answer with thinking off, hit the token limit, and get honest sellers a DIFF. The fix is fingerprints' discovery plus the truncation check in `runBatch`; keep both.
- Some upstreams reject `temperature` with HTTP 400; before the drop-and-retry, whole audits came back UNDETERMINED.
- A retry that drops a field does not use up `maxAttempts`. Count `calls` when you read a batch record.
- A wrong key or URL raises `AuditNoAnswersError` with a hint, and the bin exits 1, not 3.
- The README's verdict table and exit codes mirror `src/report.ts` and `USAGE` in `src/cli.ts`. Change all three together.

**Ask first:** a change to the exported `ModelEndpoint` or `AuditResult` shape; a change that moves verdicts, since fingerprints also decides on-chain audits.

**Prove it:** `pnpm --filter @antseed/model-verifier test` and `typecheck` (build fingerprints first after changing it). A new protocol also runs `apps/cli/src/cli/commands/verifier/check.test.ts`.
