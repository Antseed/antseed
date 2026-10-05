import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 2,
  name: 'add_verification_evidence_storage',
  up: (db) => {
    const responseAuthColumns = new Set(
      (db.pragma('table_info(response_auths)') as Array<{ name: string }>).map((column) => column.name),
    );
    if (!responseAuthColumns.has('request_preimage')) {
      db.exec('ALTER TABLE response_auths ADD COLUMN request_preimage BLOB');
    }
    if (!responseAuthColumns.has('response_preimage')) {
      db.exec('ALTER TABLE response_auths ADD COLUMN response_preimage BLOB');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS request_costs (
        request_id TEXT PRIMARY KEY,
        seller_peer_id TEXT NOT NULL,
        service TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        authorized_cost_usdc TEXT NOT NULL,
        input_tokens TEXT NOT NULL,
        output_tokens TEXT NOT NULL,
        source TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_request_costs_seller ON request_costs(seller_peer_id);
      CREATE INDEX IF NOT EXISTS idx_request_costs_service ON request_costs(service);
      CREATE INDEX IF NOT EXISTS idx_request_costs_recorded ON request_costs(recorded_at);
    `);
  },
};
