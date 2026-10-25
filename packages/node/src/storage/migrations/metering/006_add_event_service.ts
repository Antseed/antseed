import { addColumnIfMissing, type Migration } from '../../migrate.js';

/** The service (model id) a metered request asked for, for the seller's request log. Older rows stay NULL. */
export const migration: Migration = {
  version: 6,
  name: 'add_event_service',
  up: (db) => {
    // Idempotent: a seller that ran a pre-release build already has the column under another version.
    addColumnIfMissing(db, 'metering_events', 'service', 'TEXT');
  },
};
