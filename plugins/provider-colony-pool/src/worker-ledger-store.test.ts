import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerPaymentLedger } from '@antseed/node/worker-e2e';
import { fileLedgerStore } from './worker-ledger-store.js';

const channel = `0x${'ab'.repeat(32)}`;

describe('fileLedgerStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-payments-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps a worker\'s payment ledger across runs in an owner-only file', () => {
    const path = join(dir, 'nested', 'key.payments.json');
    const ledger = new WorkerPaymentLedger(fileLedgerStore(path));
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    ledger.admit(channel, 0n);
    ledger.served(channel, 9_000n);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Two answers still unpaid after a restart.
    expect(() => new WorkerPaymentLedger(fileLedgerStore(path)).admit(channel, 0n)).toThrow(/2 unpaid/);
  });
});
