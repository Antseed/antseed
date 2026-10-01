import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 3,
  name: 'create_resource_ownership_tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS resource_owners (
        protocol TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        buyer_peer_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (protocol, resource_id)
      );

      CREATE TABLE IF NOT EXISTS resource_idempotency (
        buyer_peer_id TEXT NOT NULL,
        protocol TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        headers_json TEXT NOT NULL,
        body BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (buyer_peer_id, protocol, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_resource_owners_created ON resource_owners(created_at);
      CREATE INDEX IF NOT EXISTS idx_resource_idempotency_created ON resource_idempotency(created_at);
    `);
  },
};
