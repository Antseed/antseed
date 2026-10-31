import assert from 'node:assert/strict'
import test from 'node:test'
import { depositShortfall, formatUsdcAmount, preRunError, probeBankProblems } from './pre-run-checks.js'

test('USDC amounts read as dollars', () => {
  assert.equal(formatUsdcAmount(1_000_000n), '$1.00')
  assert.equal(formatUsdcAmount(12_345_678n), '$12.34')
})

test('the deposit must cover a reserve for every new seller channel', () => {
  assert.equal(depositShortfall({ availableUsdc: 5_000_000n, reserveUsdc: 1_000_000n, newChannelCount: 5 }), null)
  assert.equal(depositShortfall({ availableUsdc: 0n, reserveUsdc: 1_000_000n, newChannelCount: 0 }), null)
  assert.equal(
    depositShortfall({ availableUsdc: 3_500_000n, reserveUsdc: 1_000_000n, newChannelCount: 5 }),
    '5 seller(s) need a new payment channel, each reserving $1.00 (payments.maxReserveAmountUsdc): $5.00 needed, '
      + '$3.50 available. Deposit at least $1.50 more (antseed buyer deposit), or lower payments.maxReserveAmountUsdc and restart the buyer',
  )
})

test('a seller short of unseen questions stops the run unless enrollment is on', () => {
  const sellers = [
    { sellerPeerId: 'aa'.repeat(20), unseenProbeCount: 300, neededProbeCount: 200 },
    { sellerPeerId: 'bb'.repeat(20), unseenProbeCount: 150, neededProbeCount: 200 },
    { sellerPeerId: 'cc'.repeat(20), unseenProbeCount: 120, neededProbeCount: 200 },
  ]
  const problems = probeBankProblems({ model: 'kimi-k3', sellers, enrollIfNeeded: false })
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /kimi-k3: 2 seller\(s\).*lowest: 120 of 200 needed, seller cccccccccccc/)
  assert.match(problems[0]!, /--no-enroll/)
  assert.deepEqual(probeBankProblems({ model: 'kimi-k3', sellers, enrollIfNeeded: true }), [])
  assert.deepEqual(probeBankProblems({ model: 'kimi-k3', sellers: sellers.slice(0, 1), enrollIfNeeded: false }), [])
})

test('the stop error lists every problem', () => {
  assert.equal(
    preRunError(['a', 'b']).message,
    'verifier run stopped before sending any request: 2 problem(s) on the auditor\'s side:\n  - a\n  - b',
  )
})
