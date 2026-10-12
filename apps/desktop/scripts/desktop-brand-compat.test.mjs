import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('visible desktop rename preserves upgrade identities', () => {
  const packageJson = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const builderConfig = parse(readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8'));
  const appContext = readFileSync(path.join(desktopDir, 'src/main/app-context.ts'), 'utf8');

  assert.equal(packageJson.productName, 'Antseed AI VPN');
  assert.equal(builderConfig.productName, 'Antseed AI VPN');
  assert.equal(builderConfig.appId, 'com.antseed.desktop');
  assert.equal(builderConfig.executableName, 'AntSeed VPR');
  assert.equal(builderConfig.publish?.owner, 'AntSeed');
  assert.match(appContext, /INTERNAL_APP_NAME = 'AntStation Desktop'/);
});
