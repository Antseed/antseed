# Model verification

Checks that a seller serves the model it advertises, and pays the people who check.
This is the contract-level spec; the plain-language overview is the website page
[Model verification](../../apps/website/docs/protocol/model-verification.md).

## Roles

- **Auditor.** An address approved by the `AntseedVerification` owner. It buys from
  sellers like any buyer, runs a Knowledge Boundary Fingerprinting (KBF) audit of one
  model across the sellers that advertise it, publishes the evidence, and submits the
  results on-chain itself.
- **Anyone else.** Can re-run the check from the published evidence with
  `antseed-verify` (`@antseed/model-verifier`). A wrong audit costs the auditor its
  approval, and the owner can clear the result.

Which models an auditor checks in an epoch is coordinated off-chain; the contract does
not enforce an assignment.

## Reference upstreams

A reference records the genuine model's answers, so where those answers came from
matters. Reference builds query OpenRouter (`verifier.referenceEndpoint`) by default.
An auditor can send a model's own reference requests to another API instead, so
answers bought from OpenRouter can be compared with the model maker's native API:

```json
{
  "verifier": {
    "upstreams": {
      "anthropic": { "type": "anthropic", "baseUrl": "https://api.anthropic.com/v1", "apiKeyEnv": "ANTHROPIC_API_KEY" },
      "openai": { "type": "openai", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
      "my-seller": { "type": "antseed", "peerId": "<40-char seller peer id>" }
    },
    "referenceEndpoint": {
      "models": {
        "claude-opus-5.5": { "upstreamModel": "anthropic/claude-opus-5.5", "upstream": { "name": "anthropic", "model": "claude-opus-5-5" } }
      }
    }
  }
}
```

