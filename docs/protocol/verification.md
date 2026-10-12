# Model verification

Checks that a seller serves the model it advertises, and pays the people who check.

## Roles

- **Auditor.** An address approved by the `AntseedVerification` owner. It buys from a
  seller like any buyer, runs a Knowledge Boundary Fingerprinting (KBF) audit of each
  advertised service, publishes the evidence, and submits the result on-chain itself.
- **Anyone else.** Can re-run the check from the published evidence with
  `antseed-verify` (`@antseed/model-verifier`). A wrong audit costs the auditor its
  approval, and the owner can clear the result.

There is no separate verifier role and no quorum. Approval is the trust anchor, and
the downside of a bad audit is bounded: verification only ever adds a capped,
expiring points bonus and never removes points.

## On-chain state

`submitAudit(agentId, results, evidenceHash, evidenceUri)`:

- `results` is one `(serviceHash, modelHash, passed)` per audited service, strictly
  ordered by `serviceHash`, 1 to 64 entries.
- Every service passed: the agent is verified until `now + validity` (14 days).
- Any service failed: the agent's verification is cleared immediately.
- Auditors cannot audit agents they own.

`isVerified(agentId)` is the only thing the rest of the protocol reads.

## Points

`AntseedVerificationPointsPolicy` multiplies a verified seller's points by
`1 + bonusBps / 10_000` (`bonusBps` at most 50%). Unverified sellers and buyers pass
through unchanged. Every external read falls back to "unverified", so the policy
can never revert a settlement.

## Auditor rewards

The 10% verification emission bucket is split by the **pool power** of the agents
audited:

- The first audit of an agent in an epoch credits its auditor with that agent's
  `SellerPools.poolWeightAtEpoch(agentId, epoch)`, whether the audit passed or
  failed. Later audits of the same agent in that epoch update its status but earn
  nothing.
- After the epoch ends, an auditor claims
  `budget × auditorPower / totalAuditedPower`.

Agents with no staked power earn nothing to audit, so creating fake agents does not
farm rewards, and auditors are drawn to the sellers that carry the most stake.

## Rollout

M003 deploys the contract in shadow mode. Rewards accrue but pay nothing until the
emissions-gate owner hands the verification bucket to the contract, and the points
policy is registered in a later migration once shadow data sets `bonusBps`.

## Deliberately left out

- **Price checks.** The evidence for them is the auditor's own spending records,
  which cannot be proven to a third party. They can return once seller pricing is
  signed on-chain (#176).
- **Graded scores.** A binary verified flag is enough to route and reward on. Add a
  grade only if shadow data shows a need for one.
