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
| `UNDETERMINED` | Too many batches failed to judge (coverage below 80%) | 3 |

Use `--protocol anthropic` for Messages-API endpoints, `--out audit.json` to keep the
raw request and response bytes, and `--json` for machine-readable output.

References are content-addressed: `referenceId` is a hash of the reference itself,
and `loadReference` rejects one whose content does not match it. Build references
with `antseed verifier reference` (in `@antseed/cli`).

## Library

```ts
import { auditEndpoint, loadReference, OpenAIChatEndpoint } from '@antseed/model-verifier'

const result = await auditEndpoint({
  endpoint: new OpenAIChatEndpoint({ baseUrl, apiKey }),
  reference: await loadReference('ipfs://<cid>'),
})
console.log(result.evaluation.verdict)
```

Any transport can be audited by implementing `ModelEndpoint`. `computeScoreBps`
reproduces the on-chain agent score from per-service results, so anyone can check
an `AntseedVerification` score against its published evidence.
