---
name: add-migration
description: Add a new SQLite migration to the AntSeed node package. Use when adding tables, columns, or indexes to channel-store or metering databases.
---

# Add Migration

## Purpose
Create a new numbered SQLite migration file for the AntSeed node package.
Migrations live in `packages/node/src/storage/migrations/{domain}/` where domain
is `channels` (payment_channels, receipts), `metering` (events, sessions, etc.) or `verification` (response auths).

## Quick Reference
- Creates: `packages/node/src/storage/migrations/{domain}/{NNN}_{name}.ts`
- Updates: `packages/node/src/storage/migrations/{domain}/index.ts`
- Requires: domain (channels, metering or verification), migration name, SQL statements
- Test: `cd packages/node && pnpm test`

## Procedure

1. **Determine domain**: `channels`, `metering` or `verification`
2. **Find next version number**: Look at existing files in the domain directory, pick next sequential number
3. **Create migration file**: `{NNN}_{snake_case_name}.ts` exporting a `Migration` object
4. **Register in index.ts**: Import the migration and add to the array
5. **Run tests**: `cd packages/node && pnpm test`

## Migration File Template

```typescript
import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: {N},
  name: '{descriptive_name}',
  up: (db) => {
    db.exec(`
      -- SQL statements here
    `);
  },
};
```

## Index Registration

```typescript
import { migration as m{NNN} } from './{NNN}_{name}.js';

export const {domain}Migrations: Migration[] = [m001, ..., m{NNN}];
```

## Rules
- Version numbers must be sequential and unique within a domain
- Each migration runs in a transaction — if it fails, it rolls back
- Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for safety
- For ALTER TABLE, check column existence first: `db.pragma('table_info(table_name)')`
- Never modify an existing migration file — always create a new one
- Migration names should be descriptive: `add_pricing_columns`, `create_analytics_table`

## File Locations
- Runner: `packages/node/src/storage/migrate.ts`
- Channel migrations: `packages/node/src/storage/migrations/channels/`
- Metering migrations: `packages/node/src/storage/migrations/metering/`
- Tests: `packages/node/tests/migrate.test.ts`
