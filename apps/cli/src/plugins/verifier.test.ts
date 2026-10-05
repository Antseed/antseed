import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVerifierCapabilities, normalizeVerifierIds, parseVerifierCapabilities, resolveVerifierPolicy, selectVerifier, verifierSupportFingerprint, withVerifyTimeout } from './verifier.js'

const TEE = 'antseed-verifier'

test('buildVerifierCapabilities: first id is the default; dot-separated (PEER_CAPABILITY_PATTERN-safe)', () => {
  assert.deepEqual(buildVerifierCapabilities([TEE, 'acme-x']), [
    'verifier.antseed-verifier',
    'verifier-default.antseed-verifier',
    'verifier.acme-x',
  ])
})

test('parseVerifierCapabilities: round-trips + ignores unrelated caps', () => {
  const caps = buildVerifierCapabilities([TEE, 'acme-x'])
  assert.deepEqual(parseVerifierCapabilities([...caps, 'verification.response-auth.v1']), {
    supported: [TEE, 'acme-x'],
    default: TEE,
  })
  assert.deepEqual(parseVerifierCapabilities(['verification.response-auth.v1']), { supported: [] })
})

test('parseVerifierCapabilities: ignores malformed verifier ids', () => {
  assert.deepEqual(
    parseVerifierCapabilities([
      'verifier.@scope/pkg',
      'verifier-default.has space',
      'verifier.good-id',
    ]),
    { supported: ['good-id'] },
  )
})

test('selectVerifier: prefers requested trusted SDKs, otherwise trusted seller default', () => {
  assert.equal(
    selectVerifier({ require: false, prefer: ['nope-x', TEE, 'acme-x'] }, { supported: ['acme-x', TEE], default: 'acme-x' }),
    TEE,
  )
  assert.equal(selectVerifier({ require: false }, { supported: [TEE], default: TEE }), TEE)
  assert.equal(selectVerifier({ require: false }, { supported: ['acme-untrusted'], default: 'acme-untrusted' }), null)
  assert.equal(selectVerifier({ require: false, prefer: ['nope-x'] }, { supported: [TEE], default: TEE }), null)
})

test('normalizeVerifierIds: lowercases/dedupes/drops-blanks and rejects invalid chars', () => {
  assert.deepEqual(
    normalizeVerifierIds(' Antseed-Verifier , acme-x , antseed-verifier , '),
    ['antseed-verifier', 'acme-x'],
  )
  for (const bad of ['@scope/pkg', 'has space', 'up/slash']) {
    assert.throws(() => normalizeVerifierIds(bad), /invalid verifier id/)
  }
})

test('resolveVerifierPolicy: resolves valid flags and rejects contradictions', () => {
  assert.equal(resolveVerifierPolicy({ verifier: false }), undefined)
  assert.deepEqual(resolveVerifierPolicy({ verifiers: `${TEE},acme-x`, requireVerifier: true }), {
    prefer: [TEE, 'acme-x'],
    require: true,
  })
  assert.deepEqual(resolveVerifierPolicy({}), { prefer: [], require: false })
  assert.throws(() => resolveVerifierPolicy({ verifier: false, requireVerifier: true }), /cannot be combined/)
  assert.throws(() => resolveVerifierPolicy({ verifier: false, verifiers: TEE }), /cannot be combined/)
})

test('withVerifyTimeout: resolves in time, times out, and surfaces an outer abort', async () => {
  assert.equal(await withVerifyTimeout(async () => 'ok', undefined, 1000), 'ok')
  await assert.rejects(withVerifyTimeout(() => new Promise(() => {}), undefined, 10), /timed out/)
  const ac = new AbortController()
  ac.abort(new Error('client disconnected'))
  await assert.rejects(withVerifyTimeout(() => new Promise(() => {}), ac.signal, 1000), /client disconnected/)
})

test('verifierSupportFingerprint: changes when advertised verifiers change (cache invalidation)', () => {
  const a = verifierSupportFingerprint(['verifier.antseed-verifier', 'verifier-default.antseed-verifier'])
  const b = verifierSupportFingerprint(['verifier.acme-x'])
  assert.notEqual(a, b)
  assert.equal(a, verifierSupportFingerprint(['verifier-default.antseed-verifier', 'verifier.antseed-verifier']))
})
