import { addColumnIfMissing, type Migration } from '../../migrate.js';

/** The protocol request id of a metered request, which links it to a one-off payment channel. Older rows stay NULL. */
export const migration: Migration = {
  version: 8,
  name: 'add_event_request_id',
  up: (db) => {
    addColumnIfMissing(db, 'metering_events', 'request_id', 'TEXT');
  },
};
