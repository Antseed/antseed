import type { Migration } from '../../migrate.js';

/**
 * Channels whose end the seller still has to act on (a colony pool releases
 * what it held for them): a row stays until that succeeds, so a failed attempt
 * is tried again, also after a restart.
 */
export const migration: Migration = {
  version: 9,
  name: 'create_ended_channel_notices',
  up: (db) => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS ended_channel_notices (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)',
    );
  },
};
