/**
 * Replace pnpm workspace symlinks in node_modules with real copies
 * so electron-builder can pack them into the asar archive.
 *
 * Also bundles the CLI into a single self-contained file for extraResources.
 * Bundling (esbuild) instead of copying tsc output means the child process
 * has no external JS dependencies — native modules are marked external and
 * resolved via NODE_PATH pointing to app.asar.unpacked/node_modules/.
 *
 * pnpm links workspace packages as symlinks pointing outside the app
 * directory, which causes electron-builder's asar packer to fail with
 * "must be under <appDir>" errors.
 *
 * Handles both top-level packages (e.g. antseed-dashboard) and scoped
 * packages (e.g. @antseed/node).
 */

import { readdirSync, lstatSync, readlinkSync, realpathSync, rmSync, cpSync, existsSync, mkdirSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const appDir = path.resolve(__dirname, '..');
const nmDir = path.join(appDir, 'node_modules');

/** Map of workspace package names to their real source directories. */
const WORKSPACE_PACKAGES = {
  '@antseed/ants': path.resolve(appDir, '..', 'ants'),
  '@antseed/antseed-verifier': path.resolve(appDir, '..', '..', 'packages', 'antseed-verifier'),
  '@antseed/api-adapter': path.resolve(appDir, '..', '..', 'packages', 'api-adapter'),
  '@antseed/buyer-core': path.resolve(appDir, '..', '..', 'packages', 'buyer-core'),
  '@antseed/node': path.resolve(appDir, '..', '..', 'packages', 'node'),
  '@antseed/payments': path.resolve(appDir, '..', 'payments'),
  '@antseed/protocol': path.resolve(appDir, '..', '..', 'packages', 'protocol'),
  '@antseed/ui': path.resolve(appDir, '..', '..', 'packages', 'ui'),
};

function isWorkspaceSymlink(fullPath) {
  try {
    if (!lstatSync(fullPath).isSymbolicLink()) return false;
    const target = readlinkSync(fullPath);
    return !target.includes('node_modules');
  } catch {
    return false;
  }
}

function copyWorkspacePackage(linkPath, sourcePath, label) {
  console.log(`[prepare-dist] Copying workspace package: ${label} -> ${sourcePath}`);
  // force: the link may not pre-exist — @antseed/api-adapter is not a direct
  // desktop dependency, so a fresh CI install creates no node_modules entry
  // for it; the copy below materializes it for the bundled-runtime walk.
  rmSync(linkPath, { recursive: true, force: true });
  cpSync(sourcePath, linkPath, { recursive: true });

  // Remove inner node_modules — the copied package's deps are already
  // hoisted into the desktop's own node_modules by pnpm.
  const innerNm = path.join(linkPath, 'node_modules');
  if (existsSync(innerNm)) {
    rmSync(innerNm, { recursive: true });
  }
}

// --- 1. Replace workspace symlinks/stale copies with fresh copies from source ---
// Both symlinks and stale directory copies from a previous prepare-dist are handled.

for (const [pkgName, sourcePath] of Object.entries(WORKSPACE_PACKAGES)) {
  const parts = pkgName.split('/');
  const linkPath = parts.length === 2
    ? path.join(nmDir, parts[0], parts[1])
    : path.join(nmDir, parts[0]);

  // Ensure scope directory exists
  if (parts.length === 2) {
    mkdirSync(path.join(nmDir, parts[0]), { recursive: true });
  }

  copyWorkspacePackage(linkPath, sourcePath, pkgName);
}

// --- 2. Bundle CLI into a single self-contained file for extraResources ---

const cliDir = path.resolve(appDir, '..', 'cli');
const cliDestDir = path.join(appDir, 'cli-dist');
const bundleOutput = path.join(cliDestDir, 'cli', 'index.js');

if (existsSync(cliDestDir)) {
  rmSync(cliDestDir, { recursive: true });
}
mkdirSync(path.dirname(bundleOutput), { recursive: true });

console.log('[prepare-dist] Bundling CLI with esbuild...');
// Use esbuild's JS API (buildSync) rather than shelling out to its bin:
// on macOS/Linux esbuild's postinstall replaces bin/esbuild with the native
// binary, so `node bin/esbuild` fails; on Windows the bin is a shebanged JS
// file that execFileSync can't exec directly. The JS API works everywhere.
const esbuild = require('esbuild');
esbuild.buildSync({
  absWorkingDir: cliDir,
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleOutput,
  external: ['better-sqlite3', 'node-datachannel', 'koffi', 'keytar'],
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: 'const __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
  logLevel: 'info',
});

chmodSync(bundleOutput, 0o755);

// Write a package.json with "type":"commonjs" so Node treats the CJS bundle
// correctly regardless of whether the parent directory has "type":"module".
writeFileSync(
  path.join(cliDestDir, 'package.json'),
  JSON.stringify({ name: 'antseed-cli-bundled', version: '1.0.0', type: 'commonjs' }, null, 2),
);

console.log(`[prepare-dist] Bundled CLI -> ${bundleOutput}`);

// --- 3. Install Electron-compatible native module prebuilds ---
// The native modules (better-sqlite3, etc.) may have been compiled for the
// system node version, which differs from Electron's bundled node.
// prebuild-install fetches the correct prebuilt binary for Electron's ABI.

const electronPkg = JSON.parse(
  readFileSync(path.resolve(appDir, '..', '..', 'node_modules', 'electron', 'package.json'), 'utf8'),
);
const electronVersion = electronPkg.version;
const betterSqlite3Dir = path.resolve(appDir, '..', '..', 'node_modules', 'better-sqlite3');

// Honors ANTSEED_PACK_ARCH so release scripts can pack arm64 + x64 separately
// without each DMG inheriting the build host's native binary.
const targetArch = process.env.ANTSEED_PACK_ARCH || process.arch;
if (!['x64', 'arm64'].includes(targetArch)) {
  throw new Error(`[prepare-dist] Unsupported ANTSEED_PACK_ARCH=${targetArch}`);
}

const prebuildInstallEntry = createRequire(
  path.join(betterSqlite3Dir, 'package.json'),
).resolve('prebuild-install/bin.js');
console.log(`[prepare-dist] Installing better-sqlite3 prebuild for Electron ${electronVersion} (${targetArch})...`);
execFileSync(process.execPath, [
  prebuildInstallEntry,
  '--runtime', 'electron',
  '--target', electronVersion,
  '--arch', targetArch,
  '--verbose',
], { cwd: betterSqlite3Dir, stdio: 'inherit' });

if (process.platform === 'darwin') {
  const nodeFile = path.join(betterSqlite3Dir, 'build', 'Release', 'better_sqlite3.node');
  if (existsSync(nodeFile)) {
    const desc = execFileSync('file', [nodeFile], { encoding: 'utf8' });
    const expected = targetArch === 'arm64' ? 'arm64' : 'x86_64';
    if (!desc.includes(expected)) {
      throw new Error(
        `[prepare-dist] better_sqlite3.node arch mismatch — expected ${expected}, got: ${desc.trim()}`,
      );
    }
    console.log(`[prepare-dist] Verified better_sqlite3.node is ${expected}`);
  }
}

// --- 4. Bundle full transitive runtime deps of @antseed/node ---
// The desktop app must be repairable from its own bundle even on machines that
// have no Node/npm available (e.g. corp networks where npm registry SSL is
// blocked). electron-builder asarUnpack does not transparently fix fs.cp from
// the asar archive, so we materialize the dep tree as real files under
// bundled-runtime/ and ship it as extraResources.

const BUNDLED_RUNTIME_DIR = path.join(appDir, 'bundled-runtime');
const EXPLICITLY_BUNDLED_PACKAGES = new Set([
  '@antseed/antseed-verifier',
  '@antseed/router-local',
  '@antseed/router-core',
  '@antseed/node',
  '@antseed/api-adapter',
]);
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

rmSync(BUNDLED_RUNTIME_DIR, { recursive: true, force: true });
mkdirSync(BUNDLED_RUNTIME_DIR, { recursive: true });

const desktopRequire = createRequire(path.join(appDir, 'package.json'));

function findPackageDirFromRequire(req, name) {
  const lookupPaths = req.resolve.paths(name) ?? [];
  for (const dir of lookupPaths) {
    const candidate = path.join(dir, ...name.split('/'));
    const pkgJson = path.join(candidate, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJson, 'utf8'));
        if (parsed.name === name) {
          try { return realpathSync(candidate); } catch { return candidate; }
        }
      } catch {}
    }
  }

  let entry;
  try {
    entry = req.resolve(name);
  } catch {
    return null;
  }

  let cur = entry;
  for (let i = 0; i < 16; i += 1) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    const pkgJson = path.join(cur, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJson, 'utf8'));
        if (parsed.name === name) {
          try { return realpathSync(cur); } catch { return cur; }
        }
      } catch {}
    }
  }
  return null;
}

