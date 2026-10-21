import assert from 'node:assert/strict'
import test from 'node:test'
import { isBrowserContextHeader, isLocalOrigin, isLoopbackHost, nonLocalRequestReason } from './local-request-guard.js'

test('loopback hosts are accepted with or without a port', () => {
  for (const host of ['localhost', 'localhost:8377', 'LOCALHOST:8377', 'app.localhost:5173',
    '127.0.0.1', '127.0.0.1:8377', '127.1.2.3:80', '[::1]', '[::1]:8377']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
})

test('non-loopback and malformed hosts are refused', () => {
  for (const host of ['evil.example', 'evil.example:8377', 'localhost.evil.example', '127.0.0.1.evil.example',
    '0.0.0.0:8377', '10.0.0.1', '[::2]:8377', '[::1]x', 'localhost:abc', 'localhost:1:2', '', ':8377']) {
    assert.equal(isLoopbackHost(host), false, host)
  }
})

test('only loopback http(s) pages and local files are local origins', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8377', 'https://localhost', 'http://[::1]:3000', 'file://']) {
    assert.equal(isLocalOrigin(origin), true, origin)
  }
  for (const origin of ['null', 'https://evil.example', 'http://localhost.evil.example', 'chrome-extension://abc', 'not a url']) {
    assert.equal(isLocalOrigin(origin), false, origin)
  }
})

test('CLI tools and SDKs (loopback Host, no Origin) pass', () => {
  assert.equal(nonLocalRequestReason({ host: '127.0.0.1:8377' }), null)
  assert.equal(nonLocalRequestReason({ host: 'localhost:8377', 'sec-fetch-site': 'none' }), null)
  assert.equal(nonLocalRequestReason({}), null)
})

test('IP-literal hosts pass (no name to rebind), e.g. the WSL relay via the gateway IP', () => {
  assert.equal(nonLocalRequestReason({ host: '172.24.0.1:8377' }), null)
  assert.equal(nonLocalRequestReason({ host: '[fe80::1]:8377' }), null)
  assert.match(nonLocalRequestReason({ host: '172.24.0.1:8377', origin: 'http://172.24.0.1:8377' }) ?? '', /Origin/)
})

test('front doors drop exactly the browser page headers', () => {
  for (const name of ['Origin', 'referer', 'Sec-Fetch-Site', 'sec-fetch-mode', 'sec-fetch-dest']) assert.equal(isBrowserContextHeader(name), true, name)
  for (const name of ['content-type', 'accept', 'user-agent', 'x-antseed-pin-peer']) assert.equal(isBrowserContextHeader(name), false, name)
})

test('a page on a rebound hostname is refused by its Host', () => {
  assert.match(nonLocalRequestReason({ host: 'rebind.example:8377', origin: 'http://rebind.example:8377', 'sec-fetch-site': 'same-origin' }) ?? '', /Host/)
})

test('cross-site browser requests are refused, local pages are not', () => {
  assert.match(nonLocalRequestReason({ host: '127.0.0.1:8377', origin: 'https://evil.example' }) ?? '', /Origin/)
  assert.match(nonLocalRequestReason({ host: '127.0.0.1:8377', origin: 'null' }) ?? '', /Origin/)
  // no-cors GETs carry no Origin.
  assert.match(nonLocalRequestReason({ host: '127.0.0.1:8377', 'sec-fetch-site': 'cross-site' }) ?? '', /cross-site/)
  assert.equal(nonLocalRequestReason({ host: '127.0.0.1:8377', origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' }), null)
  assert.equal(nonLocalRequestReason({ host: '127.0.0.1:8377', origin: 'file://' }), null)
})
