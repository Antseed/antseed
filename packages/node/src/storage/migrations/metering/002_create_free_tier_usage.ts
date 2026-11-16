import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 2,
  name: 'create_free_tier_usage',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS free_tier_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        buyer_address TEXT NOT NULL,
        remote_ip TEXT NOT NULL DEFAULT '',
        service TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_buyer_timestamp
        ON free_tier_usage(buyer_address, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_ip_timestamp
        ON free_tier_usage(remote_ip, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_timestamp
        ON free_tier_usage(timestamp);
    `);
  },
};
