import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_create_free_tier_usage.js';

export const meteringMigrations: Migration[] = [m001, m002];
