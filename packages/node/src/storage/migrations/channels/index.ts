import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_add_auth_sig_columns.js';
import { migration as m003 } from './003_create_service_totals.js';
import { migration as m004 } from './004_add_channel_kind.js';
import { migration as m005 } from './005_add_output_images.js';
import { migration as m006 } from './006_add_video_payments.js';

export const channelMigrations: Migration[] = [m001, m002, m003, m004, m005, m006];
