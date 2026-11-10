import assert from 'node:assert/strict';
import test from 'node:test';
import { configFromObject } from './loader.js';
import { networkNodeOptions } from './network.js';

test('an unset network section adds nothing to the node options, so its defaults stay', () => {
  assert.deepEqual(networkNodeOptions({ bootstrapNodes: [] }), {});
  assert.deepEqual(networkNodeOptions(configFromObject({}).network), {});
});

test('network settings reach the node options, and port 0 counts as a setting', () => {
  const network = configFromObject({
    network: {
      bootstrapNodes: ['127.0.0.1:40000'],
      dhtPort: 0,
      signalingPort: 0,
      bindHost: '127.0.0.1',
      natTraversal: false,
      noOfficialBootstrap: true,
      allowPrivateIPs: true,
      dhtOperationTimeoutMs: 5000,
    },
  }).network;
  assert.deepEqual(networkNodeOptions(network), {
    dhtPort: 0,
    signalingPort: 0,
    bindHost: '127.0.0.1',
    natTraversal: false,
    noOfficialBootstrap: true,
    allowPrivateIPs: true,
    dhtOperationTimeoutMs: 5000,
  });
});

test('a port flag wins over the config, 0 included; an unparsable flag leaves the config value', () => {
  const network = { bootstrapNodes: [], dhtPort: 7000, signalingPort: 7001 };
  assert.deepEqual(networkNodeOptions(network, { dhtPort: 0, signalingPort: 7101 }), { dhtPort: 0, signalingPort: 7101 });
  assert.deepEqual(networkNodeOptions(network, { dhtPort: Number.NaN }), { dhtPort: 7000, signalingPort: 7001 });
});

test('invalid network and auth-duration settings are refused', () => {
  assert.throws(() => configFromObject({ network: { dhtPort: 70000 } }), /network\.dhtPort must be an integer in range 0-65535/);
  assert.throws(() => configFromObject({ network: { signalingPort: -1 } }), /network\.signalingPort must be an integer in range 0-65535/);
  assert.throws(() => configFromObject({ network: { bindHost: ' ' } }), /network\.bindHost must be a non-empty string/);
  assert.throws(() => configFromObject({ network: { natTraversal: 'no' } }), /network\.natTraversal must be a boolean/);
  assert.throws(() => configFromObject({ network: { noOfficialBootstrap: 1 } }), /network\.noOfficialBootstrap must be a boolean/);
  assert.throws(() => configFromObject({ network: { allowPrivateIPs: 'yes' } }), /network\.allowPrivateIPs must be a boolean/);
  assert.throws(() => configFromObject({ network: { dhtOperationTimeoutMs: 0 } }), /network\.dhtOperationTimeoutMs must be an integer >= 1/);
  assert.throws(() => configFromObject({ payments: { defaultAuthDurationSecs: 0 } }), /payments\.defaultAuthDurationSecs must be an integer >= 1/);
});
