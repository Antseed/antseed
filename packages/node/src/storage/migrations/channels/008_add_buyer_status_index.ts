import type { Migration } from '../../migrate.js';

/**
 * A buyer's channels by status. Routing reads a buyer's active channels on
 * every request; without this index each read scanned the whole table, which
 * grows with every channel the buyer ever closed.
 */
export const migration: Migration = {
  version: 8,
  name: 'add_buyer_status_index',
  up: (db) => {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_channels_role_buyer_status ON payment_channels(role, buyer_evm_addr, status)',
    );
  },
};
