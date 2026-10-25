import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_create_free_tier_usage.js';
import { migration as m003 } from './003_create_resource_tables.js';
// 004 and 005 are reserved for the free-tier migrations.
import { migration as m006 } from './006_add_event_service.js';
import { migration as m007 } from './007_add_event_detail.js';

export const meteringMigrations: Migration[] = [m001, m002, m003, m006, m007];
