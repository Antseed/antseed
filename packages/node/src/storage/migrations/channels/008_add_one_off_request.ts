import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 8,
  name: 'add_one_off_request',
  up: (db) => {
    const cols = db.pragma('table_info(payment_channels)') as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));

    if (!existing.has('one_off_request_id')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN one_off_request_id TEXT');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_channels_one_off_request
        ON payment_channels(peer_id, role, one_off_request_id)
        WHERE one_off_request_id IS NOT NULL;
    `);
  },
};
