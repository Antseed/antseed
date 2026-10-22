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
