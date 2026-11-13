import type { Migration } from '../../migrate.js';

/** Speech `input` characters per service, signed in SpendingAuth metadata v5. */
export const migration: Migration = {
  version: 7,
  name: 'add_input_characters',
  up: (db) => {
    const cols = db.pragma('table_info(payment_channel_service_totals)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cumulative_input_characters')) {
      db.exec(
        "ALTER TABLE payment_channel_service_totals ADD COLUMN cumulative_input_characters TEXT NOT NULL DEFAULT '0'",
      );
    }
  },
};