function readPackageJson(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Walk the dependency graph rooted at `parentSourceDir` and place each
// transitive dependency into `bundled-runtime/`. Resolution is done from
// each parent's own perspective (not from the desktop) so that nested
// version-pinned copies (e.g. default-gateway/node_modules/execa@7) are
// found correctly. When a package would land at the top of bundled-runtime/
// but a different version of the same name is already there, it is placed
// nested under the parent's dest dir instead — mirroring npm/pnpm's
// hoisting + nesting fallback so `import { execa } from 'execa'` resolves
// to the version each consumer was paired with at install time.
function copyDepTree(name, parentSourceDir, parentDestDir, topDestRoot, visited) {
  if (NODE_BUILTINS.has(name)) return;

  const parentRequire = createRequire(path.join(parentSourceDir, 'package.json'));
  const sourceDir = findPackageDirFromRequire(parentRequire, name);
  if (!sourceDir) {
    console.warn(`[prepare-dist] WARNING: could not resolve "${name}" from ${parentSourceDir}`);
    return;
  }

  const pkg = readPackageJson(sourceDir);
  if (!pkg || !pkg.version) {
    console.warn(`[prepare-dist] WARNING: invalid package.json at ${sourceDir}`);
    return;
  }

  // Default placement: top-level. Nest under parent only on version conflict.
  let destDir = path.join(topDestRoot, ...name.split('/'));
  if (existsSync(destDir)) {
    const existing = readPackageJson(destDir);
    if (existing && existing.version !== pkg.version) {
      destDir = path.join(parentDestDir, 'node_modules', ...name.split('/'));
    }
  }

  if (visited.has(destDir)) return;
  visited.add(destDir);

  if (!EXPLICITLY_BUNDLED_PACKAGES.has(name)) {
    mkdirSync(path.dirname(destDir), { recursive: true });
    rmSync(destDir, { recursive: true, force: true });
    // Skip the package's nested node_modules during the copy instead of
    // copying it and deleting it after: we re-place any conflicting nested
    // deps ourselves at the next recursion level, and dereference: true would
    // crash on the dangling .bin symlinks pnpm sometimes leaves in there.
    const nestedNm = path.join(sourceDir, 'node_modules');
    cpSync(sourceDir, destDir, {
      recursive: true,
      dereference: true,
      filter: (src) => src !== nestedNm,
    });
  }

  for (const depName of Object.keys(pkg.dependencies ?? {})) {
    copyDepTree(depName, sourceDir, destDir, topDestRoot, visited);
  }
}

const runtimeRoots = ['@antseed/node', '@antseed/antseed-verifier'];
const visited = new Set();
for (const packageName of runtimeRoots) {
  const packageDir = WORKSPACE_PACKAGES[packageName]
    ?? findPackageDirFromRequire(desktopRequire, packageName);
  if (!packageDir) {
    console.warn(`[prepare-dist] WARNING: could not locate ${packageName} — bundled runtime will be incomplete`);
    continue;
  }
  const pkg = readPackageJson(packageDir);
  const packageDestDir = path.join(BUNDLED_RUNTIME_DIR, ...packageName.split('/'));
  for (const depName of Object.keys(pkg?.dependencies ?? {})) {
    copyDepTree(depName, packageDir, packageDestDir, BUNDLED_RUNTIME_DIR, visited);
  }
}
console.log(`[prepare-dist] Bundled ${visited.size} runtime dep(s) for ${runtimeRoots.join(', ')} into ${BUNDLED_RUNTIME_DIR}`);

console.log('[prepare-dist] Done.');
