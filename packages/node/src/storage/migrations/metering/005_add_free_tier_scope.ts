import type { Migration } from '../../migrate.js';

/**
 * Free-tier usage is counted per program: '' for the seller-wide program, or
 * the service id of a service with its own program, so models with their own
 * limits never share counters with the rest.
 */
export const migration: Migration = {
  version: 5,
  name: 'add_free_tier_scope',
  up: (db) => {
    db.exec(`
      ALTER TABLE free_tier_usage ADD COLUMN scope TEXT NOT NULL DEFAULT '';
      ALTER TABLE free_tier_position_usage ADD COLUMN scope TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_scope_buyer_timestamp
        ON free_tier_usage(scope, buyer_address, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_usage_scope_ip_timestamp
        ON free_tier_usage(scope, remote_ip, timestamp);
      CREATE INDEX IF NOT EXISTS idx_free_tier_position_usage_scope_position_timestamp
        ON free_tier_position_usage(scope, position_id, timestamp);
    `);
  },
};
