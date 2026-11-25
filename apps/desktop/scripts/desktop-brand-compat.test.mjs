import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the Antseed Desktop rename keeps the update identity', () => {
  const packageJson = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const builderConfig = parse(readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8'));
  const appContext = readFileSync(path.join(desktopDir, 'src/main/app-context.ts'), 'utf8');

  assert.equal(packageJson.productName, 'Antseed Desktop');
  assert.equal(builderConfig.productName, 'Antseed Desktop');
  assert.equal(builderConfig.executableName, 'Antseed Desktop');
  // appId and the release repo are what electron-updater and the OS tie an
  // install to; they never change with the name.
  assert.equal(builderConfig.appId, 'com.antseed.desktop');
  assert.equal(builderConfig.publish?.owner, 'AntSeed');
  // The runtime name moved too; the legacy one stays known so the first launch
  // can migrate the safeStorage key and userData folder (app-rename.ts).
  assert.match(appContext, /export const INTERNAL_APP_NAME = [^\n]*'Antseed Desktop'/);
  assert.match(appContext, /LEGACY_INTERNAL_APP_NAME = 'AntStation Desktop'/);
});
