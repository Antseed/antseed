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
  },
};
