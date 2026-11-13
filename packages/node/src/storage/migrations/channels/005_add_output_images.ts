import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 5,
  name: 'add_output_images',
  up: (db) => {
    const cols = db.pragma('table_info(payment_channel_service_totals)') as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));

    if (!existing.has('cumulative_output_images')) {
      db.exec(
        "ALTER TABLE payment_channel_service_totals ADD COLUMN cumulative_output_images TEXT NOT NULL DEFAULT '0'",
      );
    }
  },
};
