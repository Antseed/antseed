import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import afterPack from './after-pack.js';
import { selectInstallerConfig } from './dist.mjs';

const require = createRequire(import.meta.url);
const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper.js');
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Linux config separates install identity from visible branding and other platforms', async () => {
  const base = await getConfig(desktopDir, path.join(desktopDir, 'electron-builder.yml'));
  const linux = await getConfig(desktopDir, path.join(desktopDir, 'electron-builder.linux.cjs'));
  await validateConfiguration(linux, { isEnabled: false });
  assert.equal(base.productName, 'Antseed AI VPN');
  assert.equal(base.executableName, 'AntSeed VPR');
  assert.equal(linux.productName, 'antseed-ai-vpn');
  assert.equal(linux.linux.executableName, 'antseed-ai-vpn');
  assert.equal(linux.deb.packageName, 'antseed-ai-vpn');
  assert.equal(linux.linux.artifactName, 'Antseed-AI-VPN-${version}-${arch}.${ext}');
  assert.deepEqual(linux.mac, base.mac);
  assert.deepEqual(linux.win, base.win);
  assert.deepEqual(linux.linux.target, base.linux.target);
  assert.deepEqual(linux.linux.extraResources, base.linux.extraResources);
  assert.equal(linux.appId, base.appId);
  assert.deepEqual(linux.publish, base.publish);

  const helper = new LinuxTargetHelper({
    executableName: linux.linux.executableName,
    fileAssociations: [],
    config: linux,
    platformSpecificBuildOptions: linux.linux,
    appInfo: { productName: linux.productName, sanitizedProductName: linux.productName },
  });
  const desktopEntry = await helper.computeDesktopEntry(linux.linux);
  assert.match(desktopEntry, /^Name=Antseed AI VPN$/m);
  assert.match(desktopEntry, /^Exec=\/opt\/antseed-ai-vpn\/antseed-ai-vpn %U$/m);
  assert.match(desktopEntry, /^Icon=antseed-ai-vpn$/m);
  assert.match(desktopEntry, /^StartupWMClass=Antseed AI VPN$/m);
  assert.deepEqual(linux.deb.fpm, ['--before-install', path.join(desktopDir, 'scripts/linux/preinst.sh')]);
  for (const hook of [linux.deb.afterInstall, linux.deb.afterRemove, linux.deb.fpm[1]]) {
    assert.ok((await readFile(hook, 'utf8')).startsWith('#!/bin/sh\n'));
  }
});

test('Linux distribution scripts select the Linux-specific configuration', async () => {
  const { scripts } = JSON.parse(await readFile(path.join(desktopDir, 'package.json'), 'utf8'));
  for (const name of ['dist:linux', 'release:linux']) {
    assert.match(scripts[name], /electron-builder --config electron-builder\.linux\.cjs --linux/);
  }
  assert.match(scripts.dist, /node scripts\/dist\.mjs$/);
});

test('generic distribution selects the target platform without changing cross-build identities', () => {
  assert.equal(selectInstallerConfig('linux', []), 'electron-builder.linux.cjs');
  assert.equal(selectInstallerConfig('darwin', []), 'electron-builder.yml');
  assert.equal(selectInstallerConfig('win32', []), 'electron-builder.yml');
  assert.equal(selectInstallerConfig('darwin', ['--linux', 'deb', '--x64']), 'electron-builder.linux.cjs');
  assert.equal(selectInstallerConfig('linux', ['--win']), 'electron-builder.yml');
  assert.equal(selectInstallerConfig('linux', ['--win=nsis']), 'electron-builder.yml');
  assert.equal(selectInstallerConfig('darwin', ['--linux=deb']), 'electron-builder.linux.cjs');
  assert.equal(selectInstallerConfig('linux', ['--mac']), 'electron-builder.yml');
  assert.throws(() => selectInstallerConfig('linux', ['--linux', '--win']), /Build Linux separately/);
});

test('Linux afterPack sets the sandbox helper mode before archiving', { skip: process.platform === 'win32' }, async () => {
  const appOutDir = await mkdtemp(path.join(tmpdir(), 'antseed-linux-sandbox-'));
  try {
    const helper = path.join(appOutDir, 'chrome-sandbox');
    await writeFile(helper, 'sandbox fixture', { mode: 0o755 });
    await afterPack({ electronPlatformName: 'linux', appOutDir });
    assert.equal((await stat(helper)).mode & 0o7777, 0o4755);
    assert.equal(await readFile(helper, 'utf8'), 'sandbox fixture');
    await afterPack({ electronPlatformName: 'win32', appOutDir: '/missing-directory' });
    await assert.rejects(afterPack({ electronPlatformName: 'linux', appOutDir: '/missing-directory' }), { code: 'ENOENT' });
  } finally {
    await rm(appOutDir, { recursive: true, force: true });
  }
});

test('Debian maintainer hooks have valid POSIX shell syntax', { skip: process.platform === 'win32' }, () => {
  for (const hook of ['preinst', 'postinst', 'postrm']) {
    execFileSync('sh', ['-n', path.join(desktopDir, `scripts/linux/${hook}.sh`)]);
  }
});
