import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveNetworkLifecycleObservation } from './network-lifecycle.js';

test('structured buyer status drives runtime, DHT, and peer milestones', () => {
  assert.deepEqual(deriveNetworkLifecycleObservation({
    proxyReachable: true,
    dhtNodeCount: 8,
    peerCount: 7,
  }, 2, 12), {
    runtimeStarted: true,
    dhtRoutingNodeCount: 8,
    discoveredPeerCount: 7,
    discoveredServiceCount: 12,
  });
});

test('cached peers are only a fallback for runtimes without structured peer counts', () => {
  assert.deepEqual(deriveNetworkLifecycleObservation({
    proxyReachable: true,
    dhtNodeCount: null,
    peerCount: null,
  }, 3, 5), {
    runtimeStarted: true,
    dhtRoutingNodeCount: null,
    discoveredPeerCount: 3,
    discoveredServiceCount: 5,
  });
});

test('cached logs or peers do not imply a live runtime when status is unreachable', () => {
  assert.deepEqual(deriveNetworkLifecycleObservation(null, 9, 20), {
    runtimeStarted: false,
    dhtRoutingNodeCount: null,
    discoveredPeerCount: 0,
    discoveredServiceCount: 0,
  });
});
