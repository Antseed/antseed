import { addColumnIfMissing, type Migration } from '../../migrate.js';

/**
 * Re-applies 004 and 005, which a database migrated by a pre-release seller
 * build may have recorded as done under the same version numbers without
 * running them. Every step is a no-op where they already ran.
 */
export const migration: Migration = {
  version: 10,
  name: 'repair_free_tier_usage',
  up: (db) => {
    addColumnIfMissing(db, 'free_tier_usage', 'staked', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'free_tier_usage', 'scope', "TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE TABLE IF NOT EXISTS free_tier_position_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
    addColumnIfMissing(db, 'free_tier_position_usage', 'scope', "TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_free_tier_position_usage_position_timestamp
        ON free_tier_position_usage(position_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_position_usage_timestamp
        ON free_tier_position_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_scope_buyer_timestamp
        ON free_tier_usage(scope, buyer_address, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_scope_ip_timestamp
        ON free_tier_usage(scope, remote_ip, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_position_usage_scope_position_timestamp
        ON free_tier_position_usage(scope, position_id, timestamp);
    `);
  },
};
