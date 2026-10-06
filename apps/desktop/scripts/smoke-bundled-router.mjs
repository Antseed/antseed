import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(appDir, 'package.json'));
const electron = require('electron');
const config = YAML.parse(readFileSync(path.join(appDir, 'electron-builder.yml'), 'utf8'));
const directory = mkdtempSync(path.join(tmpdir(), 'antseed-bundled-router-'));
try {
  let copied = 0;
  for (const resource of config.extraResources) {
    if (!resource.to?.startsWith('bundled-plugins/')) continue;
    const relative = resource.to.slice('bundled-plugins/'.length);
    const destination = path.join(directory, 'node_modules', relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.resolve(appDir, resource.from), destination, { recursive: true, dereference: true });
    copied++;
  }
  assert.ok(copied > 0);
  const output = execFileSync(electron, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import localPlugin from '@antseed/router-local';
    import { ModelRoutingClient } from '@antseed/router-core';
    import Database from 'better-sqlite3';
    const router = await localPlugin.createRouter({});
    assert.equal(typeof router.selectPeer, 'function');
    assert.equal(typeof new ModelRoutingClient().listModels, 'function');
    const database = new Database(':memory:');
    assert.equal(database.prepare('SELECT 1 AS ok').get().ok, 1);
    database.close();
    console.log('Isolated Electron runtime: bundled local router, IRP client and SQLite passed');
  `], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }, encoding: 'utf8', timeout: 30_000 });
  process.stdout.write(output);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
