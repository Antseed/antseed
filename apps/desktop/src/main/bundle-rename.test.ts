import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { legacyBundleMove, moveLegacyBundle } from './bundle-rename.js';

test('moves a pre-rename bundle to Antseed Desktop.app', () => {
  assert.deepEqual(legacyBundleMove('/Applications/AntSeed VPR.app/Contents/MacOS/AntSeed VPR', () => false), {
    from: '/Applications/AntSeed VPR.app',
    to: '/Applications/Antseed Desktop.app',
  });
  assert.equal(
    legacyBundleMove('/Users/me/Applications/Antseed AI VPN.app/Contents/MacOS/AntSeed VPR', () => false)?.to,
    '/Users/me/Applications/Antseed Desktop.app',
  );
});

test('leaves the bundle alone when it has the new name, another name, or the new name is taken', () => {
  assert.equal(legacyBundleMove('/Applications/Antseed Desktop.app/Contents/MacOS/AntSeed VPR', () => false), null);
  assert.equal(legacyBundleMove('/Applications/My Antseed.app/Contents/MacOS/Antseed Desktop', () => false), null);
  assert.equal(legacyBundleMove('/Applications/AntSeed VPR.app/Contents/MacOS/AntSeed VPR', () => true), null);
});

test('renames the bundle on disk and returns the bundle to restart from', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bundle-rename-'));
  const macos = path.join(dir, 'AntSeed VPR.app', 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  writeFileSync(path.join(macos, 'AntSeed VPR'), '');
  const lines: string[] = [];

  const restartFrom = moveLegacyBundle(path.join(macos, 'AntSeed VPR'), (line) => lines.push(line));
  assert.ok(restartFrom);

  assert.equal(restartFrom, path.join(dir, 'Antseed Desktop.app'));
  assert.ok(existsSync(path.join(restartFrom, 'Contents', 'MacOS', 'AntSeed VPR')));
  assert.ok(!existsSync(path.join(dir, 'AntSeed VPR.app')));
  assert.equal(lines.length, 1);
});
