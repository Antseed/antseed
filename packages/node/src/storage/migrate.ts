import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/**
 * Run migrations on a better-sqlite3 database.
 * Tracks applied versions in a `schema_version` table.
 * Each migration runs in a transaction.
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as { version: number }[])
      .map(r => r.version),
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now());
    })();

    applied.add(migration.version);
  }
}

/**
 * `ALTER TABLE … ADD COLUMN` that is a no-op when the column is already there,
 * for migrations that may meet a database where a test build added it under
 * another version number.
 */
export function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
