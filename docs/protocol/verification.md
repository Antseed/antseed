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

- `SAME` verifies the service until its own `expiresAt = now + validity` (14 days,
  owner-settable). It discards pending DIFF votes.
- `DIFF` is a vote. The service is marked DIFF once `diffConfirmations` distinct
  auditors (owner-settable, default 1) report it, also until `now + validity`. A DIFF
  affects that service only. Pending votes must reach quorum within a fixed window:
  the first pending DIFF sets the deadline to `now + validity`. Later votes and
  UNDETERMINED results do not extend it. At or after the deadline, the next audit
  discards the old votes before processing its result; auditors can vote again in
  the new round. Changing `validity` affects new windows, not existing deadlines.
- Repeating the current verdict refreshes its expiry.
- `UNDETERMINED` changes no verdict or verdict expiry and adds no DIFF vote. Like
  every new audit, it first clears expired pending votes. It is recorded so routing
  can see it: `serviceStatus` returns `lastResult`, `lastAuditedAt`, and
  `undeterminedStreak` (consecutive UNDETERMINED results since the last SAME or DIFF).
- A result for a different `modelHash` resets the service first, so an old verdict
  never carries over to a new model.

`agentStatus(agentId)` returns `(verifiedCount, diffCount)`: the agent's **unexpired**
SAME and DIFF services. `isVerified(agentId)` is true while at least one unexpired
service is SAME and none is DIFF. Reads exclude expired verdicts automatically;
calling `expire` for only some services cannot change verification or points.

An agent can have at most 512 stored definitive services, bounding the reads used
by the points policy. Pending or UNDETERMINED-only services do not consume a slot.
New definitive services automatically reclaim an expired slot at capacity; if all
512 slots are unexpired, adding another service reverts with `TooManyServices`.

Expiry is per service. Once a service's `expiresAt` passes, anyone can call
`expire([(agentId, serviceHash), ...])` to clean up its stored verdict
(it becomes NONE; `lastResult` is kept). Cleanup is optional for correctness: the
expired verdict is already excluded from agent status and points. A new audit of
the service expires it first, and `antseed verifier submit` clears every expired
verdict it finds after submitting (`--no-expire` skips this).

The owner can `clearServiceStatus(agentId, serviceHash)` to remediate a wrong result.

## Points

`AntseedVerificationPointsPolicy` scales a seller's points by its unexpired SAME and DIFF
services:
`sellerPoints × max(0, 1 + min(verifiedCount × bonusBps, 5_000) / 10_000 − diffCount × penaltyBps / 10_000)`.
Each verified model adds `bonusBps` (`100` = +1%, capped at +50% in total); each DIFF
model subtracts `penaltyBps` (uncapped, so points can reach 0 but never go negative).
A DIFF only affects its own model: the seller's other verified models keep their bonus.
Buyer points always pass through.

`bonusBps` (0 to 5,000) and `penaltyBps` (any value) are owner-settable. M003 launches
the bonus at 0 and the penalty starts at 0, so points are unchanged until the owner turns
them on. Every external read falls back to unchanged
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
