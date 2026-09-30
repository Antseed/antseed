import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 6,
  name: 'add_payment_recovery',
  up: (db) => {
    const columns = db.pragma('table_info(payment_channels)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'payment_recovery')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN payment_recovery TEXT');
    }
  },
};
