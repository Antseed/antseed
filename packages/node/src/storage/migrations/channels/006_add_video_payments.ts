import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 6,
  name: 'add_video_payments',
  up: (db) => {
    const columns = (table: string) => new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
    const channelColumns = columns('payment_channels');
    if (!channelColumns.has('payment_recovery')) db.exec('ALTER TABLE payment_channels ADD COLUMN payment_recovery TEXT');
    if (!channelColumns.has('one_off_request_id')) db.exec('ALTER TABLE payment_channels ADD COLUMN one_off_request_id TEXT');

    const totalColumns = columns('payment_channel_service_totals');
    for (const column of ['cumulative_video_generations', 'cumulative_video_seconds']) {
      if (!totalColumns.has(column)) {
        db.exec(`ALTER TABLE payment_channel_service_totals ADD COLUMN ${column} TEXT NOT NULL DEFAULT '0'`);
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_channels_one_off_request
        ON payment_channels(peer_id, role, one_off_request_id)
        WHERE one_off_request_id IS NOT NULL;
    `);
  },
};
