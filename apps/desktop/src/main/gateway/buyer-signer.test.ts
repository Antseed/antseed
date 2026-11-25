import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { compareBuyerSigner, liveBuyerAddress } from './buyer-signer.js';

test('the buyer matches the signer only when the addresses are the same, in any case', () => {
  assert.equal(compareBuyerSigner('0xAbC', '0xabc'), 'match');
  assert.equal(compareBuyerSigner('0xabc', '0xdef'), 'mismatch');
  assert.equal(compareBuyerSigner(null, '0xabc'), 'unknown');
  assert.equal(compareBuyerSigner('0xabc', null), 'unknown');
});

test('reads the default identity from a running buyer, and null when it can\'t', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, identities: [{ name: 'other', address: '0x2' }, { name: 'default', address: '0x1' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(await liveBuyerAddress(port), '0x1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await liveBuyerAddress(port, 500), null);
});
