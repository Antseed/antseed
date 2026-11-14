import type { Migration } from '@antseed/node';

/** The pool's worker ledger: earnings, payouts, connections, dispatch outcomes and ranks. */
export const migration: Migration = {
  version: 1,
  name: 'create_tables',
  up: (db) => {
    // IF NOT EXISTS: ledgers written before migrations were tracked already hold these tables.
    db.exec(`
      CREATE TABLE IF NOT EXISTS earnings (
        request_id TEXT PRIMARY KEY,
        worker TEXT NOT NULL,
        service TEXT,
        gross_usdc INTEGER NOT NULL,
        worker_usdc INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        stream_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS earnings_worker_time ON earnings (worker, created_at);
      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker TEXT NOT NULL,
        amount_usdc INTEGER NOT NULL,
        tx_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payouts_worker ON payouts (worker);
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker TEXT NOT NULL,
        agent TEXT,
        connected_at INTEGER NOT NULL,
        disconnected_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS connections_worker ON connections (worker, connected_at);
      CREATE TABLE IF NOT EXISTS dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker TEXT NOT NULL,
        at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        reason TEXT,
        first_byte_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS dispatches_worker_time ON dispatches (worker, at);
      CREATE TABLE IF NOT EXISTS worker_rank (
        worker TEXT PRIMARY KEY,
        reliability REAL,
        first_byte_ms REAL,
        failures INTEGER NOT NULL,
        benched_until INTEGER NOT NULL,
        priority REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
};
