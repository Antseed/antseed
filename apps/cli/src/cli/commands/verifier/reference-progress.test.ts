import assert from 'node:assert/strict'
import test from 'node:test'
import {
  estimateReferenceBuildProgress,
  formatReferenceBuildPlan,
  ReferenceBuildProgress,
} from './reference-progress.js'

test('reference build plan lists every target with its contrasts', () => {
  assert.deepEqual(formatReferenceBuildPlan([
    { model: 'claude-fable-5', contrastModels: ['kimi-k3', 'gpt-5.6-terra'] },
    {
      model: 'gpt-5.6-sol',
      contrastModels: ['glm-5.2'],
      skipReason: 'powered bank available: 100/340 probes, power 0.950',
    },
    { model: 'grok-4.5', contrastModels: [], configurationError: 'no eligible contrasts' },
  ]), [
    '- claude-fable-5: contrasts kimi-k3, gpt-5.6-terra',
    '- gpt-5.6-sol: skipped (powered bank available: 100/340 probes, power 0.950); contrasts glm-5.2',
    '- grok-4.5: configuration error: no eligible contrasts',
  ])
})

test('reference progress estimates major build stages', () => {
  const contrasts = ['first', 'second', 'third']
  assert.equal(estimateReferenceBuildProgress('generation round 1: collecting 0/100 probes', contrasts), 0.05)
  assert.equal(estimateReferenceBuildProgress('generation round 1: testing 297 new candidates for stability', contrasts), 0.25)
  assert.ok(Math.abs(estimateReferenceBuildProgress('checking contrast model second', contrasts) - 0.55) < 1e-12)
  assert.equal(estimateReferenceBuildProgress('self-testing 1-100 of 100 probes', contrasts), 0.95)
  assert.equal(estimateReferenceBuildProgress('reference size 100: power 0.900', contrasts), 0.97)
})

test('interactive reference progress renders one live row per model', () => {
  const chunks: string[] = []
  const progress = new ReferenceBuildProgress([
    { model: 'fable', contrastModels: ['contrast'] },
    { model: 'opus', contrastModels: ['contrast'] },
  ], {
    isTTY: true,
    columns: 160,
    write: (chunk) => chunks.push(chunk),
  })

  progress.start()
  progress.update('fable', 'self-testing 1-100 of 100 probes')
  progress.complete('fable', 'built: +100 probes')
  progress.complete('opus', 'failed: unavailable')
  progress.finish()

  const output = chunks.join('')
  assert.match(output, /fable \s*\[/)
  assert.match(output, /opus \s*\[/)
  assert.match(output, /self-testing 1-100 of 100 probes/)
  assert.match(output, /100% \| built: \+100 probes/)
  assert.match(output, /100% \| failed: unavailable/)
  assert.match(output, /\x1b\[2A/)
  assert.ok(output.endsWith('\n'))
})

test('interactive rows stay below a conservative width to prevent repaint duplication', () => {
  const chunks: string[] = []
  const progress = new ReferenceBuildProgress([
    { model: 'fable', contrastModels: ['contrast'] },
  ], {
    isTTY: true,
    columns: 1_000,
    write: (chunk) => chunks.push(chunk),
  })
  progress.start()
  progress.complete('fable', `failed: ${'very long provider error '.repeat(20)}`)
  progress.finish()

  const rows = chunks.join('').split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replaceAll('\r', ''))
    .filter((line) => line.includes('fable'))
  assert.ok(rows.length > 0)
  assert.equal(rows.every((line) => line.length <= 140), true)
})

test('non-interactive reference progress stays silent', () => {
  const chunks: string[] = []
  const progress = new ReferenceBuildProgress([
    { model: 'fable', contrastModels: ['contrast'] },
  ], {
    isTTY: false,
    write: (chunk) => chunks.push(chunk),
  })
  progress.start()
  progress.update('fable', 'checking contrast model contrast')
  progress.complete('fable')
  progress.finish()
  assert.deepEqual(chunks, [])
})
