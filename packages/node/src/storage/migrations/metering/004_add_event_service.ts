import type { Migration } from '../../migrate.js';

/** The service (model id) a metered request asked for, for the seller's request log. Older rows stay NULL. */
export const migration: Migration = {
  version: 4,
  name: 'add_event_service',
  up: (db) => {
    db.exec(`ALTER TABLE metering_events ADD COLUMN service TEXT`);
  },
};
