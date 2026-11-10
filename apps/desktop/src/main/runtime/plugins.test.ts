import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The plugins dir is derived from the home directory when the module loads,
// and the bundle from Electron's resourcesPath. Point both at temp dirs
// before importing it. node --test runs each file in its own process.
const tempRoot = mkdtempSync(path.join(tmpdir(), 'antseed-desktop-plugins-'));
const homeDir = path.join(tempRoot, 'home');
const resourcesDir = path.join(tempRoot, 'resources');
process.env['HOME'] = homeDir;
process.env['USERPROFILE'] = homeDir;
Object.defineProperty(process, 'resourcesPath', { value: resourcesDir, configurable: true });

const { installPluginFromBundle } = await import('./plugins.js');

const pluginsDir = path.join(homeDir, '.antseed', 'plugins');
const bundleRoot = path.join(resourcesDir, 'bundled-plugins');
mkdirSync(pluginsDir, { recursive: true });

after(() => rmSync(tempRoot, { recursive: true, force: true }));

function writePackage(dir: string, name: string, version: string, extraFiles: string[] = []): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(path.join(dir, 'dist', 'index.js'), 'export default {};\n');
  for (const file of extraFiles) writeFileSync(path.join(dir, file), '');
}

function installedVersion(packageName: string): string | undefined {
  const manifest = path.join(pluginsDir, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!existsSync(manifest)) return undefined;
  return (JSON.parse(readFileSync(manifest, 'utf-8')) as { version?: string }).version;
}

test('installing the bundled router keeps plugins the bundle does not ship', async () => {
  // The CLI installs its plugins into the same shared directory.
  writeFileSync(
    path.join(pluginsDir, 'package.json'),
    JSON.stringify({ name: 'antseed-plugins', version: '1.0.0', private: true, dependencies: { '@antseed/provider-openai': '^1.0.0' } }),
  );
  writePackage(path.join(pluginsDir, 'node_modules', '@antseed', 'provider-openai'), '@antseed/provider-openai', '1.4.0');
  writePackage(path.join(pluginsDir, 'node_modules', 'openai'), 'openai', '4.0.0');
  // An older router copied by a previous desktop version, with a file the new one no longer has.
  writePackage(path.join(pluginsDir, 'node_modules', '@antseed', 'router-local'), '@antseed/router-local', '1.0.0', ['stale.js']);
  writeFileSync(path.join(pluginsDir, 'package-lock.json'), '{}');
  writeFileSync(path.join(pluginsDir, 'node_modules', '.package-lock.json'), '{}');

  writePackage(path.join(bundleRoot, '@antseed', 'router-local'), '@antseed/router-local', '2.0.0');

  assert.equal(await installPluginFromBundle('@antseed/router-local'), true);

  // Packages the bundle ships are replaced whole, so no stale files survive.
  assert.equal(installedVersion('@antseed/router-local'), '2.0.0');
  assert.equal(existsSync(path.join(pluginsDir, 'node_modules', '@antseed', 'router-local', 'stale.js')), false);
  // Lockfiles that describe the old tree are dropped.
  assert.equal(existsSync(path.join(pluginsDir, 'package-lock.json')), false);
  assert.equal(existsSync(path.join(pluginsDir, 'node_modules', '.package-lock.json')), false);
  // Packages the CLI installed are kept.
  assert.equal(installedVersion('@antseed/provider-openai'), '1.4.0');
  assert.equal(installedVersion('openai'), '4.0.0');
});
