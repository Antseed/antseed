import assert from 'node:assert/strict'
import test from 'node:test'
import { VERIFIER_VERDICT, serviceHash, type VerifierVerdict } from '@antseed/node/payments'
import { DIFF_HOLD_EPOCHS, diffHoldEndsAt, diffHoldReason, diffHoldResultReason, diffHolds, type DiffHoldStatus } from './diff-hold.js'

const DIFF_IN_30: DiffHoldStatus = { verdict: VERIFIER_VERDICT.DIFF, epoch: 30n }

test('by default a DIFF from epoch N holds the seller in N+1 only: it is audited again in N+2', () => {
  assert.equal(DIFF_HOLD_EPOCHS, 1)
  assert.equal(diffHoldReason(DIFF_IN_30, 30n, DIFF_HOLD_EPOCHS), null, 'the epoch the DIFF was recorded in is the third-opinion rule\'s')
  assert.equal(
    diffHoldReason(DIFF_IN_30, 31n, DIFF_HOLD_EPOCHS),
    'its DIFF from epoch 30 stands until epoch 32, so the seller is not audited or cleared before then',
  )
  assert.equal(diffHoldReason(DIFF_IN_30, 32n, DIFF_HOLD_EPOCHS), null)
  assert.equal(diffHoldReason(DIFF_IN_30, 33n, DIFF_HOLD_EPOCHS), null)
  assert.equal(diffHoldEndsAt(30n, DIFF_HOLD_EPOCHS), 32n)
})

test('the hold length is the setting: 0 holds nobody, 2 holds two epochs', () => {
  for (const epoch of [30n, 31n, 32n]) assert.equal(diffHoldReason(DIFF_IN_30, epoch, 0), null)
  assert.deepEqual([30n, 31n, 32n, 33n].map((epoch) => diffHoldReason(DIFF_IN_30, epoch, 2) !== null), [false, true, true, false])
  assert.match(diffHoldReason(DIFF_IN_30, 32n, 2)!, /stands until epoch 33/)
})

test('only a stored DIFF holds: SAME, UNDETERMINED and no verdict do not', () => {
  for (const verdict of [VERIFIER_VERDICT.SAME, VERIFIER_VERDICT.UNDETERMINED, VERIFIER_VERDICT.NONE]) {
    assert.equal(diffHoldReason({ verdict, epoch: 30n }, 31n, DIFF_HOLD_EPOCHS), null)
  }
  // An owner clear leaves NONE with epoch 0.
  assert.equal(diffHoldReason({ verdict: VERIFIER_VERDICT.NONE, epoch: 0n }, 1n, DIFF_HOLD_EPOCHS), null)
})

test('a repeat DIFF result is never held: only a SAME or UNDETERMINED would clear the stored DIFF', () => {
  assert.equal(diffHoldResultReason(DIFF_IN_30, 31n, DIFF_HOLD_EPOCHS, VERIFIER_VERDICT.DIFF), null)
  assert.match(diffHoldResultReason(DIFF_IN_30, 31n, DIFF_HOLD_EPOCHS, VERIFIER_VERDICT.SAME)!, /stands until epoch 32/)
  assert.match(diffHoldResultReason(DIFF_IN_30, 31n, DIFF_HOLD_EPOCHS, VERIFIER_VERDICT.UNDETERMINED)!, /stands until epoch 32/)
})

test('diffHolds reads each (agent, service) once and filters candidates in order', async () => {
  const reads: string[] = []
  const statuses = new Map<string, DiffHoldStatus>([
    [`1:${serviceHash('model-a')}`, { verdict: VERIFIER_VERDICT.SAME, epoch: 30n }],
    [`2:${serviceHash('model-a')}`, DIFF_IN_30],
  ])
  const holds = diffHolds({
    epoch: 31n,
    holdEpochs: DIFF_HOLD_EPOCHS,
    reader: {
      serviceStatusByHash: async (agentId, hash) => {
        reads.push(`${agentId}:${hash}`)
        return statuses.get(`${agentId}:${hash}`) ?? { verdict: VERIFIER_VERDICT.NONE, epoch: 0n }
      },
    },
  })
  const candidate = (agentId: bigint, verdict: VerifierVerdict = VERIFIER_VERDICT.SAME) => ({ agentId, serviceHash: serviceHash('model-a'), verdict, auditedAt: 0 })
  const reasons = await holds.filter('0xmodel', [candidate(1n), candidate(2n), candidate(3n)])
  assert.deepEqual(reasons.map((reason) => reason !== null), [false, true, false])
  assert.deepEqual(await holds.filter('0xmodel', [candidate(2n, VERIFIER_VERDICT.DIFF)]), [null], 'agent 2\'s repeat DIFF is sent')
  assert.match(reasons[1]!, /DIFF from epoch 30 stands until epoch 32/)
  assert.match((await holds.reasonFor(2n, serviceHash('model-a').toUpperCase().replace('0X', '0x')))!, /epoch 30/)
  assert.equal(reads.length, 3, 'each pair is read once, whatever the hash\'s case')
  assert.deepEqual(await holds.reasonsFor([{ agentId: null, serviceHash: serviceHash('model-a') }]), [null], 'a seller without an agent id is never held')
  assert.equal(reads.length, 3)
})

test('a failed read fails the call and is read again next time; a hold of 0 reads nothing', async () => {
  let calls = 0
  const holds = diffHolds({
    epoch: 31n,
    holdEpochs: DIFF_HOLD_EPOCHS,
    reader: {
      serviceStatusByHash: async () => {
        calls += 1
        if (calls === 1) throw new Error('rpc down')
        return DIFF_IN_30
      },
    },
  })
  await assert.rejects(holds.reasonFor(2n, serviceHash('model-a')), /rpc down/)
  assert.match((await holds.reasonFor(2n, serviceHash('model-a')))!, /epoch 30/)
  assert.equal(calls, 2)

  const off = diffHolds({
    epoch: 31n,
    holdEpochs: 0,
    reader: { serviceStatusByHash: async () => { throw new Error('must not read') } },
  })
  assert.equal(await off.reasonFor(2n, serviceHash('model-a')), null)
})
