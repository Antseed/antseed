import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FreeTierDelegation } from '@antseed/node';
import { updateFreeTierDelegations } from './free-tier-delegations.js';

const BUYER = `0x${'11'.repeat(20)}`;
const delegation = (staker: string): FreeTierDelegation => ({ staker, buyer: BUYER, expiresAt: 4_000_000_000, signature: '0x' });

test('delegation updates keep every other setting and each other\'s changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-free-tier-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ seller: { verifiers: ['0xverifier'] }, buyer: { unknownKey: 1 } }));

    await Promise.all([
      updateFreeTierDelegations(path, (current) => [...current, delegation('0xaa')]),
      updateFreeTierDelegations(path, (current) => [...current, delegation('0xbb')]),
    ]);
    await updateFreeTierDelegations(path, (current) => current.filter((entry) => entry.staker !== '0xaa'));

    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved.seller, { verifiers: ['0xverifier'] });
    assert.equal(saved.buyer.unknownKey, 1);
    assert.deepEqual(saved.buyer.freeTierDelegations.map((entry: FreeTierDelegation) => entry.staker), ['0xbb']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
