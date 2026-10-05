import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, type Migration } from '../src/storage/migrate.js';
import { verificationMigrations } from '../src/storage/migrations/verification/index.js';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates schema_version table', () => {
    runMigrations(db, []);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").all();
    expect(tables).toHaveLength(1);
  });

  it('runs migrations in order', () => {
    const migrations: Migration[] = [
      { version: 2, name: 'second', up: (d) => d.exec('CREATE TABLE b (id INTEGER)') },
      { version: 1, name: 'first', up: (d) => d.exec('CREATE TABLE a (id INTEGER)') },
    ];

    runMigrations(db, migrations);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('a');
    expect(names).toContain('b');

    const versions = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all() as { version: number; name: string }[];
    expect(versions).toEqual([
      { version: 1, name: 'first' },
      { version: 2, name: 'second' },
    ]);
  });

  it('skips already-applied migrations', () => {
    const migrations: Migration[] = [
      { version: 1, name: 'create_a', up: (d) => d.exec('CREATE TABLE a (id INTEGER)') },
    ];

    runMigrations(db, migrations);
    // Run again — should not fail (table already exists, migration skipped)
    runMigrations(db, migrations);

    const versions = db.prepare('SELECT version FROM schema_version').all();
    expect(versions).toHaveLength(1);
  });

  it('applies only new migrations on subsequent runs', () => {
    const v1: Migration[] = [
      { version: 1, name: 'create_a', up: (d) => d.exec('CREATE TABLE a (id INTEGER)') },
    ];
    runMigrations(db, v1);

    const v2: Migration[] = [
      ...v1,
      { version: 2, name: 'create_b', up: (d) => d.exec('CREATE TABLE b (id INTEGER)') },
    ];
    runMigrations(db, v2);

    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[];
    expect(versions.map(v => v.version)).toEqual([1, 2]);
  });

  it('ignores duplicate version numbers', () => {
    let callCount = 0;
    const migrations: Migration[] = [
      { version: 1, name: 'first', up: (d) => { callCount++; d.exec('CREATE TABLE a (id INTEGER)'); } },
      { version: 1, name: 'second', up: (d) => { callCount++; d.exec('CREATE TABLE b (id INTEGER)'); } },
    ];

    runMigrations(db, migrations);

    expect(callCount).toBe(1);
    const versions = db.prepare('SELECT version FROM schema_version').all();
    expect(versions).toHaveLength(1);
  });

  it('rolls back failed migration without affecting others', () => {
    const migrations: Migration[] = [
      { version: 1, name: 'create_a', up: (d) => d.exec('CREATE TABLE a (id INTEGER)') },
      { version: 2, name: 'bad', up: () => { throw new Error('migration failed'); } },
    ];

    expect(() => runMigrations(db, migrations)).toThrow('migration failed');

    // Version 1 should be applied, version 2 should not
    const versions = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
    expect(versions.map(v => v.version)).toEqual([1]);
  });

  it('adds verification evidence storage without rewriting the base migration', () => {
    runMigrations(db, verificationMigrations);

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'request_costs'",
    ).get();
    expect(table).toEqual({ name: 'request_costs' });
    const versions = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all();
    expect(versions).toEqual([
      { version: 1, name: 'create_verification_tables' },
      { version: 2, name: 'add_verification_evidence_storage' },
    ]);
  });
});
