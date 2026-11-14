import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkerLedger } from './ledger.js';

const worker = '0x1000000000000000000000000000000000000001';

describe('WorkerLedger schema', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'worker-ledger-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('upgrades a ledger written before its schema was versioned, keeping its data', () => {
    const path = join(dir, 'ledger.db');
    // As the first ledgers were written: tables made inline, no decode speed, no schema_version.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE earnings (request_id TEXT PRIMARY KEY, worker TEXT NOT NULL, service TEXT, gross_usdc INTEGER NOT NULL,
        worker_usdc INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, stream_ms INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, amount_usdc INTEGER NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE connections (id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, agent TEXT, connected_at INTEGER NOT NULL, disconnected_at INTEGER);
      CREATE TABLE dispatches (id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, reason TEXT, first_byte_ms INTEGER);
      CREATE TABLE worker_rank (worker TEXT PRIMARY KEY, reliability REAL, first_byte_ms REAL, failures INTEGER NOT NULL,
        benched_until INTEGER NOT NULL, priority REAL NOT NULL, updated_at INTEGER NOT NULL);
    `);
    old.prepare('INSERT INTO earnings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('dispatch-1', worker, 'qwen', 1000, 900, 10, 5, null, Date.now());
    old.prepare('INSERT INTO worker_rank VALUES (?, ?, ?, ?, ?, ?, ?)').run(worker, 0.9, 120, 0, 0, 1, Date.now());
    old.close();

    const ledger = new WorkerLedger(path);
    expect(ledger.stats(worker).requestsTotal).toBe(1);
    expect(ledger.loadRank(worker)).toMatchObject({ reliability: 0.9, firstByteMs: 120, tokensPerSecond: 0 });
    ledger.saveRank(worker, { reliability: 0.95, firstByteMs: 100, failures: 0, benchedUntil: 0, tokensPerSecond: 42 }, 1);
    expect(ledger.loadRank(worker)?.tokensPerSecond).toBe(42);
    ledger.close();

    // Reopening applies nothing twice.
    const again = new WorkerLedger(path);
    expect(again.loadRank(worker)?.tokensPerSecond).toBe(42);
    again.close();
    const versions = new Database(path, { readonly: true }).prepare('SELECT version FROM schema_version ORDER BY version').all();
    expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
  });
});
