import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorkerLedgerSnapshot, WorkerLedgerStore } from '@antseed/node/worker-e2e';

/**
 * Keeps a worker's payment ledger in an owner-only JSON file, replaced whole
 * on every change so a crash leaves the previous version, never half of one.
 */
export function fileLedgerStore(path: string): WorkerLedgerStore {
  return {
    load(): WorkerLedgerSnapshot | null {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8')) as WorkerLedgerSnapshot;
    },
    save(snapshot: WorkerLedgerSnapshot): void {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const next = `${path}.next`;
      writeFileSync(next, JSON.stringify(snapshot), { mode: 0o600 });
      chmodSync(next, 0o600);
      renameSync(next, path);
    },
  };
}
