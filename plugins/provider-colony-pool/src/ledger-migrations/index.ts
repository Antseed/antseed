import type { Migration } from '@antseed/node';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_add_rank_tokens_per_second.js';

/** The worker ledger's schema, applied in order by runMigrations. */
export const ledgerMigrations: Migration[] = [m001, m002];
