import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGatewayUrl } from './remote-url.js';

test('a pasted gateway URL becomes its origin, https by default', () => {
  assert.equal(normalizeGatewayUrl(' gateway.example.com/v1 '), 'https://gateway.example.com');
  assert.equal(normalizeGatewayUrl('https://gateway.example.com:8443/x'), 'https://gateway.example.com:8443');
});

test('http is refused outside this computer and private networks', () => {
  for (const url of ['http://gateway.example.com', 'http://8.8.8.8', 'http://10.evil.example', 'http://172.32.0.1', 'http://100.128.0.1', 'http://[2001:db8::1]']) {
    assert.throws(() => normalizeGatewayUrl(url), /Use https/, url);
  }
  for (const url of ['http://localhost:8379', 'http://127.0.0.1:8379', 'http://10.1.2.3', 'http://172.16.0.1', 'http://192.168.1.34:8379', 'http://100.101.1.2', 'http://mac.local', 'http://[::1]:8379', 'http://[fd12:3456::1]']) {
    assert.equal(normalizeGatewayUrl(url), url, url);
  }
});

test('other schemes are refused', () => {
  assert.throws(() => normalizeGatewayUrl('ftp://gateway.example.com'), /http or https/);
});
