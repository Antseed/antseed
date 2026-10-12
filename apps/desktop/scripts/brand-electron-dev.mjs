#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const APP_NAME = 'Antseed AI VPN';
// Earlier branded names — migrated to APP_NAME if found.
const LEGACY_APP_NAMES = ['AntSeed VPR', 'AntSeed Desktop'];
const APP_BUNDLE_ID = 'com.antseed.desktop-dev';
const require = createRequire(import.meta.url);

function runPlistBuddy(plistPath, command) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], {
    stdio: 'ignore',
  });
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function setOrAddPlistKey(plistPath, key, value) {
  try {
    runPlistBuddy(plistPath, `Set :${key} ${quote(value)}`);
  } catch {
    runPlistBuddy(plistPath, `Add :${key} string ${quote(value)}`);
  }
}

function main() {
  if (process.platform !== 'darwin') {
    process.exit(0);
  }

  let electronPackageJson;
  try {
    electronPackageJson = require.resolve('electron/package.json', { paths: [process.cwd()] });
  } catch {
    process.exit(0);
  }

  const electronPackageDir = path.dirname(electronPackageJson);
  const distDir = path.join(electronPackageDir, 'dist');
  const brandedApp = path.join(distDir, `${APP_NAME}.app`);
  const candidates = [
    brandedApp,
    ...LEGACY_APP_NAMES.map((name) => path.join(distDir, `${name}.app`)),
    path.join(distDir, 'Electron.app'),
  ];

  // Determine which .app bundle currently exists
  const appDir = candidates.find((candidate) => existsSync(candidate)) ?? null;
  if (!appDir) {
    process.exit(0);
  }

  const plistPath = path.join(appDir, 'Contents', 'Info.plist');

  setOrAddPlistKey(plistPath, 'CFBundleName', APP_NAME);
  setOrAddPlistKey(plistPath, 'CFBundleDisplayName', APP_NAME);
  setOrAddPlistKey(plistPath, 'CFBundleIdentifier', APP_BUNDLE_ID);

  // Rename the .app bundle so macOS picks up the new name in dock / Cmd+Tab
  if (appDir !== brandedApp) {
    renameSync(appDir, brandedApp);
  }

  // Update electron's path.txt so the `electron` CLI can find the renamed binary
  const pathTxt = path.join(electronPackageDir, 'path.txt');
  writeFileSync(pathTxt, `${APP_NAME}.app/Contents/MacOS/Electron`, 'utf-8');
}

main();
