import { addColumnIfMissing, type Migration } from '../../migrate.js';

/**
 * The chain's record of each channel, kept apart from `status`. `status` says
 * whether the buyer still uses the session; a session it gave up on can still
 * be an open channel holding a reserve. These columns hold what AntseedChannels
 * said (`channels(id)`), the block that read was taken at and when, so every
 * reader shares one answer that survives a restart. Null: never read.
 *
 * `chain_backfill` marks rows already retired when these columns arrived.
 * They have never been read; until they are, they count nothing, as they did
 * before (a session that ran out of reserve is retired with no settled
 * amount, so counting them would add up the buyer's lifetime spend).
 *
 * `chain_final` marks rows the chain can no longer change for the buyer
 * (settled, timed out, or nothing left that can land). They count nothing and
 * are never read again, so the figures and the reads skip them through the
 * index, however long the buyer's history.
 */
export const migration: Migration = {
  version: 9,
  name: 'add_chain_record',
  up: (db) => {
    addColumnIfMissing(db, 'payment_channels', 'chain_status', 'INTEGER');
    addColumnIfMissing(db, 'payment_channels', 'chain_deposit', 'TEXT');
    addColumnIfMissing(db, 'payment_channels', 'chain_settled', 'TEXT');
    addColumnIfMissing(db, 'payment_channels', 'chain_close_requested_at', 'INTEGER');
    addColumnIfMissing(db, 'payment_channels', 'chain_block', 'INTEGER');
    addColumnIfMissing(db, 'payment_channels', 'chain_read_at', 'INTEGER');
    addColumnIfMissing(db, 'payment_channels', 'chain_backfill', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'payment_channels', 'chain_final', 'INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE payment_channels SET chain_backfill = 1 WHERE status <> 'active'");
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_channels_role_buyer_chain_final ON payment_channels(role, buyer_evm_addr, chain_final)',
    );
  },
};
