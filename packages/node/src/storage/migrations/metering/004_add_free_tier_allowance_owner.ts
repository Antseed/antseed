import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 4,
  name: 'add_free_tier_allowance_owner',
  up: (db) => {
    db.exec(`
      ALTER TABLE free_tier_usage ADD COLUMN allowance_owner TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_owner_timestamp
        ON free_tier_usage(allowance_owner, timestamp);
    `);
  },
};
