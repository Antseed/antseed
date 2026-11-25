import assert from 'node:assert/strict';
import test from 'node:test';
import { patchesComeOffAtQuit, relayTarget } from './relay-target.js';

test('a gateway on loopback gets a relay on its own port, whoever runs it', () => {
  assert.deepEqual(relayTarget('http://127.0.0.1:8379'), { port: 8379, upstreamHost: '127.0.0.1' });
  assert.deepEqual(relayTarget('http://localhost:9000'), { port: 9000, upstreamHost: '127.0.0.1' });
  assert.deepEqual(relayTarget('http://[::1]:9000'), { port: 9000, upstreamHost: '::1' });
  assert.deepEqual(relayTarget('https://localhost'), { port: 443, upstreamHost: '127.0.0.1' });
});

test('a gateway elsewhere needs no relay', () => {
  assert.equal(relayTarget('https://gateway.example.com'), null);
  assert.equal(relayTarget('http://192.168.1.5:8379'), null);
  assert.equal(relayTarget(null), null);
  assert.equal(relayTarget('not a url'), null);
});

test('patches come off at quit when nothing would answer them afterwards', () => {
  assert.equal(patchesComeOffAtQuit({ mode: 'local' }, false), true);
  assert.equal(patchesComeOffAtQuit({ mode: 'remote', remoteUrl: 'http://127.0.0.1:9000' }, true), true);
  assert.equal(patchesComeOffAtQuit({ mode: 'remote', remoteUrl: 'http://127.0.0.1:9000' }, false), false);
  assert.equal(patchesComeOffAtQuit({ mode: 'remote', remoteUrl: 'https://gateway.example.com' }, true), false);
});
