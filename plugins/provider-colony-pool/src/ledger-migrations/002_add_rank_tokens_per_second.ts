import { addColumnIfMissing, type Migration } from '@antseed/node';

/** Each worker's decode speed, kept with its rank. */
export const migration: Migration = {
  version: 2,
  name: 'add_rank_tokens_per_second',
  up: (db) => {
    // Ledgers written before migrations were tracked may have it already.
    addColumnIfMissing(db, 'worker_rank', 'tokens_per_second', 'REAL NOT NULL DEFAULT 0');
  },
};
