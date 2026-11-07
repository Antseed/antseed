import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { portInUse, restartForNewIdentity } from './restart-for-identity.js';

function ops(inUse: boolean) {
  const calls: string[] = [];
  return {
    calls,
    ops: {
      stop: async () => { calls.push('stop'); },
      start: async () => { calls.push('start'); },
      buyerPort: async () => 8377,
      portInUse: async () => inUse,
      onForeignBuyer: (port: number) => { calls.push(`foreign ${port}`); },
    },
  };
}

test('with the port free, the gateway restarts on the new identity', async () => {
  const { calls, ops: o } = ops(false);
  assert.equal(await restartForNewIdentity(o), null);
  assert.deepEqual(calls, ['stop', 'start']);
});

test('a buyer still on the port is someone else\'s: no restart, and the user is told', async () => {
  const { calls, ops: o } = ops(true);
  assert.match((await restartForNewIdentity(o))!, /still running on port 8377 with the old wallet/);
  assert.deepEqual(calls, ['stop', 'foreign 8377']);
});

test('a start that fails is reported', async () => {
  const { ops: o } = ops(false);
  await assert.rejects(restartForNewIdentity({ ...o, start: async () => { throw new Error('no gateway'); } }), /no gateway/);
});

test('portInUse sees a listener and an empty port', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  assert.equal(await portInUse(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portInUse(port), false);
});
