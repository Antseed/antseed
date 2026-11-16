import type { Migration } from '../../migrate.js';

/**
 * An ended-channel notice names the AntseedChannels contract its channel was
 * on (the registry may point at another by the time the notice is handled),
 * and keeps its retry state, so the notices due next are read directly however
 * many others are still waiting out a failed attempt.
 */
export const migration: Migration = {
  version: 10,
  name: 'add_ended_notice_retry_columns',
  up: (db) => {
    db.exec('ALTER TABLE ended_channel_notices ADD COLUMN channels_address TEXT');
    db.exec('ALTER TABLE ended_channel_notices ADD COLUMN failures INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE ended_channel_notices ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ended_channel_notices_due ON ended_channel_notices (not_before, created_at)',
    );
  },
};
