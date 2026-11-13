import { expect, test } from 'vitest';
import { connectionHealth } from './connection-health';

test('a reachable remote gateway reads as connected, without this machine\'s network view', () => {
  expect(connectionHealth({ mode: 'remote', reachable: true }, false, 'Down')).toEqual({ runtime: 'remote', health: 'Remote gateway', localNetwork: false });
  expect(connectionHealth({ mode: 'remote', reachable: false }, false, 'Healthy')).toEqual({ runtime: 'offline', health: 'Offline', localNetwork: false });
});

test('a local gateway is judged by its process and the network it sees', () => {
  expect(connectionHealth({ mode: 'local', reachable: true }, true, 'Healthy')).toEqual({ runtime: 'connected', health: 'Healthy', localNetwork: true });
  expect(connectionHealth({ mode: 'local', reachable: false }, false, 'Healthy')).toEqual({ runtime: 'offline', health: 'Offline', localNetwork: true });
});
