import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveApiKey } from './resolve-api-key.js'

const NODE = process.execPath
const ENV = 'RESOLVE_API_KEY_TEST'

test('apiKeyCommand runs the command and returns its trimmed stdout', () => {
  const key = resolveApiKey({ apiKeyCommand: [NODE, '-e', 'process.stdout.write("  sk-from-cmd  \\n")'] })
  assert.equal(key, 'sk-from-cmd')
})

test('apiKeyCommand takes precedence over apiKeyEnv and inline apiKey', () => {
  process.env[ENV] = 'sk-from-env'
  try {
    const key = resolveApiKey({
      apiKeyCommand: [NODE, '-e', 'process.stdout.write("sk-from-cmd")'],
      apiKeyEnv: ENV,
      apiKey: 'sk-inline',
    })
    assert.equal(key, 'sk-from-cmd')
  } finally {
    delete process.env[ENV]
  }
})

test('apiKeyEnv takes precedence over inline apiKey when no command is set', () => {
  process.env[ENV] = 'sk-from-env'
  try {
    assert.equal(resolveApiKey({ apiKeyEnv: ENV, apiKey: 'sk-inline' }), 'sk-from-env')
  } finally {
    delete process.env[ENV]
  }
})

test('falls back to inline apiKey when the named env var is unset', () => {
  delete process.env[ENV]
  assert.equal(resolveApiKey({ apiKeyEnv: ENV, apiKey: 'sk-inline' }), 'sk-inline')
})

test('returns the inline apiKey when only apiKey is given', () => {
  assert.equal(resolveApiKey({ apiKey: 'sk-inline' }), 'sk-inline')
})

test('returns undefined when nothing is configured', () => {
  assert.equal(resolveApiKey({}), undefined)
})

test('throws, with the label, when the command exits non-zero', () => {
  assert.throws(
    () =>
      resolveApiKey(
        { apiKeyCommand: [NODE, '-e', 'process.stderr.write("boom"); process.exit(3)'] },
        'verifier.referenceEndpoint',
      ),
    /verifier\.referenceEndpoint: apiKeyCommand exited with 3: boom/,
  )
})

test('throws when the command produces no key on stdout', () => {
  assert.throws(
    () => resolveApiKey({ apiKeyCommand: [NODE, '-e', 'process.stdout.write("")'] }),
    /produced no key/,
  )
})
