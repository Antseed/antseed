import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 7,
  name: 'add_video_usage',
  up: (db) => {
    const cols = db.pragma('table_info(payment_channel_service_totals)') as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));

    if (!existing.has('cumulative_video_generations')) {
      db.exec(
        "ALTER TABLE payment_channel_service_totals ADD COLUMN cumulative_video_generations TEXT NOT NULL DEFAULT '0'",
      );
    }
    if (!existing.has('cumulative_video_seconds')) {
      db.exec(
        "ALTER TABLE payment_channel_service_totals ADD COLUMN cumulative_video_seconds TEXT NOT NULL DEFAULT '0'",
      );
    }
  },
};
