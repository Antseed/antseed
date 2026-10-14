# @antseed/model-verifier

Checks whether the model behind an endpoint is the model it claims to be. It works
with any OpenAI- or Anthropic-compatible endpoint: an Antseed peer through the local
buyer proxy, another network, or a provider's own API.

It uses Knowledge Boundary Fingerprinting (KBF). A published reference holds numeric
recall probes that the genuine model answers consistently and cheaper substitutes get
wrong, plus the genuine model's own error rate on them. An audit sends a fresh random
subset in a fresh order, with varied prompt wording, and runs a one-sided binomial
test of the endpoint's mismatches against that honest error rate.

```bash
VERIFY_API_KEY=... npx antseed-verify \
  --base-url https://openrouter.ai/api/v1 \
  --model meta-llama/llama-3.3-70b-instruct \
  --reference ./llama-3.3-70b.kbf.json
```

| Verdict | Meaning | Exit code |
|---|---|---|
| `SAME` | No evidence of substitution at the reference's statistical power | 0 |
| `DIFF` | Significantly more mismatches than the genuine model makes | 2 |
| `UNDETERMINED` | Not every probe could be judged (the same rule as on-chain audits) | 3 |

To reuse the probes of a published Antseed model audit, pass `--audit ipfs://<cid>`
instead of `--reference`. The verifier checks the audit evidence against its hash and
uses the largest KBF reference the audit published. `antseed verifier check <model>`
(in `@antseed/cli`) finds the latest on-chain audit for you.

Use `--protocol anthropic` for Messages-API endpoints, `--out audit.json` to keep the
raw request and response bytes, and `--json` for machine-readable output.

References are content-addressed: `referenceId` is a hash of the reference itself,
and `loadReference` rejects one whose content does not match it. Build references
with `antseed verifier reference` (in `@antseed/cli`).

## Library

```ts
import { auditEndpoint, loadReference, OpenAIChatEndpoint, resolveAuditReference } from '@antseed/model-verifier'

const result = await auditEndpoint({
  endpoint: new OpenAIChatEndpoint({ baseUrl, apiKey }),
  reference: await loadReference('ipfs://<cid>'),
})
console.log(result.evaluation.verdict)

// Or reuse the reference of a published Antseed audit:
const { reference } = await resolveAuditReference('ipfs://<audit-cid>')
```

Any transport can be audited by implementing `ModelEndpoint`, so anyone can re-check
an `AntseedVerification` audit against its published evidence.
