import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_create_free_tier_usage.js';
import { migration as m003 } from './003_create_resource_tables.js';
import { migration as m004 } from './004_add_free_tier_staked_usage.js';
import { migration as m005 } from './005_add_free_tier_scope.js';
import { migration as m006 } from './006_add_event_service.js';
import { migration as m007 } from './007_add_event_detail.js';
import { migration as m008 } from './008_add_event_request_id.js';
import { migration as m009 } from './009_index_receipts_by_event.js';
import { migration as m010 } from './010_repair_free_tier_usage.js';

export const meteringMigrations: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010];
