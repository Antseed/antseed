import type { Migration } from '../../migrate.js';

/** Request logs join each event to its receipt by session and event id; this keeps that one lookup per row in long sessions. */
export const migration: Migration = {
  version: 9,
  name: 'index_receipts_by_event',
  up: (db) => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_session_event ON usage_receipts(session_id, event_id)');
  },
};
