import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrateRetiredApps, retiredMigrationStore } from './retired-migration.js';

test('a retired app whose cleanup fails is retried at the next launch, then left alone', () => {
  const store = retiredMigrationStore(path.join(mkdtempSync(path.join(tmpdir(), 'retired-')), 'retired.json'));
  let writable = false;
  const cleaned: string[] = [];
  const run = () => migrateRetiredApps({
    store,
    firstLaunchNames: () => ['claude-code'],
    cleanUp: (name) => {
      if (!writable) throw new Error('EACCES');
      cleaned.push(name);
    },
  });

  assert.deepEqual(run(), ['claude-code']);
  writable = true;
  assert.deepEqual(run(), []);
  assert.deepEqual(cleaned, ['claude-code']);
  // Done: a later `antseed apps connect` isn't undone by opening the app.
  assert.deepEqual(run(), []);
  assert.deepEqual(cleaned, ['claude-code']);
});
