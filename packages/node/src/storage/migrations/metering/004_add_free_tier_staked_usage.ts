import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 4,
  name: 'add_free_tier_staked_usage',
  up: (db) => {
    db.exec(`
      ALTER TABLE free_tier_usage ADD COLUMN staked INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS free_tier_position_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_free_tier_position_usage_position_timestamp
        ON free_tier_position_usage(position_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_position_usage_timestamp
        ON free_tier_position_usage(timestamp);
    `);
  },
};
