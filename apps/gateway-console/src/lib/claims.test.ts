import { describe, expect, it } from 'vitest'
import { claimedOnChain, claimSteps, unclaimedEpochs, type ClaimCalls } from './claims'
import { runTxSteps, type TxStepIo } from './tx-steps'

const io: TxStepIo = { status: () => undefined, sent: () => undefined, receipt: async () => ({ status: 'success' }) }
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const

/** A fake builders contract: per-epoch claims, AlreadyClaimed on a repeat, and a wallet that can reject one prompt. */
function fakeChain() {
  const onChain = new Set<number>()
  const sent: number[][] = []
  const local = new Set<number>()
  let rejectEpoch: number | null = null
  const calls: ClaimCalls = {
    label: (epochs) => `Claim epoch ${epochs.join(', ')}`,
    check: async (epochs) => { if (epochs.some((epoch) => onChain.has(epoch))) throw new Error('AlreadyClaimed') },
    send: async (epochs) => {
      if (epochs.includes(rejectEpoch ?? -1)) { rejectEpoch = null; throw new Error('User rejected the request.') }
      sent.push([...epochs])
      epochs.forEach((epoch) => onChain.add(epoch))
      return hash(sent.length)
    },
    onClaimed: (epochs) => epochs.forEach((epoch) => local.add(epoch)),
  }
  return { onChain, sent, local, calls, rejectOnce: (epoch: number) => { rejectEpoch = epoch } }
}

describe('builder claims', () => {
  it('confirms one epoch, rejects the next, then retries only the remainder', async () => {
    const chain = fakeChain()
    const listed = [12, 13, 14]
    chain.rejectOnce(13)

    await expect(runTxSteps(claimSteps(unclaimedEpochs(listed, chain.local), true, chain.calls), io)).rejects.toThrow(/rejected/)
    expect(chain.sent).toEqual([[12]])
    expect([...chain.local]).toEqual([12])

    // The same (stale) list from the explorer: epoch 12 is left out, so no AlreadyClaimed.
    const retry = claimSteps(unclaimedEpochs(listed, chain.local), true, chain.calls)
    expect(retry.map((step) => step.label)).toEqual(['Claim epoch 13', 'Claim epoch 14'])
    await expect(runTxSteps(retry, io)).resolves.toBe(hash(3))
    expect(chain.sent).toEqual([[12], [13], [14]])
    expect(unclaimedEpochs(listed, chain.local)).toEqual([])
  })

  it('reopening with a stale list drops the epochs the chain already marks claimed', async () => {
    const chain = fakeChain()
    chain.onChain.add(12)
    const done = await claimedOnChain([12, 13], async (epoch) => chain.onChain.has(epoch))
    expect(done).toEqual([12])
    // A failed read counts as unclaimed; the simulation still guards it.
    expect(await claimedOnChain([12, 13], async (epoch) => { if (epoch === 12) throw new Error('rpc down'); return false })).toEqual([])
    await runTxSteps(claimSteps(unclaimedEpochs([12, 13], new Set(done)), true, chain.calls), io)
    expect(chain.sent).toEqual([[13]])
  })

  it('a reverted receipt stops the run before the step counts as claimed', async () => {
    const chain = fakeChain()
    const steps = claimSteps([12, 13], true, chain.calls)
    await expect(runTxSteps(steps, { ...io, receipt: async () => ({ status: 'reverted' }) })).rejects.toThrow('Claim epoch 12 reverted on chain.')
    expect(chain.local.size).toBe(0)
  })
})

describe('referral claims', () => {
  it('claim every epoch in one transaction, and nothing when none are left', () => {
    const { calls } = fakeChain()
    expect(claimSteps([12, 13], false, calls).map((step) => step.label)).toEqual(['Claim epoch 12, 13'])
    expect(claimSteps([], false, calls)).toEqual([])
  })
})
