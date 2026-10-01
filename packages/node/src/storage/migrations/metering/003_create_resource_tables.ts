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

      CREATE TABLE IF NOT EXISTS resource_charges (
        protocol TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        buyer_peer_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        service TEXT NOT NULL,
        amount TEXT NOT NULL,
        billing_usage_json TEXT NOT NULL,
        duration_seconds INTEGER,
        charged_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (protocol, resource_id)
      );

      CREATE INDEX IF NOT EXISTS idx_resource_owners_created ON resource_owners(created_at);
      CREATE INDEX IF NOT EXISTS idx_resource_idempotency_created ON resource_idempotency(created_at);
      CREATE INDEX IF NOT EXISTS idx_resource_charges_created ON resource_charges(created_at);
      CREATE INDEX IF NOT EXISTS idx_resource_charges_channel ON resource_charges(channel_id, charged_at);
    `);
  },
};
