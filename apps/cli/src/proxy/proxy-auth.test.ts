import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CLIENT_CREDENTIAL_HEADERS, isClientCredentialHeader } from './credential-headers.js'
import {
  PROXY_TOKEN_ENV,
  bearerMatches,
  isLoopbackHost,
  proxyAuthFile,
  proxyAuthHeaders,
  publishProxyToken,
  readProxyToken,
  removeProxyToken,
  validateProxyToken,
} from './proxy-auth.js'

test('client credential headers cover provider keys, cookies and proxy credentials, case-insensitively', () => {
  assert.deepEqual([...CLIENT_CREDENTIAL_HEADERS].sort(), ['api-key', 'authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-goog-api-key'])
  assert.equal(isClientCredentialHeader('Authorization'), true)
  assert.equal(isClientCredentialHeader('X-Goog-Api-Key'), true)
  assert.equal(isClientCredentialHeader('Api-Key'), true)
  // Exact names only: AntSeed's own payment header must survive.
  assert.equal(isClientCredentialHeader('x-antseed-spending-auth'), false)
  assert.equal(isClientCredentialHeader('anthropic-version'), false)
  assert.equal(isClientCredentialHeader('x-antseed-pin-peer'), false)
})

test('bearerMatches accepts only the exact bearer token', () => {
  const token = 'proxy-token-0123456789'
  assert.equal(bearerMatches(`Bearer ${token}`, token), true)
  assert.equal(bearerMatches(`bearer ${token}`, token), true)
  assert.equal(bearerMatches(`Bearer  ${token} `, token), true)
  assert.equal(bearerMatches(token, token), false)
  assert.equal(bearerMatches(`Basic ${token}`, token), false)
  assert.equal(bearerMatches(`Bearer ${token}x`, token), false)
  assert.equal(bearerMatches(`Bearer ${token.slice(0, -1)}`, token), false)
  assert.equal(bearerMatches('Bearer ', token), false)
  assert.equal(bearerMatches(undefined, token), false)
  assert.equal(bearerMatches([`Bearer ${token}`], token), false)
})

test('validateProxyToken requires 16+ printable characters', () => {
  assert.equal(validateProxyToken('0123456789abcdef'), null)
  assert.match(validateProxyToken('short') ?? '', /at least 16/)
  assert.match(validateProxyToken('has spaces in the token') ?? '', /printable/)
})

test('isLoopbackHost', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'example.com', '128.0.0.1']) {
    assert.equal(isLoopbackHost(host), false, host)
  }
})

test('proxy token file round-trips, prefers the file over the env, and only its owner removes it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-proxy-auth-'))
  const previous = process.env[PROXY_TOKEN_ENV]
  t.after(async () => {
    if (previous === undefined) delete process.env[PROXY_TOKEN_ENV]
    else process.env[PROXY_TOKEN_ENV] = previous
    await rm(dir, { recursive: true, force: true })
  })
  delete process.env[PROXY_TOKEN_ENV]
  assert.equal(readProxyToken(dir, 8377), null)
  assert.deepEqual(proxyAuthHeaders(dir, 8377), {})

  process.env[PROXY_TOKEN_ENV] = 'env-token-0123456789'
  assert.equal(readProxyToken(dir, 8377), 'env-token-0123456789')

  await publishProxyToken(dir, 8377, 'file-token-0123456789')
  assert.equal(readProxyToken(dir, 8377), 'file-token-0123456789')
  assert.deepEqual(proxyAuthHeaders(dir, 8377), { authorization: 'Bearer file-token-0123456789' })
  // A file for another port does not apply.
  assert.equal(readProxyToken(dir, 9999), 'env-token-0123456789')

  // A stale stop (different token) leaves the current daemon's file alone.
  await removeProxyToken(dir, 8377, 'older-token-0123456789')
  assert.equal(JSON.parse(await readFile(proxyAuthFile(dir, 8377), 'utf8')).token, 'file-token-0123456789')
  await removeProxyToken(dir, 8377, 'file-token-0123456789')
  assert.equal(readProxyToken(dir, 8377), 'env-token-0123456789')

  // A file whose port does not match is ignored.
  await writeFile(proxyAuthFile(dir, 8377), JSON.stringify({ port: 1, token: 'mismatch-0123456789' }))
  assert.equal(readProxyToken(dir, 8377), 'env-token-0123456789')
})
