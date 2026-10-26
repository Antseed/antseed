import type { Migration } from '../../migrate.js';

/**
 * One row per session, numbered in insertion order by AUTOINCREMENT, so a
 * reader's "sessions since" cursor stays valid after old sessions are pruned
 * (the implicit rowid of `sessions` can be reused). Existing sessions are
 * numbered in their current order.
 */
export const migration: Migration = {
  version: 10,
  name: 'create_session_insertions',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_insertions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_insertions_started ON session_insertions(started_at);
      INSERT INTO session_insertions (session_id, started_at)
        SELECT session_id, started_at FROM sessions
        WHERE NOT EXISTS (SELECT 1 FROM session_insertions)
        ORDER BY rowid;
      CREATE TRIGGER IF NOT EXISTS trg_sessions_inserted AFTER INSERT ON sessions BEGIN
        INSERT INTO session_insertions (session_id, started_at) VALUES (NEW.session_id, NEW.started_at);
      END;
    `);
  },
};
