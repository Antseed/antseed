import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyNetworkError } from './utils.js';

test('friendlyNetworkError hides raw RPC trouble behind a short retry hint', () => {
  const busy = 'The network is busy right now. Try again in a minute.';
  assert.equal(friendlyNetworkError(new Error('http://127.0.0.1:8547 is rate limiting requests')), busy);
  assert.equal(friendlyNetworkError(new Error('Every RPC endpoint is rate limiting requests')), busy);
  assert.equal(friendlyNetworkError(new Error('request timeout (code=TIMEOUT, version=6.16.0)')), busy);
  assert.equal(friendlyNetworkError(new Error('getaddrinfo ENOTFOUND antscan.co')), busy);
  assert.equal(friendlyNetworkError(new Error('HTTP 429 Too Many Requests')), busy);
});

test('friendlyNetworkError keeps other messages', () => {
  assert.equal(friendlyNetworkError(new Error('Invites unlock after at least 1 USDC of usage or sales in the previous week.')), 'Invites unlock after at least 1 USDC of usage or sales in the previous week.');
  assert.equal(friendlyNetworkError('This invite was already used.'), 'This invite was already used.');
  assert.equal(friendlyNetworkError(null), 'Unexpected error');
});