- `type` is `openrouter`, `openai` (any OpenAI-compatible Chat Completions API),
  `anthropic` (native Messages API) or `antseed` (one seller, reached through the local
  buyer proxy and pinned to its peer id; the model's `upstream` then needs `pricing`, and
  `model` is the seller's service). Contrast models always go through `referenceEndpoint`.
- **Only use an Antseed seller you trust** (your own node, or one in a TEE), ideally one
  that already came back SAME against an OpenRouter or native reference. If that seller
  serves a different model, the reference is wrong too, and honest sellers come back DIFF.
  The older per-model `referenceRoute` does the same thing and still works.
- Each reference stores `provenance.upstream`: the upstream's name, type, base URL,
  model id, protocol, the request overrides and omissions, and any pinned OpenRouter
  provider. It never stores API keys. A build from another upstream gets its own
  `sourceId`, so its questions never mix with an OpenRouter-built bank.
- Every request and response the build received, byte for byte (no credentials), is
  saved as `reference-evidence/<id>.exchanges.json` next to the probe bank, with its
  sha256 in `bank.json` (`referenceExchanges`).
- A published audit includes those files under `reference-evidence/`, lists them with
  their sha256 and upstream in the evidence document (`referenceEvidence`), and lists
  the upstreams in `publication.json` (`upstreams`). The evidence hash goes on-chain, so
  those sha256 values are committed too. Banks built before this have no raw exchanges
  to publish.

## On-chain state

`submitModelAudit(expectedEpoch, modelHash, evidenceHash, evidenceUri, results)`:

- One submission per audited model. `results` is one `(agentId, serviceHash, verdict)`
  per audited seller service, strictly ordered by `(agentId, serviceHash)`, 1 to 256
  entries.
- Each verdict is `SAME`, `DIFF`, or `UNDETERMINED` (the audit ran but could not
  decide). `NONE` is rejected.
- `expectedEpoch` must be the current emissions epoch, and auditors cannot audit
  agents they own. The same evidence can be submitted again; the credit limits below
  bound what that earns.

Status is kept per `(agentId, serviceHash)`, as the verdict and the epoch it was given in:

- The latest result always wins. `SAME` verifies the service, `DIFF` marks it as not
  serving the audited model, and `UNDETERMINED` counts as neither, so it also clears an
  earlier SAME or DIFF. A DIFF affects that service only.
- A verdict counts for `validityEpochs` emissions epochs including the one it was given
  in (default 2, so through the next epoch; owner-settable from 1 to 4, applying to
  existing verdicts too). It then drops out on its own; there is nothing to clean up.
- A result for a different `modelHash` resets the service first, so an old verdict
  never carries over to a new model.
- One DIFF lands; there is no on-chain vote. Before submitting a DIFF, `antseed verifier
  run` rechecks it on fresh probes the seller has never seen. A recheck SAME turns it
  into UNDETERMINED; a recheck DIFF or UNDETERMINED keeps the DIFF; if the recheck
  cannot run, nothing is submitted for that seller (`verifier.diffConfirmationRuns`,
  default 1; 0 turns rechecks off).

`agentStatus(agentId)` returns `(verifiedCount, diffCount)`: the agent's SAME and DIFF
services whose verdicts still count. `isVerified(agentId)` is true while at least one of
them is SAME and none is DIFF. Each agent keeps one small SAME/DIFF counter per epoch, so
these reads sum at most `validityEpochs` counters however many services the agent has.

The owner can `clearServiceStatuses(agentIds, serviceHashes)` to reset wrong results,
many seller services in one call.
Revoking an auditor (`setAuditor(auditor, false)`) stops new submissions; its verdicts
stay until they expire.

## Points

`AntseedVerificationPointsPolicy` scales a seller's points by the SAME and DIFF services
that still count:
`sellerPoints × max(0, 1 + min(verifiedCount × bonusBps, 5_000) / 10_000 − diffCount × penaltyBps / 10_000)`.
Each verified service adds `bonusBps` (`100` = +1%, capped at +50% in total); each DIFF
service subtracts `penaltyBps` (uncapped, so points can reach 0 but never go negative).
A DIFF only affects its own service: the seller's other verified services keep their
bonus. Buyer points always pass through.

`bonusBps` (0 to 5,000) and `penaltyBps` (any value) are owner-settable; M003 launches
both at 0. The policy applies only from `pointsStartEpoch` on (owner-set; off until
then). Every external read falls back to unchanged points, so the policy can never
revert a settlement.

## Auditor rewards

The 10% verification emission bucket is split by **audit credits**, from
`rewardsStartEpoch` on (owner-set; off until then, so audits before launch earn nothing):

- An auditor earns one credit per model audit, whatever the verdicts (including
  UNDETERMINED), and only if at least one audited agent has staked pool power, so
  auditing fake agents pays nothing.
- Safety limits against a compromised or malicious auditor, all owner-settable:
  - `maxCreditsPerModelPerEpoch` (default 1): a repeat audit of the same model in an
    epoch earns nothing.
  - `maxCreditsPerAuditorPerEpoch` (default 100): credits per auditor per epoch.
  - `maxAuditorShareBps` (default 2,000 = 20%): the most of an epoch's budget one auditor
    can claim. The cap in force at claim time applies, and budget above it is never
    minted.
- After the epoch ends, an auditor claims
  `min(budget × auditorCredits / totalCredits, budget × maxAuditorShareBps / 10_000)`
  with `claimAuditorRewards`. `pendingAuditorReward` returns 0 for the current epoch,
  whose share can still change.
- The owner can `voidAuditorCredits(epoch, auditor)` to remove a bad auditor's credits
  for an epoch before that auditor claims, so farmed credits stop shrinking the honest
  auditors' shares. Credits already claimed cannot be voided.

## Rollout

M003 deploys the verification contract and the points policy, and registers the
policy in the points policy registry. Points stay unchanged until the policy owner sets
`pointsStartEpoch` and a nonzero bonus or penalty. Auditor rewards start once the
emissions-gate owner hands the verification bucket to the contract and the verification
owner sets `rewardsStartEpoch`. See
`packages/contracts/script/migrations/M003VerificationRegistry/README.md`.

## Deliberately left out

- **Image and video models.** KBF verifies text models only; other services are not
  audited and earn no bonus.
- **Price checks.** The evidence for them is the auditor's own spending records,
  which cannot be proven to a third party. They can return once seller pricing is
  signed on-chain (#176).
- **Per-model volume.** Points carry no model, so the bonus applies to a seller's
  whole volume.
- **Per-auditor verdict history.** The contract does not record which auditor gave a
  verdict, so a revoked auditor's verdicts are cleared with `clearServiceStatuses` (many
  services per call) or expire on their own.
