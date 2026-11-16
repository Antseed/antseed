import type { Migration } from '../../migrate.js';
import { migration as m001 } from './001_create_tables.js';
import { migration as m002 } from './002_add_evidence_storage.js';

export const verificationMigrations: Migration[] = [m001, m002];
