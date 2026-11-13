import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  assessSellerPublicAddress,
  parseSellerEndpoint,
  probeTcpEndpoint,
  startupReachabilityWarning,
} from './reachability.js';

test('parseSellerEndpoint accepts hostnames, IPv4, and bracketed IPv6', () => {
  assert.deepEqual(parseSellerEndpoint('seller.example.com:6882'), { host: 'seller.example.com', port: 6882 });
  assert.deepEqual(parseSellerEndpoint('203.0.113.10:443'), { host: '203.0.113.10', port: 443 });
  assert.deepEqual(parseSellerEndpoint('[2001:db8::1]:6882'), { host: '2001:db8::1', port: 6882 });
  assert.equal(parseSellerEndpoint('seller.example.com'), null);
  assert.equal(parseSellerEndpoint('seller.example.com:0'), null);
});

test('assessSellerPublicAddress flags missing and non-public endpoints', () => {
  assert.equal(assessSellerPublicAddress('').classification, 'missing');
  assert.equal(assessSellerPublicAddress('localhost:6882').classification, 'loopback');
  assert.equal(assessSellerPublicAddress('127.0.0.1:6882').classification, 'loopback');
  assert.equal(assessSellerPublicAddress('10.0.0.5:6882').classification, 'private');
  assert.equal(assessSellerPublicAddress('100.64.0.1:6882').classification, 'private');
  assert.equal(assessSellerPublicAddress('169.254.1.2:6882').classification, 'link-local');
  assert.equal(assessSellerPublicAddress('203.0.113.10:6882').classification, 'unroutable');
  assert.equal(assessSellerPublicAddress('198.18.0.1:6882').classification, 'unroutable');
  assert.equal(assessSellerPublicAddress('198.19.255.255:6882').classification, 'unroutable');
  assert.equal(assessSellerPublicAddress('[::1]:6882').classification, 'loopback');
  assert.equal(assessSellerPublicAddress('[fd00::1]:6882').classification, 'private');
  assert.equal(assessSellerPublicAddress('[2001:db8::1]:6882').classification, 'unroutable');
});

test('assessSellerPublicAddress treats public IPs and hostnames as potentially public', () => {
  assert.equal(assessSellerPublicAddress('8.8.8.8:443').publiclyRoutable, true);
  assert.equal(assessSellerPublicAddress('seller.example.com:6882').publiclyRoutable, true);
});

test('startupReachabilityWarning includes remediation for missing addresses', () => {
  const warning = startupReachabilityWarning('');
  assert.match(warning ?? '', /WARNING/);
  assert.match(warning ?? '', /config seller set publicAddress/);
  assert.match(warning ?? '', /seller doctor/);
});

test('probeTcpEndpoint connects to a listening TCP endpoint', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const result = await probeTcpEndpoint({ host: '127.0.0.1', port: address.port }, 1_000);
    assert.equal(result.reachable, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
