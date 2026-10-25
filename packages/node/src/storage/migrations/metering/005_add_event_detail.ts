import type { Migration } from '../../migrate.js';

/** Why a metered request failed (a short upstream error) and its cached input tokens, for the seller's request log. Older rows stay NULL. */
export const migration: Migration = {
  version: 5,
  name: 'add_event_detail',
  up: (db) => {
    db.exec(`
      ALTER TABLE metering_events ADD COLUMN error TEXT;
      ALTER TABLE metering_events ADD COLUMN cached_input_tokens INTEGER;
    `);
  },
};
