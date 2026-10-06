import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeMacUpdateChannel, prepareMacReleaseArtifacts } from './mac-update-channel.mjs';

const x64Zip = { url: 'Antseed-AI VPN-0.2.31-mac.zip', sha512: 'x64-zip' };
const arm64Zip = { url: 'Antseed-AI VPN-0.2.31-arm64-mac.zip', sha512: 'arm64-zip' };
const x64Dmg = { url: 'Antseed-AI VPN-0.2.31.dmg', sha512: 'x64-dmg' };
const arm64Dmg = { url: 'Antseed-AI VPN-0.2.31-arm64.dmg', sha512: 'arm64-dmg' };

test('normalizes the mac update channel before publishing', () => {
  const channel = normalizeMacUpdateChannel({
    version: '0.2.31',
    files: [arm64Zip, x64Dmg, arm64Dmg, x64Zip],
    path: arm64Zip.url,
    sha512: arm64Zip.sha512,
  });

  assert.deepEqual(channel.files, [x64Zip, arm64Zip, x64Dmg, arm64Dmg]);
  assert.equal(channel.path, x64Zip.url);
  assert.equal(channel.sha512, x64Zip.sha512);
});

test('rejects a channel missing either architecture', () => {
  assert.throws(
    () => normalizeMacUpdateChannel({ files: [x64Zip, x64Dmg] }),
    /arm64 zip, arm64 dmg/,
  );
});

test('renames artifacts to channel URLs and excludes builder metadata', () => {
  const releaseDir = mkdtempSync(path.join(tmpdir(), 'antseed-mac-release-'));
  try {
    // electron-builder writes dmg/zip with its own naming (spaces preserved
    // in some configs); prepareMacReleaseArtifacts must rename them to the
    // canonical channel URLs above.
    const localNames = [
      'Antseed AI VPN-0.2.31-mac.zip',
      'Antseed AI VPN-0.2.31-arm64-mac.zip',
      'Antseed AI VPN-0.2.31.dmg',
      'Antseed AI VPN-0.2.31-arm64.dmg',
    ];
    for (const name of localNames) {
      writeFileSync(path.join(releaseDir, name), name);
      writeFileSync(path.join(releaseDir, `${name}.blockmap`), `${name}.blockmap`);
    }
    writeFileSync(path.join(releaseDir, 'builder-debug.yml'), 'internal: true\n');
    const channelPath = path.join(releaseDir, 'latest-mac.yml');
    writeFileSync(channelPath, JSON.stringify({
      version: '0.2.31',
      files: [arm64Zip, x64Dmg, arm64Dmg, x64Zip],
      path: arm64Zip.url,
      sha512: arm64Zip.sha512,
      releaseDate: '2026-08-26T15:24:04.619Z',
    }));

    const { artifacts } = prepareMacReleaseArtifacts(releaseDir, channelPath);
    // releaseDate must stay a quoted string — emitted plain, js-yaml's default
    // schema on the updater side resolves an ISO timestamp to a Date object.
    assert.match(readFileSync(channelPath, 'utf8'), /releaseDate: '2026-08-26T15:24:04\.619Z'/);
    assert.deepEqual(artifacts.map((artifact) => path.basename(artifact)), [
      'latest-mac.yml',
      x64Zip.url,
      `${x64Zip.url}.blockmap`,
      arm64Zip.url,
      `${arm64Zip.url}.blockmap`,
      x64Dmg.url,
      `${x64Dmg.url}.blockmap`,
      arm64Dmg.url,
      `${arm64Dmg.url}.blockmap`,
    ]);
    assert.ok(readdirSync(releaseDir).includes('builder-debug.yml'));
    assert.ok(!artifacts.some((artifact) => artifact.endsWith('builder-debug.yml')));
    assert.ok(!readdirSync(releaseDir).some((name) => name.startsWith('Antseed AI VPN-')));
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
});
