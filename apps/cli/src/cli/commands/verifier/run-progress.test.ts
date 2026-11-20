import assert from 'node:assert/strict'
import test from 'node:test'
import { VerifierRunProgress } from './run-progress.js'

test('interactive verifier progress tracks provider outcomes per model', () => {
  const chunks: string[] = []
  const progress = new VerifierRunProgress([
    { model: 'fable', providerCount: 5 },
    { model: 'opus', providerCount: 2 },
  ], {
    isTTY: true,
    columns: 160,
    write: (chunk) => chunks.push(chunk),
  })

  progress.start()
  progress.activate('fable')
  progress.recordVerdict('fable', 'SAME')
  progress.recordVerdict('fable', 'DIFF')
  progress.recordVerdict('fable', 'UNDETERMINED')
  progress.recordSkip('fable')
  progress.recordFailure('fable')
  progress.complete('fable')
  progress.finish()

  const output = chunks.join('')
  assert.match(output, /fable\s+\[████████████████\] 5\/5 OUT:0 SAME:1 DIFF:1 UNDET:1 SKIP:1 FAIL:1 \| done/)
  assert.match(output, /opus\s+\[░░░░░░░░░░░░░░░░\] 0\/2 OUT:2 SAME:0 DIFF:0 UNDET:0 SKIP:0 FAIL:0 \| waiting/)
  assert.match(output, /\x1b\[2A/)
})

test('preclassified skips count as completed providers', () => {
  const chunks: string[] = []
  const progress = new VerifierRunProgress([
    { model: 'fable', providerCount: 3, skippedCount: 2 },
  ], {
    isTTY: true,
    columns: 160,
    write: (chunk) => chunks.push(chunk),
  })
  progress.start()
  progress.activate('fable')
  progress.recordVerdict('fable', 'SAME')
  progress.complete('fable')
  progress.finish()
  assert.match(chunks.join(''), /3\/3 OUT:0 SAME:1 DIFF:0 UNDET:0 SKIP:2 FAIL:0/)
})

test('zero-provider models render complete with nothing outstanding', () => {
  const chunks: string[] = []
  const progress = new VerifierRunProgress([
    { model: 'empty', providerCount: 0 },
  ], {
    isTTY: true,
    columns: 120,
    write: (chunk) => chunks.push(chunk),
  })
  progress.start()
  progress.complete('empty')
  progress.finish()
  assert.match(chunks.join(''), /\[████████████████\] 0\/0 OUT:0/)
})

test('non-interactive verifier progress stays silent', () => {
  const chunks: string[] = []
  const progress = new VerifierRunProgress([
    { model: 'fable', providerCount: 1 },
  ], {
    isTTY: false,
    write: (chunk) => chunks.push(chunk),
  })
  progress.start()
  progress.activate('fable')
  progress.recordVerdict('fable', 'SAME')
  progress.complete('fable')
  progress.finish()
  assert.deepEqual(chunks, [])
})

function recording(plans: ConstructorParameters<typeof VerifierRunProgress>[0], isTTY = true) {
  const chunks: string[] = []
  const progress = new VerifierRunProgress(plans, { isTTY, columns: 160, write: (chunk) => chunks.push(chunk) })
  return { chunks, progress }
}

test('setPhase shows what a model is doing until its audits start', () => {
  const { chunks, progress } = recording([{ model: 'fable', providerCount: 1 }])
  progress.start()
  progress.setPhase('fable', 'building questions')
  assert.match(chunks.join(''), /\| building questions/)
  progress.activate('fable')
  assert.match(chunks.at(-1)!, /\| running/)
})

test('updatePlan replaces a model\'s sellers and skips, and leaves other models alone', () => {
  const plans = [{ model: 'fable', providerCount: 5, skippedCount: 2 }, { model: 'opus', providerCount: 2 }]
  const { chunks, progress } = recording(plans)
  progress.start()
  progress.updatePlan('fable', 3, 1)
  progress.updatePlan('unknown', 9, 9)
  const output = chunks.join('')
  assert.match(output, /fable.* 1\/3 OUT:2 .*SKIP:1/)
  assert.match(output, /opus.* 0\/2 OUT:2 /)
  assert.equal(plans[0]!.providerCount, 5)
})

test('a line printed during a run goes above the table, which is drawn again below it', () => {
  const { chunks, progress } = recording([{ model: 'fable', providerCount: 1 }, { model: 'opus', providerCount: 1 }])
  progress.start()
  chunks.length = 0
  progress.above(() => chunks.push('log line\n'))
  assert.equal(chunks[0], '\x1b[2A\x1b[J')
  assert.equal(chunks[1], 'log line\n')
  assert.match(chunks[2]!, /fable/)
  assert.match(chunks[3]!, /opus/)
  assert.equal(chunks.length, 4)
})

test('without a live table a printed line is just printed', () => {
  const { chunks, progress } = recording([{ model: 'fable', providerCount: 1 }], false)
  progress.start()
  let printed = 0
  progress.above(() => { printed += 1 })
  assert.equal(printed, 1)
  assert.deepEqual(chunks, [])
})
