import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_create_free_tier_usage.js';
import { migration as m003 } from './003_create_resource_tables.js';
import { migration as m004 } from './004_add_event_service.js';
import { migration as m005 } from './005_add_event_detail.js';

export const meteringMigrations: Migration[] = [m001, m002, m003, m004, m005];
