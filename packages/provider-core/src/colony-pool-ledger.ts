/**
 * Where the colony-pool provider (@antseed/provider-colony-pool) keeps its
 * worker ledger, shared with the seller dashboard's Workers panel that reads it.
 */

/** The ledger's file in the seller's data dir, unless COLONY_POOL_LEDGER_PATH moves it. */
export const COLONY_POOL_LEDGER_FILE = 'colony-pool.db';
/** Written in the data dir when COLONY_POOL_LEDGER_PATH moves the ledger: the ledger's path. */
export const COLONY_POOL_LEDGER_POINTER_FILE = 'colony-pool.ledger-path';
