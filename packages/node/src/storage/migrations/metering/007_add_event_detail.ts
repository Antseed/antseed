import { addColumnIfMissing, type Migration } from '../../migrate.js';

/** Why a metered request failed (a short upstream error) and its cached input tokens, for the seller's request log. Older rows stay NULL. */
export const migration: Migration = {
  version: 7,
  name: 'add_event_detail',
  up: (db) => {
    // Idempotent: a seller that ran a pre-release build already has these columns under another version.
    addColumnIfMissing(db, 'metering_events', 'error', 'TEXT');
    addColumnIfMissing(db, 'metering_events', 'cached_input_tokens', 'INTEGER');
  },
};
