# Model verification

Checks that a seller serves the model it advertises, and pays the people who check.

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

## On-chain state

`submitModelAudit(expectedEpoch, modelHash, evidenceHash, evidenceUri, results)`:

- One submission per audited model. `results` is one `(agentId, serviceHash, verdict)`
  per audited seller service, strictly ordered by `(agentId, serviceHash)`, 1 to 256
  entries.
- Each verdict is `SAME`, `DIFF`, or `UNDETERMINED` (the audit ran but could not
  decide). `NONE` is rejected.
- `expectedEpoch` must be the current emissions epoch, `evidenceHash` can be used once,
  and auditors cannot audit agents they own.

Status is kept per `(agentId, serviceHash)`:

- `SAME` verifies the service and refreshes the agent's `verifiedUntil` to
  `now + validity` (14 days, owner-settable). It discards pending DIFF votes.
- `DIFF` is a vote. The service is marked DIFF once `diffConfirmations` distinct
  auditors (owner-settable, default 1) report it. A DIFF affects that service only.
- `UNDETERMINED` changes no verdict, DIFF vote, or expiry. It is recorded so routing
  can see it: `serviceStatus` returns `lastResult`, `lastAuditedAt`, and
  `undeterminedStreak` (consecutive UNDETERMINED results since the last SAME or DIFF).
- A result for a different `modelHash` resets the service first, so an old verdict
  never carries over to a new model.

`agentStatus(agentId)` returns `(verifiedCount, diffCount, verifiedUntil)`.
`isVerified(agentId)` is true while `verifiedUntil` has not passed, at least one
service is verified, and no service is marked DIFF.

The owner can `clearVerification(agentId)` or `clearServiceStatus(agentId, serviceHash)`
to remediate a wrong result.

## Points

`AntseedVerificationPointsPolicy` boosts a verified seller's points by `bonusBps` per
verified model (`100` = +1%), capped at +50% in total:
`sellerPoints × (1 + min(verifiedCount × bonusBps, 5_000) / 10_000)`. A seller counts as
verified while `verifiedUntil` has not passed and no service is marked DIFF; anyone else
is unchanged. Buyer points always pass through.

`bonusBps` is owner-settable from 0 to 5,000. M003 launches it at 0, so points are
unchanged until the owner turns the boost on. Every external read falls back to unchanged
points, so the policy can never revert a settlement.

## Auditor rewards

The 10% verification emission bucket is split by **audit credits**:

- An auditor earns one credit per model audit, whatever the verdicts (including
  UNDETERMINED). Repeat audits of the same model in an epoch earn credits up to
  `maxCreditsPerModelPerEpoch` (owner-settable, default 1, so a repeat earns nothing),
  and all audits together up to `maxCreditsPerAuditorPerEpoch` (owner-settable,
  default 100).
- An audit earns a credit only if at least one audited agent has staked pool power,
  so auditing fake agents pays nothing.
- After the epoch ends, an auditor claims `budget × auditorCredits / totalCredits`.

## Rollout

M003 deploys the verification contract and the points policy, and registers the
policy in the points policy registry, so the boost applies from the first `SAME`
result. Auditor rewards accrue but pay nothing until the emissions-gate owner hands
the verification bucket to the contract.

## Deliberately left out

- **Image and video models.** KBF verifies text models only; other services are not
  audited and earn no bonus.
- **Price checks.** The evidence for them is the auditor's own spending records,
  which cannot be proven to a third party. They can return once seller pricing is
  signed on-chain (#176).
- **Per-model volume.** Points carry no model, so the bonus applies to a seller's
  whole volume.
