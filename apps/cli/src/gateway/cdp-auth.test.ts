import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import * as http from 'node:http'
import { test } from 'node:test'
import { cdpAuthorization, createCdpJwt } from './cdp-auth.js'
import { X402Facilitator, type PaymentPayload, type PaymentRequirements } from './x402.js'
import { topupConfig } from '../cli/commands/gateway/shared.js'

function decodeJwt(token: string) {
  const [header, claims, signature] = token.split('.') as [string, string, string]
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>,
    signingInput: Buffer.from(`${header}.${claims}`),
    signature: Buffer.from(signature, 'base64url'),
  }
}

test('CDP JWTs signed with an Ed25519 key verify and bind the request', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const secret = Buffer.concat([Buffer.from(jwk.d!, 'base64url'), Buffer.from(jwk.x!, 'base64url')]).toString('base64')
  const token = createCdpJwt({ keyId: 'key-1', keySecret: secret }, { method: 'POST', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/settle' }, 1_000)
  const { header, claims, signingInput, signature } = decodeJwt(token)
  assert.equal(header.alg, 'EdDSA')
  assert.equal(header.kid, 'key-1')
  assert.equal(header.typ, 'JWT')
  assert.match(String(header.nonce), /^[0-9a-f]{32}$/)
  assert.deepEqual(claims, {
    sub: 'key-1', iss: 'cdp', uris: ['POST api.cdp.coinbase.com/platform/v2/x402/settle'], iat: 1_000, nbf: 1_000, exp: 1_120,
  })
  assert.ok(verify(null, signingInput, publicKey, signature))
})

test('CDP JWTs signed with a PEM EC key use ES256', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString()
  const header = cdpAuthorization({ keyId: 'key-2', keySecret: pem }, 'https://api.cdp.coinbase.com/platform/v2/x402/verify')
  assert.match(header, /^Bearer /)
  const { header: jwtHeader, claims, signingInput, signature } = decodeJwt(header.slice('Bearer '.length))
  assert.equal(jwtHeader.alg, 'ES256')
  assert.deepEqual(claims.uris, ['POST api.cdp.coinbase.com/platform/v2/x402/verify'])
  assert.ok(verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature))
  assert.throws(() => createCdpJwt({ keyId: 'k', keySecret: 'not-a-key' }, { method: 'POST', host: 'h', path: '/p' }))
})

test('the facilitator client signs each call for its own endpoint', async () => {
  const seen: Array<{ url: string; authorization?: string }> = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization })
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url === '/x402/verify' ? { isValid: true } : { success: true, transaction: '0x1', network: 'eip155:8453', payer: '0x' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const facilitator = new X402Facilitator({ url: `http://127.0.0.1:${port}/x402/`, authorize: (url) => `Bearer for ${new URL(url).pathname}` })
    const payment = {} as PaymentPayload
    const requirements = {} as PaymentRequirements
    await facilitator.verify(payment, requirements)
    await facilitator.settle(payment, requirements)
    assert.deepEqual(seen, [
      { url: '/x402/verify', authorization: 'Bearer for /x402/verify' },
      { url: '/x402/settle', authorization: 'Bearer for /x402/settle' },
    ])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('facilitator presets resolve, and CDP requires its API key', () => {
  const saved = { id: process.env['CDP_API_KEY_ID'], secret: process.env['CDP_API_KEY_SECRET'] }
  try {
    assert.equal(topupConfig({ x402Facilitator: 'payai' })?.facilitatorUrl, 'https://facilitator.payai.network')
    assert.equal(topupConfig({}), undefined)
    delete process.env['CDP_API_KEY_ID']
    delete process.env['CDP_API_KEY_SECRET']
    assert.throws(() => topupConfig({ x402Facilitator: 'cdp' }), /CDP_API_KEY_ID/)
    process.env['CDP_API_KEY_ID'] = 'id'
    process.env['CDP_API_KEY_SECRET'] = 'secret'
    const cdp = topupConfig({ x402Facilitator: 'cdp', topupMinUsd: '3' })
    assert.equal(cdp?.facilitatorUrl, 'https://api.cdp.coinbase.com/platform/v2/x402')
    assert.deepEqual(cdp?.cdp, { keyId: 'id', keySecret: 'secret' })
    assert.equal(cdp?.minUsd, '3')
  } finally {
    if (saved.id === undefined) delete process.env['CDP_API_KEY_ID']; else process.env['CDP_API_KEY_ID'] = saved.id
    if (saved.secret === undefined) delete process.env['CDP_API_KEY_SECRET']; else process.env['CDP_API_KEY_SECRET'] = saved.secret
  }
})
